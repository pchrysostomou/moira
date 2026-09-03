import { describe, expect, it } from 'vitest';
import { compareTags } from '../src/abd/abd';
import type { Tag } from '../src/abd/state';

describe('ABD #2 — deterministic tag ordering', () => {
  it('orders larger counters before smaller counters', () => {
    const older: Tag = { counter: 4, writerId: 1 };
    const newer: Tag = { counter: 5, writerId: 1 };

    expect(compareTags(newer, older)).toBeGreaterThan(0);
    expect(compareTags(older, newer)).toBeLessThan(0);
  });

  it('uses writer id as the deterministic tie-breaker', () => {
    const writer1: Tag = { counter: 7, writerId: 1 };
    const writer2: Tag = { counter: 7, writerId: 2 };

    expect(compareTags(writer2, writer1)).toBeGreaterThan(0);
    expect(compareTags(writer1, writer2)).toBeLessThan(0);
  });

  it('treats identical tags as equal', () => {
    const a: Tag = { counter: 9, writerId: 3 };
    const b: Tag = { counter: 9, writerId: 3 };

    expect(compareTags(a, b)).toBe(0);
  });
});
