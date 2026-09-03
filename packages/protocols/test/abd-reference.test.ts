import { describe, expect, it } from 'vitest';
import { simulate } from 'moirae-core';
import { ABD } from '../src/index';
import type { Ctx } from 'moirae-core';
import type { ABDState } from '../src/index';
import { historyFromTrace, type ABDHistoryOperation } from './abd-history-checker';
import { referenceInitialState, referenceRead, referenceReplay, referenceWrite } from './abd-reference-model';

class SingleWriteRead extends ABD {
  override init(ctx?: Ctx<ABDState>): ABDState {
    const state = super.init();
    if (ctx !== undefined && ctx.me === 1) ctx.setTimer('write', 0);
    if (ctx !== undefined && ctx.me === 2) ctx.setTimer('read', 100);
    return state;
  }

  override onTimer(ctx?: Ctx<ABDState>, name?: string): void {
    if (ctx === undefined || name === undefined) return;
    if (name === 'write' && ctx.me === 1) this.write(ctx, 'v1');
    if (name === 'read' && ctx.me === 2) this.read(ctx);
  }
}

function completedHistory(result: ReturnType<typeof simulate<ABDState>>): ABDHistoryOperation[] {
  return historyFromTrace(result.trace) as ABDHistoryOperation[];
}

describe('ABD independent reference model', () => {
  it('does not import implementation tag ordering and validates a real sequential trace', () => {
    const result = simulate<ABDState>({
      seed: 0xabd101,
      nodes: 3,
      process: SingleWriteRead,
      until: { simTime: 2_000 },
      network: { latency: [1, 5], duplicateRate: 0.2 },
    });

    expect(result.violation).toBeNull();
    const history = completedHistory(result);
    expect(history.filter((op) => op.kind === 'write')).toHaveLength(1);
    expect(history.filter((op) => op.kind === 'read')).toHaveLength(1);

    const write = history.find((op) => op.kind === 'write');
    const read = history.find((op) => op.kind === 'read');
    expect(write?.kind).toBe('write');
    expect(read?.kind).toBe('read');
    if (write?.kind !== 'write' || read?.kind !== 'read') return;

    const state0 = referenceInitialState();
    const state1 = referenceWrite(state0, {
      tag: { counter: write.tag.counter, writerId: write.tag.writerId },
      value: 'v1',
    });
    const expected = referenceRead(state1);
    expect(read.tag).toEqual(expected.tag);
    expect(referenceReplay([
      {
        kind: 'write',
        value: { tag: write.tag, value: 'v1' },
      },
      {
        kind: 'read',
        observed: read.tag,
      },
    ])).toBe(true);
  });

  it('rejects a tag sequence that the independent register semantics cannot explain', () => {
    expect(referenceReplay([
      {
        kind: 'write',
        value: { tag: { counter: 1, writerId: 1 }, value: 'v1' },
      },
      {
        kind: 'read',
        observed: { counter: 0, writerId: 0 },
      },
    ])).toBe(false);
  });
});
