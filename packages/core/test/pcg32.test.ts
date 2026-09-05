import { describe, expect, it } from 'vitest';
import { fnv1a64String } from '../src/hash';
import { Pcg32 } from '../src/pcg32';

describe('Pcg32', () => {
  it('matches the reference check output for seed (42, 54)', () => {
    // From github.com/imneme/pcg-c, test-high/expected/check-pcg32.out:
    // the check program (test-high/check-pcg32.c) seeds pcg32_srandom_r with
    // the constants 42u, 54u and prints these six 32-bit values first.
    const rng = new Pcg32(42n, 54n);
    const expected = [0xa15c02b7, 0x7b47f409, 0xba1d3330, 0x83d2f293, 0xbfa4784b, 0xcbed606e];
    const actual = expected.map(() => rng.nextUint32());
    expect(actual).toEqual(expected);
  });

  it('is deterministic: same seed, same sequence', () => {
    const a = new Pcg32(123456789n, 987654321n);
    const b = new Pcg32(123456789n, 987654321n);
    for (let i = 0; i < 1000; i++) {
      expect(b.nextUint32()).toBe(a.nextUint32());
    }
  });

  it('separates streams: same state, different sequence selectors', () => {
    const a = new Pcg32(42n, 1n);
    const b = new Pcg32(42n, 2n);
    const aOut = Array.from({ length: 8 }, () => a.nextUint32());
    const bOut = Array.from({ length: 8 }, () => b.nextUint32());
    expect(aOut).not.toEqual(bOut);
  });

  it('derives the streams moirae-sched pins (ADR-009)', () => {
    // The engine's network stream for seed 42, and moirae-sched's stream(42, "sched"):
    // Pcg32(fnv1a64("42/sched"), fnv1a64("sched")). Both sides assert these words.
    const network = new Pcg32(fnv1a64String('42/network'), 0n);
    expect([0, 0, 0, 0].map(() => network.nextUint32())).toEqual([0xaf524a62, 0xe605927b, 0x38d6c87b, 0xabc3f47a]);
    const sched = new Pcg32(fnv1a64String('42/sched'), fnv1a64String('sched'));
    expect([0, 0, 0, 0].map(() => sched.nextUint32())).toEqual([0xa728c242, 0x9ad18a72, 0x4096192d, 0xe5689df8]);
  });

  it('random() stays in [0, 1)', () => {
    const rng = new Pcg32(7n, 11n);
    for (let i = 0; i < 10000; i++) {
      const r = rng.random();
      expect(r).toBeGreaterThanOrEqual(0);
      expect(r).toBeLessThan(1);
    }
  });
});
