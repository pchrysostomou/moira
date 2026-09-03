import type { NodeId } from 'moirae-core';

// ABD register tags are logical protocol metadata, never wall-clock time.
export interface Tag {
  readonly counter: number;
  readonly writerId: NodeId;
}

export type RegisterValue<T = string> = {
  readonly tag: Tag;
  readonly value: T;
};

export type PendingRead = {
  readonly operationId: string;
  readonly responses: Record<string, RegisterValue>;
  selected: RegisterValue | null;
  writeBackAcks: NodeId[];
  phase: 'query' | 'write-back' | 'complete';
};

export type PendingWrite = {
  readonly operationId: string;
  readonly value: RegisterValue;
  readonly acknowledgements: NodeId[];
};

export type ABDState = {
  // Durable register state. See ABD.md §8.
  register: RegisterValue;
  writeCounter: number;

  // The operation-id allocator is also durable. Delayed messages may survive
  // a crash/restart in the simulator, so reusing an id after restart would let
  // an old response or acknowledgement be mistaken for a new operation.
  nextOperationId: number;

  // Volatile in-flight operation state.
  pendingReads: PendingRead[];
  pendingWrite: PendingWrite | null;
};

// Moirae node ids are 1-based. writerId=0 is reserved for the initial tag.
export const INITIAL_TAG: Tag = Object.freeze({ counter: 0, writerId: 0 });

// v0 has one designated writer. Multi-writer ABD is explicitly deferred.
export const SINGLE_WRITER_ID: NodeId = 1;

// Strict-majority quorum: floor(N / 2) + 1, equivalently 2*q > N.
export function quorumSize(nodes: number): number {
  return Math.floor(nodes / 2) + 1;
}
