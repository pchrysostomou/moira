import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { simulate, type Ctx, type Message, type NodeId, type Process, type TraceEvent } from 'moirae-core';

// The parity fixtures for crates/moirae-trace (ADR-009). This side is the
// authority: the committed bytes must be what the engine produces. The Rust
// writer's tests assert it reproduces the same bytes. To change the format,
// change the engine, regenerate the fixture, and update both sides in one commit.

const FIXTURES = 'crates/moirae-trace/tests/fixtures';

interface KindsState {
  sent: number;
  got: number;
  [field: string]: unknown;
}

// A tiny protocol that makes the engine emit every event kind: timers, sends,
// duplicated deliveries, partition and crashed drops, state patches, logs, a
// scheduled crash with persisted fields, a restart, and a violation.
class Kinds implements Process<KindsState> {
  readonly persistent = ['sent'] as const;
  init(ctx: Ctx<KindsState>): KindsState {
    ctx.setTimer('tick', 10);
    return { sent: 0, got: 0 };
  }
  onTimer(ctx: Ctx<KindsState>): void {
    ctx.state.sent++;
    ctx.send(ctx.peers[0] as NodeId, { type: 'ping', n: ctx.state.sent, tag: 'a"b\\c\n' });
    ctx.log('tick', { n: ctx.state.sent });
    if (ctx.state.sent < 4) ctx.setTimer('tick', 20);
  }
  onMessage(ctx: Ctx<KindsState>, from: NodeId, msg: Message): void {
    ctx.state.got++;
    if (msg.type === 'ping') ctx.send(from, { type: 'pong' });
  }
}

export function kinds() {
  return simulate<KindsState>({
    seed: 3,
    nodes: 2,
    process: Kinds,
    until: { simTime: 300 },
    // Rates are 0 or 1 on purpose: the header records this config, and the
    // Rust writer has no floats (moirae-trace: integers only, by design).
    network: {
      latency: [5, 5],
      dropRate: 0,
      duplicateRate: 1,
      partitions: [{ groups: [[1], [2]], start: 45, end: 60 }],
    },
    faults: { crashes: [{ node: 2, at: 25, restartAt: 70 }] },
    // Fires at the first step at or after t=100, after every fault above has
    // happened, so the fixture ends with a violation line and still holds
    // every other kind.
    invariants: [{ name: 'stopAt100', check: (world) => (world.time >= 100 ? 'ran long enough' : null) }],
  });
}

it('engine.jsonl is what the engine produces for the kinds scenario', () => {
  const result = kinds();
  expect(result.violation).not.toBeNull(); // the sibling: the scenario runs far enough to reach every kind
  expect(readFileSync(`${FIXTURES}/engine.jsonl`, 'utf8')).toBe(result.jsonl);
});

// The v2-only shapes the engine never emits, as literals serialised the way
// the engine serialises: JSON.stringify, no whitespace, field order as written.
const V2_EXTRAS: readonly (TraceEvent | Record<string, unknown>)[] = [
  {
    kind: 'header',
    v: 2,
    seed: 9007199254740991,
    nodes: 3,
    unit: 'ns',
    ananke: { version: '0.0.1', clocks: [{ node: 1, skew: -5000000, drift: 250 }] },
  },
  { t: 0, seq: 0, kind: 'init', node: 1 },
  {
    t: 1500000000,
    seq: 1,
    kind: 'send',
    from: 1,
    to: 2,
    msgId: 0,
    msg: { type: 'ping', text: 'quote" back\\ nl\n tab\t ctl é \u{1F600}' },
  },
  { t: 1500000000, seq: 2, kind: 'drop', msgId: 0, reason: 'queue-full' },
  { t: 1500000001, seq: 3, kind: 'deliver', msgId: 0, dup: true },
  {
    t: 1500000002,
    seq: 4,
    kind: 'log',
    node: 2,
    event: 'ananke.task.polled',
    data: { task: 7, name: 'echo', nested: { ok: true, none: null, list: [1, -2] } },
  },
  { t: 1500000003, seq: 5, kind: 'log', node: 2, event: 'ananke.time.advanced' },
  { t: 1500000004, seq: 6, kind: 'fault', fault: 'crash', node: 3, cause: 'schedule' },
  { t: 1500000005, seq: 7, kind: 'fault', fault: 'restart', node: 3 },
  { t: 1500000006, seq: 8, kind: 'timer', node: 1, name: 'election' },
  { t: 1500000007, seq: 9, kind: 'violation', invariant: 'electionSafety', detail: 'two leaders in term 3' },
  // SPEC §5: an integer past 2^53 travels as its digits in a string, in data and as `t`.
  {
    t: 1500000008,
    seq: 10,
    kind: 'log',
    node: 2,
    event: 'ananke.wal.recovered',
    data: { records: 12, stop: { segment: 3, offset: 40, reason: 'gap', expected: 13, found: '18014398509482243' } },
  },
  { t: '9007199254740992', seq: 11, kind: 'timer', node: 1, name: 'late' },
];

it('v2-extras.jsonl is JSON.stringify of the v2-only shapes', () => {
  const jsonl = V2_EXTRAS.map((line) => JSON.stringify(line)).join('\n') + '\n';
  expect(readFileSync(`${FIXTURES}/v2-extras.jsonl`, 'utf8')).toBe(jsonl);
});
