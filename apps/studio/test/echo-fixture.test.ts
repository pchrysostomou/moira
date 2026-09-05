import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { fnv1a64String, hex64 } from 'moirae-core';
import { deriveModel } from '../src/trace/model';
import { parseJsonl } from '../src/trace/parse';

// The trace ananke's deterministic simulator writes for its echo scenario, seed 42:
// three nodes under drops, delays, clock skew, a partition, a one-way block and a
// crash, exported through crates/moirae-trace (ADR-009). ananke pins this hash in
// sim/tests/echo.rs and the bytes here are that run's output, so this test is the
// "trace opens in the studio" half of ananke's Phase 0 exit criterion, and the two
// repositories can only drift from each other loudly.

const PINNED = '1e45f59f9b66c501';

describe('the ananke echo fixture (format v2, nanoseconds)', () => {
  const text = readFileSync('apps/studio/test/fixtures/echo-42.jsonl', 'utf8');
  const model = deriveModel(parseJsonl(text));

  it('hashes to the value ananke pins', () => {
    expect(hex64(fnv1a64String(text))).toBe(PINNED);
  });

  it('parses as v2 with a nanosecond unit and three nodes', () => {
    expect(model.header.v).toBe(2);
    expect(model.unit).toBe('ns');
    expect(model.nodes).toEqual([1, 2, 3]);
    expect(model.duration).toBeGreaterThan(1_300_000_000);
    expect(model.duration).toBeLessThanOrEqual(1_400_000_000);
  });

  it('shows the traffic, the wall and the crash', () => {
    expect(model.messages.length).toBeGreaterThan(300);
    expect(model.messageTypes).toEqual(['ping', 'pong']);
    expect(model.partitions).toEqual([{ start: 300_000_000, end: 600_000_000, groups: [[1], [2, 3]] }]);
    expect(model.crashes).toEqual([{ node: 3, start: 1_100_000_000, end: 1_100_000_000, restarted: true }]);
    const drops = model.messages.filter((m) => m.drop !== null);
    expect(drops.some((m) => m.drop?.reason === 'partition')).toBe(true);
    expect(drops.some((m) => m.drop?.reason === 'loss')).toBe(true);
    // The sibling of "nothing crossed the wall": messages were sent into it.
    const walled = model.messages.filter((m) => m.send.t > 300_000_000 && m.send.t <= 600_000_000 && m.send.from === 1);
    expect(walled.length).toBeGreaterThan(0);
    expect(walled.every((m) => m.drop?.reason === 'partition')).toBe(true);
  });

  it('carries no role field, so the legend says so instead of colouring lanes', () => {
    expect(model.conventions).toEqual({ role: false, term: false });
  });
});
