// ABD, transcribed from Attiya, Bar-Noy and Dolev, "Sharing Memory
// Robustly in Message-Passing Systems" (1995). Read ABD.md before changing
// a handler. Every protocol rule below names the corresponding ABD.md rule.

import type { Ctx, Message, NodeId, Process } from 'moirae-core';
import type {
  ABDMessage,
  ReadPhase1Query,
  ReadPhase1Response,
  ReadPhase2Ack,
  ReadPhase2WriteBack,
  WriteAck,
  WriteRequest,
} from './messages';
import {
  INITIAL_TAG,
  SINGLE_WRITER_ID,
  quorumSize,
  type ABDState,
  type PendingRead,
  type RegisterValue,
  type Tag,
} from './state';

export class ABD implements Process<ABDState> {
  // ABD.md §8 — the register, single-writer counter, and operation-id
  // allocator are durable protocol metadata. In-flight bookkeeping is volatile.
  // The allocator is durable because delayed messages can outlive a restart.
  readonly persistent = ['register', 'writeCounter', 'nextOperationId'] as const;

  init(): ABDState {
    return {
      register: { tag: INITIAL_TAG, value: '' },
      writeCounter: 0,
      nextOperationId: 1,
      pendingReads: [],
      pendingWrite: null,
    };
  }

  onMessage(ctx: Ctx<ABDState>, from: NodeId, msg: Message): void {
    const m = msg as ABDMessage;
    switch (m.type) {
      case 'ReadPhase1Query': this.onReadPhase1Query(ctx, from, m); break;
      case 'ReadPhase1Response': this.onReadPhase1Response(ctx, from, m); break;
      case 'ReadPhase2WriteBack': this.onReadPhase2WriteBack(ctx, from, m); break;
      case 'ReadPhase2Ack': this.onReadPhase2Ack(ctx, from, m); break;
      case 'WriteRequest': this.onWriteRequest(ctx, from, m); break;
      case 'WriteAck': this.onWriteAck(ctx, from, m); break;
    }
  }

  onTimer(): void {}

  write(ctx: Ctx<ABDState>, value: string): boolean {
    if (ctx.me !== SINGLE_WRITER_ID || ctx.state.pendingWrite !== null) return false;
    ctx.state.writeCounter += 1;
    const registerValue: RegisterValue = {
      tag: { counter: ctx.state.writeCounter, writerId: ctx.me }, value,
    };
    const operationId = this.nextOperationId(ctx);
    ctx.log('write-start', { operationId, tag: registerValue.tag });
    ctx.state.pendingWrite = { operationId, value: registerValue, acknowledgements: [ctx.me] };
    this.applyRegister(ctx, registerValue);
    for (const peer of ctx.peers) ctx.send(peer, { type: 'WriteRequest', operationId, value: registerValue });
    this.maybeCompleteWrite(ctx);
    return true;
  }

  read(ctx: Ctx<ABDState>): boolean {
    const operationId = this.nextOperationId(ctx);
    ctx.log('read-start', { operationId });
    ctx.state.pendingReads.push({ operationId, responses: {}, selected: null, writeBackAcks: [], phase: 'query' });
    this.recordReadResponse(ctx, ctx.me, operationId, ctx.state.register);
    for (const peer of ctx.peers) ctx.send(peer, { type: 'ReadPhase1Query', operationId });
    return true;
  }

  private onReadPhase1Query(ctx: Ctx<ABDState>, from: NodeId, msg: ReadPhase1Query): void {
    ctx.send(from, { type: 'ReadPhase1Response', operationId: msg.operationId, value: ctx.state.register });
  }

  private onReadPhase1Response(ctx: Ctx<ABDState>, from: NodeId, msg: ReadPhase1Response): void {
    this.recordReadResponse(ctx, from, msg.operationId, msg.value);
  }

