import { describe, expect, it } from 'vitest';
import type { WorldView } from 'moirae-core';
import { completedWriteReadFreshness, tagMonotonicity } from '../src/abd/invariants';
import type { ABDState } from '../src/abd/state';

type TraceRecord = {
  kind: 'log';
  seq: number;
  event: string;
  data?: Record<string, unknown>;
};

const state = (counter: number, writerId = 1): ABDState => ({
  register: { tag: { counter, writerId }, value: `v${counter}` },
  writeCounter: counter,
  nextOperationId: 1,
  pendingReads: [],
  pendingWrite: null,
});

function world(step: number, nodes: { id: number; state: ABDState | null }[], trace: TraceRecord[] = []): WorldView<ABDState> {
  return {
    time: step,
    step,
    nodes: nodes.map((node) => ({ ...node, crashed: node.state === null })),
    trace: trace as never,
  };
}

describe('ABD safety invariants', () => {
  it('detects a per-replica tag regression', () => {
    const invariant = tagMonotonicity();
    expect(invariant.check(world(0, [{ id: 1, state: state(2) }]))).toBeNull();
    expect(invariant.check(world(1, [{ id: 1, state: state(1) }]))).toBe(
      'node 1 regressed from (2,1) to (1,1)',
    );
  });

  it('keeps the last tag across a crash and validates the restarted register', () => {
    const invariant = tagMonotonicity();
    expect(invariant.check(world(0, [{ id: 1, state: state(5) }]))).toBeNull();
    expect(invariant.check(world(1, [{ id: 1, state: null }]))).toBeNull();
    expect(invariant.check(world(2, [{ id: 1, state: state(4) }]))).toContain('regressed');
  });

  it('detects a stale read after a completed non-overlapping write', () => {
    const invariant = completedWriteReadFreshness();
    const trace: TraceRecord[] = [
      { kind: 'log', seq: 1, event: 'write-start', data: { operationId: '1-op-1' } },
      { kind: 'log', seq: 2, event: 'write-complete', data: { operationId: '1-op-1', tag: { counter: 2, writerId: 1 } } },
      { kind: 'log', seq: 3, event: 'read-start', data: { operationId: '2-op-1' } },
      { kind: 'log', seq: 4, event: 'read-complete', data: { operationId: '2-op-1', tag: { counter: 1, writerId: 1 } } },
    ];
    expect(invariant.check(world(4, [{ id: 1, state: state(2) }], trace))).toContain(
      'returned (1,1) after completed write 1-op-1 (2,1)',
    );
  });

  it('does not reject a read that overlaps an in-flight write', () => {
    const invariant = completedWriteReadFreshness();
    const trace: TraceRecord[] = [
      { kind: 'log', seq: 1, event: 'read-start', data: { operationId: '2-op-1' } },
      { kind: 'log', seq: 2, event: 'write-start', data: { operationId: '1-op-1' } },
      { kind: 'log', seq: 3, event: 'write-complete', data: { operationId: '1-op-1', tag: { counter: 2, writerId: 1 } } },
      { kind: 'log', seq: 4, event: 'read-complete', data: { operationId: '2-op-1', tag: { counter: 1, writerId: 1 } } },
    ];
    expect(invariant.check(world(4, [{ id: 1, state: state(2) }], trace))).toBeNull();
  });

  it('accepts a read at or above the last completed write tag', () => {
    const invariant = completedWriteReadFreshness();
    const trace: TraceRecord[] = [
      { kind: 'log', seq: 1, event: 'write-start', data: { operationId: '1-op-1' } },
      { kind: 'log', seq: 2, event: 'write-complete', data: { operationId: '1-op-1', tag: { counter: 2, writerId: 1 } } },
      { kind: 'log', seq: 3, event: 'read-start', data: { operationId: '2-op-1' } },
      { kind: 'log', seq: 4, event: 'read-complete', data: { operationId: '2-op-1', tag: { counter: 2, writerId: 1 } } },
    ];
    expect(invariant.check(world(4, [{ id: 1, state: state(2) }], trace))).toBeNull();
  });
});
