import { describe, expect, it } from 'vitest';
import { deriveModel } from '../src/trace/model';
import { TraceParseError, parseJsonl } from '../src/trace/parse';

const HEADER = '{"kind":"header","v":1,"seed":7,"nodes":2}';

function trace(...lines: string[]): string {
  return [HEADER, ...lines].join('\n') + '\n';
}

describe('parseJsonl', () => {
  it('reads the header and the events', () => {
    const parsed = parseJsonl(trace('{"t":0,"seq":0,"kind":"init","node":1}'));
    expect(parsed.header.nodes).toBe(2);
    expect(parsed.events).toHaveLength(1);
  });

  it('names the line on malformed input', () => {
    expect(() => parseJsonl(trace('{"t":0,"seq":0,"kind":"init","node":1}', 'not json'))).toThrow(/line 3: not valid JSON/);
    expect(() => parseJsonl('{"kind":"init"}\n')).toThrow(/line 1: expected the header line/);
    expect(() => parseJsonl('{"kind":"header","v":3,"seed":1,"nodes":1}\n')).toThrow(/unsupported trace format version 3/);
    expect(() => parseJsonl('{"kind":"header","v":2,"seed":1,"nodes":1,"unit":"s"}\n')).toThrow(/unknown time unit "s"/);
  });

  it('reads v1 as milliseconds and v2 by its unit (SPEC §5)', () => {
    expect(deriveModel(parseJsonl(trace())).unit).toBe('ms');
    const v2ms = '{"kind":"header","v":2,"seed":7,"nodes":2,"unit":"ms"}\n';
    expect(deriveModel(parseJsonl(v2ms)).unit).toBe('ms');
    const v2ns = '{"kind":"header","v":2,"seed":7,"nodes":2,"unit":"ns"}\n{"t":1500000000,"seq":0,"kind":"init","node":1}\n';
    const m = deriveModel(parseJsonl(v2ns));
    expect(m.unit).toBe('ns');
    expect(m.duration).toBe(1_500_000_000);
    expect(() => parseJsonl('')).toThrow(TraceParseError);
    expect(() => parseJsonl(trace('{"kind":"init","node":1}'))).toThrow(/line 2: init event without numeric t and seq/);
  });
});

describe('deriveModel', () => {
  it('folds state patches, deleting null fields, and returns null while crashed', () => {
    const m = deriveModel(
      parseJsonl(
        trace(
          '{"t":0,"seq":0,"kind":"state","node":1,"patch":{"a":1,"b":{"x":1}}}',
          '{"t":10,"seq":1,"kind":"state","node":1,"patch":{"a":2,"b":null,"c":"new"}}',
          '{"t":20,"seq":2,"kind":"fault","fault":"crash","node":1,"cause":"schedule","persisted":["a"],"lost":["c"]}',
          '{"t":30,"seq":3,"kind":"fault","fault":"restart","node":1}',
          '{"t":30,"seq":4,"kind":"state","node":1,"patch":{"a":2}}',
        ),
      ),
    );
    expect(m.stateAt(1, 5)).toEqual({ a: 1, b: { x: 1 } });
    expect(m.stateAt(1, 15)).toEqual({ a: 2, c: 'new' });
    expect(m.stateAt(1, 25)).toBeNull();
    expect(m.stateAt(1, 30)).toEqual({ a: 2 }); // the restart's full snapshot, nothing leaks from before
    expect(m.stateAt(2, 5)).toBeNull(); // never initialised
    expect(m.crashes).toEqual([{ node: 1, start: 20, end: 30, restarted: true }]);
  });

  it('builds role intervals from role and term changes, broken by crashes', () => {
    const m = deriveModel(
      parseJsonl(
        trace(
          '{"t":0,"seq":0,"kind":"state","node":1,"patch":{"role":"follower","currentTerm":0}}',
          '{"t":100,"seq":1,"kind":"state","node":1,"patch":{"role":"candidate","currentTerm":1}}',
          '{"t":150,"seq":2,"kind":"state","node":1,"patch":{"role":"leader"}}',
          '{"t":200,"seq":3,"kind":"state","node":1,"patch":{"log":[1]}}',
          '{"t":300,"seq":4,"kind":"fault","fault":"crash","node":1,"cause":"self","persisted":[],"lost":[]}',
          '{"t":400,"seq":5,"kind":"fault","fault":"restart","node":1}',
          '{"t":400,"seq":6,"kind":"state","node":1,"patch":{"role":"follower","currentTerm":1}}',
          '{"t":500,"seq":7,"kind":"log","node":2,"event":"end"}',
        ),
      ),
    );
    expect(m.roles.get(1)).toEqual([
      { start: 0, end: 100, role: 'follower', term: 0 },
      { start: 100, end: 150, role: 'candidate', term: 1 },
      { start: 150, end: 300, role: 'leader', term: 1 },
      { start: 400, end: 500, role: 'follower', term: 1 },
    ]);
    expect(m.duration).toBe(500);
    expect(m.conventions).toEqual({ role: true, term: true });
  });

  it('reports missing conventions instead of guessing', () => {
    const m = deriveModel(parseJsonl(trace('{"t":0,"seq":0,"kind":"state","node":1,"patch":{"count":1}}')));
    expect(m.conventions).toEqual({ role: false, term: false });
    expect(m.roles.get(1)).toEqual([]);
  });

  it('pairs partition and heal into windows, and leaves an unhealed one open to the end', () => {
    const m = deriveModel(
      parseJsonl(
        trace(
          '{"t":100,"seq":0,"kind":"fault","fault":"partition","groups":[[1],[2]]}',
          '{"t":200,"seq":1,"kind":"fault","fault":"heal","groups":[[1],[2]]}',
          '{"t":300,"seq":2,"kind":"fault","fault":"partition","groups":[[1,2]]}',
          '{"t":350,"seq":3,"kind":"log","node":1,"event":"end"}',
        ),
      ),
    );
    expect(m.partitions).toEqual([
      { start: 100, end: 200, groups: [[1], [2]] },
      { start: 300, end: 350, groups: [[1, 2]] },
    ]);
  });

  it('threads send, deliveries (duplicates included) and drops by msgId', () => {
    const m = deriveModel(
      parseJsonl(
        trace(
          '{"t":0,"seq":0,"kind":"send","from":1,"to":2,"msgId":0,"msg":{"type":"Ping"}}',
          '{"t":0,"seq":1,"kind":"send","from":2,"to":1,"msgId":1,"msg":{"type":"Pong"}}',
          '{"t":5,"seq":2,"kind":"deliver","msgId":0}',
          '{"t":7,"seq":3,"kind":"deliver","msgId":0,"dup":true}',
          '{"t":9,"seq":4,"kind":"drop","msgId":1,"reason":"loss"}',
        ),
      ),
    );
    expect(m.messages).toHaveLength(2);
    expect(m.byMsgId.get(0)?.delivers.map((d) => d.t)).toEqual([5, 7]);
    expect(m.byMsgId.get(0)?.drop).toBeNull();
    expect(m.byMsgId.get(1)?.drop?.reason).toBe('loss');
    expect(m.messageTypes).toEqual(['Ping', 'Pong']);
  });
});
