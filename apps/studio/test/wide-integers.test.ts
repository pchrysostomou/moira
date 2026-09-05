import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { deriveModel } from '../src/trace/model';
import { parseJsonl, TraceParseError } from '../src/trace/parse';

// SPEC §5: an integer past 2^53 travels as its decimal digits in a string. The parity
// fixture carries one inside `data` and one as `t`; the parser must take both, and
// read the `t` as the nearest double so the model can still order and measure by it.
describe('string-encoded integers (SPEC §5)', () => {
  const text = readFileSync('crates/moirae-trace/tests/fixtures/v2-extras.jsonl', 'utf8');
  const parsed = parseJsonl(text);

  it('reads a string t as an integer and passes data through untouched', () => {
    const late = parsed.events.at(-1);
    expect(late?.kind).toBe('timer');
    expect(late?.t).toBe(9007199254740992);
    const recovered = parsed.events.at(-2);
    expect(recovered?.kind === 'log' && recovered.data?.['stop']).toEqual({
      segment: 3,
      offset: 40,
      reason: 'gap',
      expected: 13,
      found: '18014398509482243',
    });
    expect(deriveModel(parsed).duration).toBe(9007199254740992);
  });

  it('accepts strings in every integer position and rejects anything else', () => {
    const header = '{"kind":"header","v":2,"seed":"18446744073709551615","nodes":"2","unit":"ns"}';
    const lines = [
      header,
      '{"t":"1","seq":"0","kind":"send","from":"1","to":"2","msgId":"9007199254740993","msg":{"type":"x"}}',
      '{"t":"2","seq":"1","kind":"fault","fault":"partition","groups":[["1"],["2"]]}',
    ];
    const wide = parseJsonl(lines.join('\n') + '\n');
    expect(wide.header.seed).toBe(18446744073709552000);
    expect(wide.header.nodes).toBe(2);
    expect(wide.events[0]).toMatchObject({ t: 1, seq: 0, from: 1, to: 2, msgId: 9007199254740992 });
    expect(wide.events[1]).toMatchObject({ groups: [[1], [2]] });
    expect(() => parseJsonl([header, '{"t":"1.5","seq":0,"kind":"init","node":1}'].join('\n'))).toThrow(TraceParseError);
    expect(() => parseJsonl([header, '{"t":1,"seq":0,"kind":"init","node":"one"}'].join('\n'))).toThrow(/node must be an integer/);
  });
});