  private recordReadResponse(ctx: Ctx<ABDState>, from: NodeId, operationId: string, value: RegisterValue): void {
    const pending = this.pendingRead(ctx, operationId);
    if (pending === undefined || pending.phase !== 'query') return;
    const key = String(from);
    if (pending.responses[key] !== undefined) return;
    pending.responses[key] = value;
    if (Object.keys(pending.responses).length < quorumSize(ctx.peers.length + 1)) return;
    let selected: RegisterValue | undefined;
    for (const candidate of Object.values(pending.responses)) {
      if (selected === undefined || compareTags(candidate.tag, selected.tag) > 0) selected = candidate;
    }
    if (selected === undefined) return;
    pending.selected = selected;
    this.startReadWriteBack(ctx, pending);
  }

  private startReadWriteBack(ctx: Ctx<ABDState>, pending: PendingRead): void {
    const selected = pending.selected;
    if (selected === null) return;
    pending.phase = 'write-back';
    pending.writeBackAcks = [ctx.me];
    this.applyRegister(ctx, selected);
    for (const peer of ctx.peers) {
      ctx.send(peer, { type: 'ReadPhase2WriteBack', operationId: pending.operationId, value: selected });
    }
    this.maybeCompleteRead(ctx, pending);
  }

  private onReadPhase2WriteBack(ctx: Ctx<ABDState>, from: NodeId, msg: ReadPhase2WriteBack): void {
    this.applyRegister(ctx, msg.value);
    ctx.send(from, { type: 'ReadPhase2Ack', operationId: msg.operationId });
  }

  private onReadPhase2Ack(ctx: Ctx<ABDState>, from: NodeId, msg: ReadPhase2Ack): void {
    const pending = this.pendingRead(ctx, msg.operationId);
    if (pending === undefined || pending.phase !== 'write-back') return;
    if (!pending.writeBackAcks.includes(from)) pending.writeBackAcks.push(from);
    this.maybeCompleteRead(ctx, pending);
  }

  private onWriteRequest(ctx: Ctx<ABDState>, from: NodeId, msg: WriteRequest): void {
    this.applyRegister(ctx, msg.value);
    ctx.send(from, { type: 'WriteAck', operationId: msg.operationId });
  }

  private onWriteAck(ctx: Ctx<ABDState>, from: NodeId, msg: WriteAck): void {
    const pending = ctx.state.pendingWrite;
    if (pending === null || pending.operationId !== msg.operationId) return;
    if (!pending.acknowledgements.includes(from)) pending.acknowledgements.push(from);
    this.maybeCompleteWrite(ctx);
  }

  private maybeCompleteWrite(ctx: Ctx<ABDState>): void {
    const pending = ctx.state.pendingWrite;
    if (pending === null || pending.acknowledgements.length < quorumSize(ctx.peers.length + 1)) return;
    ctx.state.pendingWrite = null;
    ctx.log('write-complete', { operationId: pending.operationId, tag: pending.value.tag });
  }

  private maybeCompleteRead(ctx: Ctx<ABDState>, pending: PendingRead): void {
    if (pending.phase !== 'write-back' || pending.writeBackAcks.length < quorumSize(ctx.peers.length + 1)) return;
    pending.phase = 'complete';
    const selected = pending.selected;
    if (selected === null) return;
    ctx.log('read-complete', { operationId: pending.operationId, tag: selected.tag, value: selected.value });
    const index = ctx.state.pendingReads.indexOf(pending);
    if (index >= 0) ctx.state.pendingReads.splice(index, 1);
  }

  private applyRegister(ctx: Ctx<ABDState>, value: RegisterValue): void {
    if (compareTags(value.tag, ctx.state.register.tag) > 0) ctx.state.register = value;
  }

  private pendingRead(ctx: Ctx<ABDState>, operationId: string): PendingRead | undefined {
    return ctx.state.pendingReads.find((read) => read.operationId === operationId);
  }

  private nextOperationId(ctx: Ctx<ABDState>): string {
    const id = `${ctx.me}-op-${ctx.state.nextOperationId}`;
    ctx.state.nextOperationId += 1;
    return id;
  }
}

export function compareTags(a: Tag, b: Tag): number {
  if (a.counter !== b.counter) return a.counter - b.counter;
  return a.writerId - b.writerId;
}
