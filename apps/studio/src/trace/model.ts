// Everything the studio draws, derived from the parsed trace and nothing
// else. Pure data: no React, no engine, no protocol.
//
// Display convention (SPEC §9): a top-level state field named `role` colours
// a node's lane; a field named `currentTerm` (or `term`) labels it. When a
// trace has neither, `conventions` says so and the UI must say so too.

import type { DeliverEvent, DropEvent, SendEvent, TimeUnit, TraceEvent, TraceHeader } from 'moirae-core';
import type { ParsedTrace } from './parse';

type Event = Exclude<TraceEvent, TraceHeader>;

export interface RoleInterval {
  readonly start: number;
  readonly end: number;
  readonly role: string;
  readonly term: number | null;
}

export interface CrashSpan {
  readonly node: number;
  readonly start: number;
  readonly end: number; // the restart time, or the trace end if it never came back
  readonly restarted: boolean;
}

export interface PartitionWindow {
  readonly start: number;
  readonly end: number; // the heal time, or the trace end if it never healed
  readonly groups: readonly (readonly number[])[];
}

export interface MessageThread {
  readonly send: SendEvent;
  readonly delivers: readonly DeliverEvent[];
  readonly drop: DropEvent | null;
}

export interface Conventions {
  readonly role: boolean; // some state patch carried a top-level string `role`
  readonly term: boolean; // some state patch carried a numeric `currentTerm` or `term`
}

export interface TraceModel {
  readonly header: TraceHeader;
  readonly unit: TimeUnit; // what every t in this model counts in (SPEC §5)
  readonly nodes: readonly number[];
  readonly duration: number;
  readonly roles: ReadonlyMap<number, readonly RoleInterval[]>;
  readonly crashes: readonly CrashSpan[];
  readonly partitions: readonly PartitionWindow[];
  readonly messages: readonly MessageThread[]; // in send order
  readonly byMsgId: ReadonlyMap<number, MessageThread>;
  readonly messageTypes: readonly string[]; // distinct msg.type values, first-seen order
  readonly conventions: Conventions;
  // The node's state as folded from its patches up to and including time t;
  // null while crashed (or before init).
  stateAt(node: number, t: number): Readonly<Record<string, unknown>> | null;
}

interface Step {
  readonly t: number;
  readonly kind: 'patch' | 'crash' | 'restart';
  readonly patch?: Record<string, unknown>;
}

function termOf(patch: Record<string, unknown>): number | null | undefined {
  const ct = patch['currentTerm'];
  if (typeof ct === 'number') return ct;
  const term = patch['term'];
  if (typeof term === 'number') return term;
  return undefined; // not mentioned in this patch
}

