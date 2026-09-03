import { describe, expect, it } from 'vitest';
import { Pcg32, simulate } from 'moirae-core';
import type { CrashSchedule, NetworkConfig, Partition } from 'moirae-core';
import { ABD, completedWriteReadFreshness, tagMonotonicity } from '../src/index';
import type { ABDState } from '../src/index';
import type { Ctx } from 'moirae-core';

const SEEDS = 200;
const SIM_TIME = 4_000;
const READ_COMPLETION_FLOOR = 120;

class ABDFuzzWorkload extends ABD {
  override init(ctx?: Ctx<ABDState>): ABDState {
    const state = super.init();
    if (ctx !== undefined && ctx.me === 1) ctx.setTimer('write', 50);
    if (ctx !== undefined && ctx.me === 2) ctx.setTimer('read', 400);
    if (ctx !== undefined && ctx.me === 3) ctx.setTimer('read', 700);
    return state;
  }

  onRestart(ctx: Ctx<ABDState>): void {
    if (ctx !== undefined && ctx.me === 2) ctx.setTimer('restarted-read', 100);
  }

  override onTimer(ctx?: Ctx<ABDState>, name?: string): void {
    if (ctx === undefined || name === undefined) return;
    if (name === 'write' && ctx.me === 1) this.write(ctx, 'v1');
    if (name === 'read' && (ctx.me === 2 || ctx.me === 3)) this.read(ctx);
    if (name === 'restarted-read' && ctx.me === 2) this.read(ctx);
  }
}

function scenario(seed: number): {
  network: NetworkConfig;
  faults: { crashes: CrashSchedule[] };
} {
  const rng = new Pcg32(BigInt(seed), 0xabd5n);
  const partitions: Partition[] = [];
  let start = 250 + Math.floor(rng.random() * 500);
  const count = rng.random() < 0.45 ? 2 : 1;

  for (let i = 0; i < count && start < SIM_TIME - 600; i++) {
    const left: number[] = [];
    const right: number[] = [];
    for (let node = 1; node <= 3; node++) {
      (rng.random() < 0.5 ? left : right).push(node);
    }
    if (left.length === 0) left.push(right.pop() as number);
    if (right.length === 0) right.push(left.pop() as number);
    const end = start + 150 + Math.floor(rng.random() * 500);
    partitions.push({ groups: [left, right], start, end });
    start = end + 100 + Math.floor(rng.random() * 400);
  }

  const crashes: CrashSchedule[] = [];
  if (rng.random() < 0.45) {
    const at = 900 + Math.floor(rng.random() * 900);
    crashes.push({ node: rng.random() < 0.5 ? 2 : 3, at, restartAt: at + 150 + Math.floor(rng.random() * 300) });
  }

  return {
    // v0 deliberately models reliable delivery. Partitions and crashes test
    // safety under incomplete operations; no dropRate is used until a retry
    // mechanism is added as an explicit protocol extension.
    network: { latency: [1, 40], partitions },
    faults: { crashes },
  };
}

function completed(result: ReturnType<typeof simulate<ABDState>>, event: string): number {
  return result.trace.filter(
    (entry) =>
      (entry as { kind?: string; event?: string }).kind === 'log' &&
      (entry as { event?: string }).event === event,
  ).length;
}

describe('ABD fuzz (reliable-channel v0)', () => {
  it(`holds ABD safety invariants across ${SEEDS} deterministic seeds`, () => {
    let readSeeds = 0;

    for (let seed = 1; seed <= SEEDS; seed++) {
      const { network, faults } = scenario(seed);
      const result = simulate<ABDState>({
        seed,
        nodes: 3,
        process: ABDFuzzWorkload,
        until: { simTime: SIM_TIME },
        network,
        faults,
        invariants: [tagMonotonicity(), completedWriteReadFreshness()],
      });

      expect(result.violation, `seed ${seed}: ${JSON.stringify(result.violation)}`).toBeNull();
      expect(completed(result, 'write-complete'), `seed ${seed} must complete the initial write`).toBeGreaterThanOrEqual(1);
      if (completed(result, 'read-complete') > 0) readSeeds += 1;
    }

    expect(readSeeds).toBeGreaterThanOrEqual(READ_COMPLETION_FLOOR);
  }, 600_000);
});
