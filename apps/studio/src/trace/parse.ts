// JSONL trace parsing (SPEC §5). The studio is a pure function of this file:
// anything it needs, it derives from here. Errors name the line, because a
// trace usually arrives from someone else's machine.

import type { TraceEvent, TraceHeader } from 'moirae-core';

export interface ParsedTrace {
  readonly header: TraceHeader;
  readonly events: readonly Exclude<TraceEvent, TraceHeader>[];
}

export class TraceParseError extends Error {
  constructor(
    readonly line: number,
    message: string,
  ) {
    super(`line ${line}: ${message}`);
    this.name = 'TraceParseError';
  }
}

// SPEC §5 (v2): an integer outside JavaScript's safe range is written as its decimal
// digits in a string. Wherever the format defines an integer, accept either, and read a
// string as the nearest double: the studio orders and draws by these values and never
// needs their low bits.
const INTEGER_STRING = /^-?\d+$/;

function integer(value: unknown): number | undefined {
  if (typeof value === 'number') return Number.isInteger(value) ? value : undefined;
  if (typeof value === 'string' && INTEGER_STRING.test(value)) return Number(value);
  return undefined;
}

// The integer positions of an event line, normalised in place; `groups` holds node ids.
const INTEGER_FIELDS = ['t', 'seq', 'node', 'from', 'to', 'msgId'] as const;

function normaliseIntegers(e: Record<string, unknown>, line: number): void {
  for (const field of INTEGER_FIELDS) {
    if (!(field in e)) continue;
    const n = integer(e[field]);
    if (n === undefined) throw new TraceParseError(line, `${field} must be an integer, got ${JSON.stringify(e[field])}`);
    e[field] = n;
  }
  if ('groups' in e) {
    const groups = e['groups'];
    if (!Array.isArray(groups)) throw new TraceParseError(line, 'groups must be an array');
    e['groups'] = groups.map((group) => {
      if (!Array.isArray(group)) throw new TraceParseError(line, 'each group must be an array of node ids');
      return group.map((id) => {
        const n = integer(id);
        if (n === undefined) throw new TraceParseError(line, `node id must be an integer, got ${JSON.stringify(id)}`);
        return n;
      });
    });
  }
}

export function parseJsonl(text: string): ParsedTrace {
  const lines = text.split('\n');
  if (lines.at(-1) === '') lines.pop();
  if (lines.length === 0) throw new TraceParseError(1, 'empty file');

  const parseLine = (i: number): Record<string, unknown> => {
    const raw = lines[i] as string;
    let value: unknown;
    try {
      value = JSON.parse(raw);
    } catch {
      throw new TraceParseError(i + 1, 'not valid JSON');
    }
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      throw new TraceParseError(i + 1, 'expected a JSON object');
    }
    return value as Record<string, unknown>;
  };

  const first = parseLine(0);
  if (first['kind'] !== 'header') {
    throw new TraceParseError(1, `expected the header line, got kind ${JSON.stringify(first['kind'])}`);
  }
  const v = first['v'];
  if (v !== 1 && v !== 2) {
    throw new TraceParseError(1, `unsupported trace format version ${JSON.stringify(v)}; this studio reads v1 and v2`);
  }
  // v2 (SPEC §5): the header says what `t` counts in; a missing unit is milliseconds.
  if ('unit' in first && first['unit'] !== 'ms' && first['unit'] !== 'ns') {
    throw new TraceParseError(1, `unknown time unit ${JSON.stringify(first['unit'])}; expected "ms" or "ns"`);
  }
  const seed = integer(first['seed']);
  const nodes = integer(first['nodes']);
  if (seed === undefined || nodes === undefined) {
    throw new TraceParseError(1, 'header must carry integer seed and nodes');
  }
  first['seed'] = seed;
  first['nodes'] = nodes;
  const header = first as unknown as TraceHeader;

  const events: Exclude<TraceEvent, TraceHeader>[] = [];
  for (let i = 1; i < lines.length; i++) {
    const e = parseLine(i);
    if (typeof e['kind'] !== 'string') throw new TraceParseError(i + 1, 'event has no kind');
    if (e['kind'] === 'header') throw new TraceParseError(i + 1, 'a second header line');
    if (integer(e['t']) === undefined || integer(e['seq']) === undefined) {
      throw new TraceParseError(i + 1, `${e['kind']} event without numeric t and seq`);
    }
    normaliseIntegers(e, i + 1);
    events.push(e as unknown as Exclude<TraceEvent, TraceHeader>);
  }
  return { header, events };
}
