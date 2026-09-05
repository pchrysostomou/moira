import { describe, expect, it } from 'vitest';
import { fnv1a64String, hex64 } from '../src/hash';
import { simulate } from '../src/simulate';
import type { Ctx, Message, NodeId, Process } from '../src/types';

// The Phase 2 golden: the same three assertions as determinism.test.ts, over
// a run that exercises every fault path — latency, loss, duplication, a
// partition, a crash with persistence and a restart, and invariant checks.
// Same rule: a deliberate engine change updates the constant in the same
// commit and says so; an unexplained change is a bug.

const GOLDEN_HASH = '49a35842b7de982f';

interface GossipState {
  count: number;
  received: number;
  seen: number[];
  [field: string]: unknown;
}

class Gossip implements Process<GossipState> {
  persistent = ['seen'] as const;

  init(ctx: Ctx<GossipState>): GossipState {
    ctx.setTimer('tick', 10 + Math.floor(ctx.random() * 20));
    return { count: 0, received: 0, seen: [] };
  }

  onMessage(ctx: Ctx<GossipState>, from: NodeId, msg: Message): void {
    ctx.state.received++;
    if (msg.type === 'ping') {
      ctx.state.seen.push(msg['n'] as number);
      if (ctx.random() < 0.3) ctx.send(from, { type: 'pong' });
    }
  }

  onTimer(ctx: Ctx<GossipState>): void {
    ctx.state.count++;
    const peers = ctx.peers;
    const target = peers[Math.floor(ctx.random() * peers.length)] as NodeId;
    ctx.send(target, { type: 'ping', n: ctx.state.count });
    if (ctx.state.count < 40) {
      ctx.setTimer('tick', 10 + Math.floor(ctx.random() * 20));
    }
  }

  onRestart(ctx: Ctx<GossipState>, persisted: Partial<GossipState>): void {
    ctx.log('restarted', { seen: persisted.seen?.length ?? 0 });
  }
}

const OPTS = {
  seed: 0xdecaf,
  nodes: 5,
  process: Gossip,
  until: { simTime: 1500 },
  network: {
    latency: [5, 40] as const,
    dropRate: 0.1,
    duplicateRate: 0.05,
    partitions: [{ groups: [[1, 2], [3, 4, 5]], start: 200, end: 600 }],
  },
  faults: {
    crashes: [
      { node: 2, at: 300, restartAt: 450 },
      { node: 5, at: 800 },
    ],
  },
  invariants: [
    {
      name: 'receivedNeverNegative',
      check: (world: { nodes: readonly { state: GossipState | null }[] }) =>
        world.nodes.some((n) => n.state !== null && n.state.received < 0) ? 'negative' : null,
    },
  ],
} as const;

function kinds(jsonl: string, predicate: (line: string) => boolean): number {
  return jsonl.split('\n').filter(predicate).length;
}

describe('determinism under faults (SPEC §10.1)', () => {
  it('the scenario actually exercises every fault path', () => {
    const run = simulate<GossipState>(OPTS);
    expect(run.violation).toBeNull();
    expect(kinds(run.jsonl, (l) => l.includes('"reason":"loss"'))).toBeGreaterThan(0);
    expect(kinds(run.jsonl, (l) => l.includes('"reason":"partition"'))).toBeGreaterThan(0);
    expect(kinds(run.jsonl, (l) => l.includes('"reason":"crashed"'))).toBeGreaterThan(0);
    expect(kinds(run.jsonl, (l) => l.includes('"dup":true'))).toBeGreaterThan(0);
    expect(kinds(run.jsonl, (l) => l.includes('"fault":"crash"'))).toBe(2);
    expect(kinds(run.jsonl, (l) => l.includes('"fault":"restart"'))).toBe(1);
    expect(kinds(run.jsonl, (l) => l.includes('"event":"restarted"'))).toBe(1);
  });

  it('same seed, two runs: byte-identical traces', () => {
    const a = simulate<GossipState>(OPTS);
    const b = simulate<GossipState>(OPTS);
    expect(b.jsonl).toBe(a.jsonl);
  });

  it('trace hash matches the committed golden hash', () => {
    const run = simulate<GossipState>(OPTS);
    expect(hex64(fnv1a64String(run.jsonl))).toBe(GOLDEN_HASH);
  });

  it('a different seed produces a different trace', () => {
    const run = simulate<GossipState>({ ...OPTS, seed: 0xdecaf + 1 });
    expect(hex64(fnv1a64String(run.jsonl))).not.toBe(GOLDEN_HASH);
  });
});