export function deriveModel(parsed: ParsedTrace): TraceModel {
  const { header, events } = parsed;
  const unit: TimeUnit = header.unit ?? 'ms';
  const nodes: number[] = [];
  for (let id = 1; id <= header.nodes; id++) nodes.push(id);
  const duration = events.length > 0 ? Math.max(...events.map((e) => e.t)) : 0;

  const steps = new Map<number, Step[]>();
  for (const id of nodes) steps.set(id, []);
  const stepsOf = (id: number): Step[] => {
    const s = steps.get(id);
    if (s === undefined) throw new Error(`trace refers to node ${id}, but the header declares ${header.nodes} nodes`);
    return s;
  };

  const roles = new Map<number, RoleInterval[]>();
  const open = new Map<number, { role: string | null; term: number | null; since: number }>();
  for (const id of nodes) {
    roles.set(id, []);
    open.set(id, { role: null, term: null, since: 0 });
  }
  const closeInterval = (id: number, at: number): void => {
    const cur = open.get(id) as { role: string | null; term: number | null; since: number };
    if (cur.role !== null && at > cur.since) {
      (roles.get(id) as RoleInterval[]).push({ start: cur.since, end: at, role: cur.role, term: cur.term });
    }
    cur.since = at;
  };

  const crashes: CrashSpan[] = [];
  const openCrash = new Map<number, number>(); // node -> crash time
  const partitions: PartitionWindow[] = [];
  let openPartition: { start: number; groups: readonly (readonly number[])[] } | null = null;

  const threads = new Map<number, { send: SendEvent; delivers: DeliverEvent[]; drop: DropEvent | null }>();
  const messages: MessageThread[] = [];
  const messageTypes: string[] = [];
  let sawRole = false;
  let sawTerm = false;

  for (const e of events as readonly Event[]) {
    switch (e.kind) {
      case 'state': {
        const patch = e.patch as Record<string, unknown>;
        stepsOf(e.node).push({ t: e.t, kind: 'patch', patch });
        const cur = open.get(e.node) as { role: string | null; term: number | null; since: number };
        const role = patch['role'];
        const term = termOf(patch);
        if (typeof role === 'string') sawRole = true;
        if (term !== undefined && term !== null) sawTerm = true;
        const nextRole = typeof role === 'string' ? role : cur.role;
        const nextTerm = term === undefined ? cur.term : term;
        if (nextRole !== cur.role || nextTerm !== cur.term) {
          closeInterval(e.node, e.t);
          cur.role = nextRole;
          cur.term = nextTerm;
        }
        break;
      }
      case 'fault': {
        if (e.fault === 'crash') {
          stepsOf(e.node).push({ t: e.t, kind: 'crash' });
          closeInterval(e.node, e.t);
          (open.get(e.node) as { role: string | null }).role = null;
          openCrash.set(e.node, e.t);
        } else if (e.fault === 'restart') {
          stepsOf(e.node).push({ t: e.t, kind: 'restart' });
          const start = openCrash.get(e.node);
          if (start !== undefined) {
            crashes.push({ node: e.node, start, end: e.t, restarted: true });
            openCrash.delete(e.node);
          }
          (open.get(e.node) as { since: number }).since = e.t;
        } else if (e.fault === 'partition') {
          openPartition = { start: e.t, groups: e.groups };
        } else if (e.fault === 'heal') {
          if (openPartition !== null) {
            partitions.push({ start: openPartition.start, end: e.t, groups: openPartition.groups });
            openPartition = null;
          }
        }
        break;
      }
      case 'send': {
        const thread = { send: e, delivers: [] as DeliverEvent[], drop: null as DropEvent | null };
        threads.set(e.msgId, thread);
        messages.push(thread);
        const type = e.msg.type;
        if (!messageTypes.includes(type)) messageTypes.push(type);
        break;
      }
      case 'deliver': {
        threads.get(e.msgId)?.delivers.push(e);
        break;
      }
      case 'drop': {
        const thread = threads.get(e.msgId);
        if (thread !== undefined) thread.drop = e;
        break;
      }
      default:
        break;
    }
  }
  for (const id of nodes) closeInterval(id, duration);
  for (const [node, start] of openCrash) crashes.push({ node, start, end: duration, restarted: false });
  if (openPartition !== null) partitions.push({ start: openPartition.start, end: duration, groups: openPartition.groups });
  crashes.sort((a, b) => a.start - b.start || a.node - b.node);

  const stateAt = (node: number, t: number): Readonly<Record<string, unknown>> | null => {
    let state: Record<string, unknown> | null = null;
    for (const step of stepsOf(node)) {
      if (step.t > t) break;
      if (step.kind === 'crash') {
        state = null;
      } else if (step.kind === 'restart') {
        state = null; // the restart's full patch follows at the same t
      } else if (step.patch !== undefined) {
        const next: Record<string, unknown> = state === null ? {} : { ...state };
        for (const [key, value] of Object.entries(step.patch)) {
          if (value === null) delete next[key];
          else next[key] = value;
        }
        state = next;
      }
    }
    return state;
  };

  return {
    header,
    unit,
    nodes,
    duration,
    roles,
    crashes,
    partitions,
    messages,
    byMsgId: threads,
    messageTypes,
    conventions: { role: sawRole, term: sawTerm },
    stateAt,
  };
}
