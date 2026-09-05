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
  if (typeof first['nodes'] !== 'number' || typeof first['seed'] !== 'number') {
    throw new TraceParseError(1, 'header must carry numeric seed and nodes');
  }
  const header = first as unknown as TraceHeader;

  const events: Exclude<TraceEvent, TraceHeader>[] = [];
  for (let i = 1; i < lines.length; i++) {
    const e = parseLine(i);
    if (typeof e['kind'] !== 'string') throw new TraceParseError(i + 1, 'event has no kind');
    if (e['kind'] === 'header') throw new TraceParseError(i + 1, 'a second header line');
    if (typeof e['t'] !== 'number' || typeof e['seq'] !== 'number') {
      throw new TraceParseError(i + 1, `${e['kind']} event without numeric t and seq`);
    }
    events.push(e as unknown as Exclude<TraceEvent, TraceHeader>);
  }
  return { header, events };
}
