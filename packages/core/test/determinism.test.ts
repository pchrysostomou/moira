import { describe, expect, it } from 'vitest';
import { fnv1a64String, hex64 } from '../src/hash';
import { simulate } from '../src/simulate';
import type { Ctx, Message, NodeId, Process } from '../src/types';

// THE test. SPEC §10.1: same seed → byte-identical trace, across runs,
// machines and Node versions. Three assertions, each with a distinct job:
//
//  1. run-vs-run byte identity — catches nondeterminism *within* one
//     environment (ambient time/randomness, iteration-order leaks);
//  2. a pinned golden hash — catches everything run-vs-run cannot: a broken
//     comparator is deterministically wrong the same way in both runs of one
//     process, so only a cross-commit, cross-machine, cross-Node-version
//     constant makes ordering changes visible. CI runs this on every push.
//     If you changed engine behaviour deliberately, update the constant in
//     the same commit and say so; if you didn't, you just caught a bug.
//  3. seed sensitivity — a hash function of the seed alone would pass 1 and
//     2; different seeds must produce different traces.

const GOLDEN_HASH = 'db080a802edfdf79';

interface GossipState {
  count: number;
  received: number;
  [field: string]: unknown;
}

// A deliberately busy little protocol: per-node PRNG draws decide timer
// delays, receivers and replies, so every engine subsystem (clock, queue,
// timers, messaging, state patches, log events) shows up in the trace.
class Gossip implements Process<GossipState> {
  init(ctx: Ctx<GossipState>): GossipState {
    ctx.setTimer('tick', 10 + Math.floor(ctx.random() * 20));
    return { count: 0, received: 0 };
  }

  onMessage(ctx: Ctx<GossipState>, from: NodeId, msg: Message): void {
    ctx.state.received++;
    if (msg.type === 'ping' && ctx.random() < 0.3) {
      ctx.send(from, { type: 'pong' });
    }
  }

  onTimer(ctx: Ctx<GossipState>): void {
    ctx.state.count++;
    const peers = ctx.peers;
    const target = peers[Math.floor(ctx.random() * peers.length)] as NodeId;
    ctx.send(target, { type: 'ping', n: ctx.state.count });
    ctx.log('tick', { count: ctx.state.count });
    if (ctx.state.count < 25) {
      ctx.setTimer('tick', 10 + Math.floor(ctx.random() * 20));
    }
  }
}

const OPTS = {
  seed: 0xc0ffee,
  nodes: 5,
  process: Gossip,
  until: { simTime: 2000 },
} as const;

describe('determinism (SPEC §10.1)', () => {
  it('same seed, two runs: byte-identical traces', () => {
    const a = simulate<GossipState>(OPTS);
    const b = simulate<GossipState>(OPTS);
    expect(a.steps).toBeGreaterThan(100); // the simulation actually did work
    expect(b.jsonl).toBe(a.jsonl);
  });

  it('trace hash matches the committed golden hash', () => {
    const run = simulate<GossipState>(OPTS);
    expect(hex64(fnv1a64String(run.jsonl))).toBe(GOLDEN_HASH);
  });

  it('a different seed produces a different trace', () => {
    const run = simulate<GossipState>({ ...OPTS, seed: 0xc0ffee + 1 });
    expect(hex64(fnv1a64String(run.jsonl))).not.toBe(GOLDEN_HASH);
  });
});
