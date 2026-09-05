import { describe, expect, it } from 'vitest';
import { fnv1a64String, hex64, simulate } from 'moirae-core';
import type { Invariant, NetworkConfig, SimulationResult, WorldView } from 'moirae-core';

// The partition scenario's pinned trace hash: Raft plus every engine feature,
// byte-identical across runs, machines and Node versions (SPEC §10.1). A
// deliberate change to Raft or the engine updates it in the same commit.
const PARTITION_GOLDEN_HASH = '98c6dc4a5eb27076';
import { electionSafety, logMatching, stateMachineSafety } from '../src/index';
import type { RaftState } from '../src/index';
// The workload driver lives with the examples; see examples/src/workload.ts.
import { RaftWithLoad } from '../../../examples/src/workload';

// docs/RAFT.md "Test scenarios that must pass", 1–3 and 5, on the real
// engine: random timeouts, latency, loss, duplication, partitions, crashes.
// These are the runs that do not depend on the scripted harness.

const LOSSY: NetworkConfig = { latency: [10, 50], dropRate: 0.02 };

interface Run {
  result: SimulationResult;
  world: WorldView<RaftState>;
}

function run(opts: {
  seed: number;
  until: number;
  network?: NetworkConfig;
  faults?: { crashes: { node: number; at: number; restartAt?: number }[] };
}): Run {
  let last: WorldView<RaftState> | null = null;
  const capture: Invariant<RaftState> = {
    name: 'capture',
    check: (world) => {
      last = world;
      return null;
    },
  };
  const result = simulate<RaftState>({
    seed: opts.seed,
    nodes: 5,
    process: RaftWithLoad,
    until: { simTime: opts.until },
    ...(opts.network ? { network: opts.network } : {}),
    ...(opts.faults ? { faults: opts.faults } : {}),
    invariants: [electionSafety(), logMatching(), stateMachineSafety(), capture],
  });
  return { result, world: last as unknown as WorldView<RaftState> };
}

function live(world: WorldView<RaftState>): RaftState[] {
  return world.nodes.flatMap((n) => (n.state === null ? [] : [n.state]));
}

function leaders(world: WorldView<RaftState>): number[] {
  return world.nodes.flatMap((n) => (n.state?.role === 'leader' ? [n.id] : []));
}

function expectConverged(world: WorldView<RaftState>): void {
  const states = live(world);
  const reference = states[0] as RaftState;
  expect(reference.log.length).toBeGreaterThanOrEqual(20);
  for (const s of states) {
    expect(s.log).toEqual(reference.log);
    expect(s.commitIndex).toBe(reference.log.length);
    expect(s.applied).toEqual(reference.log.map((e) => e.command));
  }
}

// Leader transitions visible in the trace: [t, node].
function leaderTransitions(result: SimulationResult): [number, number][] {
  return result.trace.flatMap((e) => {
    const ev = e as { kind: string; t: number; node: number; patch?: { role?: string } };
    return ev.kind === 'state' && ev.patch?.role === 'leader' ? [[ev.t, ev.node] as [number, number]] : [];
  });
}

describe('Raft on the engine (docs/RAFT.md scenarios)', () => {
  it('1. five nodes on a lossy network elect one leader and converge to identical logs', () => {
    const { result, world } = run({ seed: 0xa11ce, until: 6000, network: LOSSY });
    expect(result.violation).toBeNull();
    expect(leaders(world)).toHaveLength(1);
    expectConverged(world);
  });

  it('2. the leader crashes: a new leader takes over, the cluster continues, the old leader catches up', () => {
    const probe = run({ seed: 0xb0b, until: 1500, network: LOSSY });
    const [old] = leaders(probe.world);
    expect(old).toBeDefined();
    const { result, world } = run({
      seed: 0xb0b,
      until: 6000,
      network: LOSSY,
      faults: { crashes: [{ node: old as number, at: 1500, restartAt: 3500 }] },
    });
    expect(result.violation).toBeNull();
    const after = leaderTransitions(result).filter(([t]) => t > 1500);
    expect(after.length).toBeGreaterThan(0);
    expect(after.some(([, node]) => node !== old)).toBe(true);
    expect(leaders(world)).toHaveLength(1);
    expectConverged(world); // includes the restarted node
  });

  it('3. [1,2] | [3,4,5]: the minority elects nobody; after healing one leader remains and logs converge', () => {
    const { result, world } = run({
      seed: 0xca11,
      until: 8000,
      network: { ...LOSSY, partitions: [{ groups: [[1, 2], [3, 4, 5]], start: 1500, end: 3500 }] },
    });
    expect(result.violation).toBeNull();
    const minorityElections = leaderTransitions(result).filter(
      ([t, node]) => t > 1500 && t < 3500 && (node === 1 || node === 2),
    );
    expect(minorityElections).toEqual([]);
    const majorityElections = leaderTransitions(result).filter(([t, node]) => t > 1500 && t < 3500 && node >= 3);
    expect(majorityElections.length).toBeGreaterThan(0); // the majority side kept going
    expect(leaders(world)).toHaveLength(1);
    expectConverged(world);
    expect(hex64(fnv1a64String(result.jsonl))).toBe(PARTITION_GOLDEN_HASH);
  });

  it('5. duplicated and reordered AppendEntries never lose committed entries', () => {
    const { result, world } = run({
      seed: 0xd0d0,
      until: 6000,
      network: { latency: [1, 60], dropRate: 0.05, duplicateRate: 0.2 },
    });
    expect(result.violation).toBeNull();
    const dups = result.trace.filter((e) => (e as { dup?: boolean }).dup === true).length;
    expect(dups).toBeGreaterThan(50); // the scenario really duplicated traffic
    expect(leaders(world)).toHaveLength(1);
    expectConverged(world);
  });
});
