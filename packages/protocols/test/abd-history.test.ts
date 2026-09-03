import { describe, expect, it } from 'vitest';
import { historyFromTrace, isLinearizable, type ABDHistoryOperation } from './abd-history-checker';

const t0 = { counter: 0, writerId: 0 } as const;
const t1 = { counter: 1, writerId: 1 } as const;
const t2 = { counter: 2, writerId: 1 } as const;

function write(id: string, invokeSeq: number, completeSeq: number, tag: typeof t1 | typeof t2): ABDHistoryOperation {
  return { id, kind: 'write', invokeSeq, completeSeq, tag, writerId: tag.writerId };
}

function read(id: string, invokeSeq: number, completeSeq: number, tag: typeof t0 | typeof t1 | typeof t2): ABDHistoryOperation {
  return { id, kind: 'read', invokeSeq, completeSeq, tag };
}

describe('ABD bounded linearizability checker', () => {
  it('accepts a completed write followed by a read of that value', () => {
    expect(isLinearizable([
      write('w1', 1, 2, t1),
      read('r1', 3, 4, t1),
    ])).toBe(true);
  });

  it('accepts overlapping read/write when the read linearizes before the write', () => {
    expect(isLinearizable([
      write('w1', 2, 5, t1),
      read('r1', 1, 3, t0),
    ])).toBe(true);
  });

  it('rejects a read that returns the old value after a non-overlapping completed write', () => {
    expect(isLinearizable([
      write('w1', 1, 2, t1),
      read('r1', 3, 4, t0),
    ])).toBe(false);
  });

  it('rejects a read that returns a future tag before its write can linearize', () => {
    expect(isLinearizable([
      write('w1', 5, 6, t1),
      read('r1', 1, 2, t1),
    ])).toBe(false);
  });

  it('accepts overlapping writes/read with a legal later read', () => {
    expect(isLinearizable([
      write('w1', 1, 5, t1),
      write('w2', 2, 6, t2),
      read('r1', 3, 7, t2),
    ])).toBe(true);
  });

  it('extracts only completed ABD operations from a trace', () => {
    const history = historyFromTrace([
      { kind: 'log', seq: 1, event: 'write-start', data: { operationId: 'w1' } },
      { kind: 'log', seq: 2, event: 'write-complete', data: { operationId: 'w1', tag: t1 } },
      { kind: 'log', seq: 3, event: 'read-start', data: { operationId: 'r1' } },
      { kind: 'log', seq: 4, event: 'read-complete', data: { operationId: 'r1', tag: t1, value: 'v1' } },
      { kind: 'log', seq: 5, event: 'read-start', data: { operationId: 'r2' } },
    ]);
    expect(history).toHaveLength(2);
    expect(history[0]).toMatchObject({ id: 'w1', kind: 'write', invokeSeq: 1, completeSeq: 2, tag: t1 });
    expect(history[1]).toMatchObject({ id: 'r1', kind: 'read', invokeSeq: 3, completeSeq: 4, tag: t1 });
  });
});
