import { describe, expect, it } from 'vitest';
import { fnv1a64String, hex64, simulate } from 'moirae-core';
import type { Invariant, NetworkConfig, SimulationResult, WorldView } from 'moirae-core';
import { agreement, proposalIntegrity, validity } from '../src/index';
import type { PaxosState } from '../src/index';
import { PaxosContend, PaxosSolo, PaxosStaggered } from './paxos-load';

// docs/PAXOS.md "Test scenarios that must pass", 1–4, on the real engine.
// Scenario 3's trace hash is pinned (SPEC §10.1): byte-identical across
// runs, machines and Node versions; a deliberate change to Paxos or the
// engine updates it in the same commit.
const PARTITION_GOLDEN_HASH = '5b6c47104362b747';

const LOSSY: NetworkConfig = { latency: [10, 50], dropRate: 0.02 };

interface Run {
  result: SimulationResult;
  world: WorldView<PaxosState>;
}

function run(opts: {
  seed: number;
  nodes: number;
  process: new () => PaxosSolo;
  until: number;
  network?: NetworkConfig;
  faults?: { crashes: { node: number; at: number; restartAt?: number }[] };
}): Run {
  let last: WorldView<PaxosState> | null = null;
  const capture: Invariant<PaxosState> = {
    name: 'capture',
    check: (world) => {
      last = world;
      return null;
    },
  };
  const result = simulate<PaxosState>({
    seed: opts.seed,
    nodes: opts.nodes,
    process: opts.process,
    until: { simTime: opts.until },
    ...(opts.network ? { network: opts.network } : {}),
    ...(opts.faults ? { faults: opts.faults } : {}),
    invariants: [agreement(), validity(), proposalIntegrity(), capture],
  });
  return { result, world: last as unknown as WorldView<PaxosState> };
}

function learnedValues(world: WorldView<PaxosState>): (string | null)[] {
  return world.nodes.flatMap((n) => (n.state === null ? [] : [n.state.learned]));
}

// [t, from, n, v] for every Prepare / Accept send in the trace.
function sends(result: SimulationResult, type: string): { t: number; from: number; n: number; v?: string }[] {
  return result.trace.flatMap((e) => {
    const ev = e as unknown as { kind: string; t: number; from: number; msg?: { type: string; n: number; v?: string } };
    if (ev.kind !== 'send' || ev.msg?.type !== type) return [];
    return [{ t: ev.t, from: ev.from, n: ev.msg.n, ...(ev.msg.v !== undefined ? { v: ev.msg.v } : {}) }];
  });
}

function learnEvents(result: SimulationResult): { t: number; node: number }[] {
  return result.trace.flatMap((e) => {
    const ev = e as { kind: string; t: number; node: number; event?: string };
    return ev.kind === 'log' && ev.event === 'learned' ? [{ t: ev.t, node: ev.node }] : [];
  });
}

describe('Paxos on the engine (docs/PAXOS.md scenarios)', () => {
  it('1. one proposer on a lossy network: every node learns its value', () => {
    const { result, world } = run({ seed: 0x9a0e, nodes: 5, process: PaxosSolo, until: 4000, network: LOSSY });
    expect(result.violation).toBeNull();
    expect(learnedValues(world)).toEqual(['v1', 'v1', 'v1', 'v1', 'v1']);
  });

  it('2. five contending proposers with duplication and reordering: exactly one value, and a proposed one', () => {
    const { result, world } = run({
      seed: 0xc0117e5d,
      nodes: 5,
      process: PaxosContend,
      until: 6000,
      network: { latency: [1, 60], dropRate: 0.05, duplicateRate: 0.2 },
    });
    expect(result.violation).toBeNull();
    const learned = learnedValues(world);
    const value = learned[0] as string;
    expect(['v1', 'v2', 'v3', 'v4', 'v5']).toContain(value); // validity, visibly
    for (const l of learned) expect(l).toBe(value);
    // The contention was real: several distinct proposers ran phase 1.
    const proposers = new Set(sends(result, 'Prepare').map((s) => s.from));
    expect(proposers.size).toBeGreaterThanOrEqual(2);
  });

  it('3. the proposer is in the minority: nothing is learned during the partition, and not for lack of trying', () => {
    const { result, world } = run({
      seed: 0x9a12717,
      nodes: 5,
      process: PaxosSolo,
      until: 6000,
      network: { ...LOSSY, partitions: [{ groups: [[1, 2], [3, 4, 5]], start: 10, end: 3000 }] },
    });
    expect(result.violation).toBeNull();
    // The negative: no learner anywhere while the wall stands.
    expect(learnEvents(result).filter((e) => e.t < 3000)).toEqual([]);
    // The positive sibling: the minority proposer kept starting attempts.
    const attempts = new Set(sends(result, 'Prepare').filter((s) => s.from === 1 && s.t < 3000).map((s) => s.n));
    expect(attempts.size).toBeGreaterThanOrEqual(3);
    // After healing, the value is chosen and everyone learns it.
    expect(learnedValues(world)).toEqual(['v1', 'v1', 'v1', 'v1', 'v1']);
    expect(hex64(fnv1a64String(result.jsonl))).toBe(PARTITION_GOLDEN_HASH);
  });

  it('4. persisted acceptor state forces a post-crash proposer onto the chosen value', () => {
    const { result, world } = run({
      seed: 0xf0ecec,
      nodes: 3,
      process: PaxosStaggered,
      until: 6000,
      faults: { crashes: [{ node: 3, at: 700, restartAt: 1500 }] },
    });
    expect(result.violation).toBeNull();
    // v1 was chosen before the crash; node 3 lost its volatile learner state.
    expect(learnEvents(result).filter((e) => e.t < 700).length).toBeGreaterThan(0);
    const crash = result.trace.find((e) => (e as { kind: string; fault?: string }).kind === 'fault' && (e as { fault?: string }).fault === 'crash') as { node: number; persisted: string[] } | undefined;
    expect(crash?.node).toBe(3);
    expect(crash?.persisted).toEqual(['promised', 'acceptedN', 'acceptedV']);
    // Node 3 then proposed its own value — and phase 2 carried the chosen one.
    const accepts = sends(result, 'Accept').filter((s) => s.from === 3);
    expect(accepts.length).toBeGreaterThan(0); // it really ran a round
    for (const a of accepts) expect(a.v).toBe('v1'); // and was forced (#3, #7)
    const node3 = world.nodes[2]?.state as PaxosState;
    expect(node3.wanted).toBe('v3'); // it wanted its own
    expect(learnedValues(world)).toEqual(['v1', 'v1', 'v1']);
  });
});
