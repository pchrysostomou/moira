import type { Invariant, NodeId, WorldView } from 'moirae-core';
import type { ABDState, Tag } from './state';
import { compareTags } from './abd';

// ABD.md §6.3 — a replica's tag never decreases. The history is retained
// across crashes because the register is persistent and must not reappear at
// a smaller tag after restart.
export function tagMonotonicity(): Invariant<ABDState> {
  const last = new Map<NodeId, Tag>();
  return {
    name: 'abdTagMonotonicity',
    check(world: WorldView<ABDState>): string | null {
      for (const node of world.nodes) {
        if (node.state === null) continue;
        const current = node.state.register.tag;
        const previous = last.get(node.id);
        if (previous !== undefined && compareTags(current, previous) < 0) {
          return (
            `node ${node.id} regressed from (${previous.counter},${previous.writerId}) ` +
            `to (${current.counter},${current.writerId})`
          );
        }
        last.set(node.id, current);
      }
      return null;
    },
  };
}

type SeenWrite = {
  operationId: string;
  tag: Tag;
  completedSeq: number;
};

type TraceLike = {
  kind: string;
  seq: number;
  event?: string;
  data?: Record<string, unknown>;
};

function tagFrom(data: Record<string, unknown> | undefined): Tag | null {
  const value = data?.['tag'];
  if (typeof value !== 'object' || value === null) return null;
  const tag = value as { counter?: unknown; writerId?: unknown };
  if (typeof tag.counter !== 'number' || typeof tag.writerId !== 'number') return null;
  return { counter: tag.counter, writerId: tag.writerId };
}

// ABD.md §6.2 — if a write completed before a read began, that read may not
// return a smaller tag. Invocation and completion boundaries are explicit log
// events so this check uses trace order rather than guessing from timestamps.
export function completedWriteReadFreshness(): Invariant<ABDState> {
  const starts = new Map<string, number>();
  const completedWrites: SeenWrite[] = [];
  let processed = 0;

  return {
    name: 'abdCompletedWriteReadFreshness',
    check(world: WorldView<ABDState>): string | null {
      for (; processed < world.trace.length; processed++) {
        const event = world.trace[processed] as unknown as TraceLike;
        if (event.kind !== 'log' || event.event === undefined) continue;

        if (event.event === 'write-start' || event.event === 'read-start') {
          const operationId = event.data?.['operationId'];
          if (typeof operationId === 'string') starts.set(operationId, event.seq);
          continue;
        }

        if (event.event === 'write-complete') {
          const operationId = event.data?.['operationId'];
          const tag = tagFrom(event.data);
          if (typeof operationId === 'string' && tag !== null) {
            completedWrites.push({ operationId, tag, completedSeq: event.seq });
          }
          continue;
        }

        if (event.event !== 'read-complete') continue;
        const operationId = event.data?.['operationId'];
        const returned = tagFrom(event.data);
        if (typeof operationId !== 'string' || returned === null) continue;
        const readStart = starts.get(operationId);
        if (readStart === undefined) continue;

        for (const write of completedWrites) {
          if (write.completedSeq < readStart && compareTags(returned, write.tag) < 0) {
            return (
              `read ${operationId} returned (${returned.counter},${returned.writerId}) ` +
              `after completed write ${write.operationId} ` +
              `(${write.tag.counter},${write.tag.writerId})`
            );
          }
        }
      }
      return null;
    },
  };
}
