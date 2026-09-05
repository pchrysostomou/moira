import { describe, expect, it } from 'vitest';
import { clean } from '@moirae/examples';
import { summarize } from '../src/summary';

describe('summarize', () => {
  it('tells the clean scenario in order and reports convergence', () => {
    const text = summarize(clean.run().jsonl);
    const lines = text.split('\n');
    expect(lines[0]).toMatch(/^seed 19, 5 nodes, 6\.00s of simulated time, \d+ trace events$/);
    expect(text).toMatch(/node 5 became leader \(term 1\)/);
    expect(text).toMatch(/1\.50s {2}partition \[\[1,2\],\[3,4,5\]\]/);
    expect(text).toMatch(/3\.50s {2}partition healed/);
    expect(text).toMatch(/node 3 crashed \(kept \["currentTerm","votedFor","log"\]\)/);
    expect(text).toMatch(/node 3 restarted/);
    expect(text).toMatch(/\d+ messages sent, \d+ delivered \(0 duplicates\), \d+ lost \(\d+ loss, \d+ partition, \d+ crashed\)/);
    expect(text).toMatch(/node 1: leader, term 10, 40 log entries, 40 committed, 40 applied/);
    expect(text).toMatch(/every live node applied the same sequence$/);
    // The sibling of "no violation": the story actually happened.
    const partitionIdx = lines.findIndex((l) => l.includes('partition [[1,2]'));
    const healIdx = lines.findIndex((l) => l.includes('partition healed'));
    const leadersInside = lines.slice(partitionIdx, healIdx).filter((l) => l.includes('became leader'));
    expect(leadersInside).toEqual([]);
    expect(text).not.toMatch(/INVARIANT VIOLATED/);
  });

  it('formats time by the header unit (SPEC §5 v2)', () => {
    const ns =
      '{"kind":"header","v":2,"seed":1,"nodes":2,"unit":"ns"}\n' +
      '{"t":1500000000,"seq":0,"kind":"fault","fault":"partition","groups":[[1],[2]]}\n';
    const text = summarize(ns);
    expect(text.split('\n')[0]).toBe('seed 1, 2 nodes, 1.50s of simulated time, 1 trace events');
    expect(text).toMatch(/1\.50s {2}partition \[\[1\],\[2\]\]/);
  });

  it('describes a v2 crash without field lists as just crashed', () => {
    const ns =
      '{"kind":"header","v":2,"seed":1,"nodes":2,"unit":"ns"}\n' +
      '{"t":1100000000,"seq":0,"kind":"fault","fault":"crash","node":2,"cause":"schedule"}\n' +
      '{"t":1100000000,"seq":1,"kind":"fault","fault":"restart","node":2}\n';
    const text = summarize(ns);
    expect(text).toMatch(/1\.10s {2}node 2 crashed\n/);
    expect(text).not.toMatch(/kept/);
    expect(text).toMatch(/1\.10s {2}node 2 restarted/);
  });

  it('refuses a file without a header line', () => {
    expect(() => summarize('{"kind":"init","node":1}\n')).toThrow(/no header line/);
  });
});
