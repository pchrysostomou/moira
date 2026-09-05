import { expect, it } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { fnv1a64String, hex64 } from 'moirae-core';
import * as clean from '../src/clean-partition';
import * as harsh from '../src/harsh';

// The example traces are the record; the files themselves stay gitignored.
// Each run must hold every invariant and hash to its pinned value. A future
// engine or Raft change that silently alters either trace fails here — if the
// change was deliberate, update the hash in the same commit and say why.
const PINNED: Record<string, string> = {
  [clean.name]: 'e3167d5c9bb27370',
  [harsh.name]: '7129757583541c3f',
};

for (const example of [clean, harsh]) {
  it(`${example.name}: no violation, trace hash pinned, trace written to out/`, () => {
    const result = example.run();
    expect(result.violation).toBeNull();
    // Written before the hash assertion so a mismatch leaves the new trace
    // on disk to diff against the old one.
    mkdirSync('out', { recursive: true });
    writeFileSync(`out/${example.name}.jsonl`, result.jsonl);
    expect(hex64(fnv1a64String(result.jsonl))).toBe(PINNED[example.name]);
  });
}
