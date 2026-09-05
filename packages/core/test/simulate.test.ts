import { describe, expect, it } from 'vitest';
import { simulate } from '../src/simulate';
import type { Ctx, Message, NodeId, Process } from '../src/types';
import type { DropEvent, SendEvent, StateEvent, TimerEvent } from '../src/trace';

type Bag = Record<string, unknown>;

// Small helper: build a Process from partial handlers.
function proc(handlers: Partial<Process<Bag>> & { init: Process<Bag>['init'] }): new () => Process<Bag> {
  return class implements Process<Bag> {
    init(ctx: Ctx<Bag>): Bag {
      return handlers.init(ctx);
    }
    onMessage(ctx: Ctx<Bag>, from: NodeId, msg: Message): void {
      handlers.onMessage?.(ctx, from, msg);
    }
    onTimer(ctx: Ctx<Bag>, name: string): void {
      handlers.onTimer?.(ctx, name);
    }
  };
}

function events<K extends string>(jsonlTrace: readonly unknown[], kind: K): Bag[] {
  return jsonlTrace.filter((e): e is Bag => (e as Bag).kind === kind);
}

describe('simulate', () => {
  it('starts with a header line recording seed and node count', () => {
    const run = simulate({
      seed: 7,
      nodes: 2,
      process: proc({ init: () => ({}) }),
      until: {},
    });
    expect(run.trace[0]).toEqual({ kind: 'header', v: 2, seed: 7, nodes: 2, unit: 'ms' });
    expect(run.jsonl.endsWith('\n')).toBe(true);
  });

  it('setTimer replaces a live timer of the same name', () => {
    const run = simulate({
      seed: 1,
      nodes: 1,
      process: proc({
        init: (ctx) => {
          ctx.setTimer('tick', 10);
          ctx.setTimer('tick', 25); // replaces the first
          return {};
        },
      }),
      until: {},
    });
    const fired = events(run.trace, 'timer') as unknown as TimerEvent[];
    expect(fired).toHaveLength(1);
    expect(fired[0]?.t).toBe(25);
  });

  it('cancelTimer prevents firing', () => {
    const run = simulate({
      seed: 1,
      nodes: 1,
      process: proc({
        init: (ctx) => {
          ctx.setTimer('doomed', 50);
          ctx.send(ctx.me, { type: 'cancel' }); // self-send, delivered at t=0
          return {};
        },
        onMessage: (ctx) => {
          ctx.cancelTimer('doomed');
        },
      }),
      until: {},
    });
    expect(events(run.trace, 'timer')).toHaveLength(0);
  });

  it('broadcast sends to every peer in ascending id order', () => {
    const run = simulate({
      seed: 1,
      nodes: 4,
      process: proc({
        init: (ctx) => {
          if (ctx.me === 3) ctx.broadcast({ type: 'hello' });
          return {};
        },
      }),
      until: {},
    });
    const sends = events(run.trace, 'send') as unknown as SendEvent[];
    expect(sends.map((s) => s.to)).toEqual([1, 2, 4]);
    expect(events(run.trace, 'deliver')).toHaveLength(3);
  });

  it('messages deliver at the same simTime, after the sending step', () => {
    const run = simulate({
      seed: 1,
      nodes: 2,
      process: proc({
        init: (ctx) => {
          if (ctx.me === 1) ctx.setTimer('go', 40);
          return {};
        },
        onTimer: (ctx) => {
          ctx.send(2, { type: 'ping' });
        },
      }),
      until: {},
    });
    const send = events(run.trace, 'send')[0] as unknown as SendEvent;
    const deliverLine = run.jsonl
      .split('\n')
      .find((l) => l.includes('"deliver"')) as string;
    expect(send.t).toBe(40);
    expect((JSON.parse(deliverLine) as { t: number }).t).toBe(40);
  });

  it('a crashed node receives nothing (drops), fires no timers, sends nothing', () => {
    const run = simulate({
      seed: 1,
      nodes: 2,
      process: proc({
        init: (ctx) => {
          if (ctx.me === 1) {
            ctx.setTimer('never', 10);
            ctx.crash();
            ctx.send(2, { type: 'from-the-grave' }); // ignored: already crashed
          } else {
            ctx.setTimer('poke', 20);
          }
          return {};
        },
        onTimer: (ctx) => {
          ctx.send(1, { type: 'poke' });
        },
      }),
      until: {},
    });
    expect(events(run.trace, 'fault')).toEqual([
      { t: 0, seq: expect.anything() as number, kind: 'fault', fault: 'crash', node: 1, cause: 'self', persisted: [], lost: [] },
    ]);
    expect(events(run.trace, 'send')).toHaveLength(1); // only node 2's poke
    const drops = events(run.trace, 'drop') as unknown as DropEvent[];
    expect(drops).toHaveLength(1);
    expect(drops[0]?.reason).toBe('crashed');
    expect(events(run.trace, 'timer')).toHaveLength(1); // only node 2's
  });

  it('state patches carry changed fields only; a deleted field appears as null', () => {
    const run = simulate({
      seed: 1,
      nodes: 1,
      process: proc({
        init: (ctx) => {
          ctx.setTimer('mutate', 10);
          return { keep: 'same', bump: 0, doomed: true };
        },
        onTimer: (ctx) => {
          ctx.state['bump'] = 1;
          delete ctx.state['doomed'];
        },
      }),
      until: {},
    });
    const patches = events(run.trace, 'state') as unknown as StateEvent[];
    expect(patches).toHaveLength(2);
    expect(patches[0]?.patch).toEqual({ keep: 'same', bump: 0, doomed: true }); // init: full state
    expect(patches[1]?.patch).toEqual({ doomed: null, bump: 1 }); // no 'keep'
  });

  it('nested mutation is detected in the patch', () => {
    const run = simulate({
      seed: 1,
      nodes: 1,
      process: proc({
        init: (ctx) => {
          ctx.setTimer('mutate', 10);
          return { log: [1] };
        },
        onTimer: (ctx) => {
          (ctx.state['log'] as number[]).push(2);
        },
      }),
      until: {},
    });
    const patches = events(run.trace, 'state') as unknown as StateEvent[];
    expect(patches[1]?.patch).toEqual({ log: [1, 2] });
  });

  it('a message mutated after send arrives as it was sent', () => {
    const run = simulate({
      seed: 1,
      nodes: 2,
      process: proc({
        init: (ctx) => {
          if (ctx.me === 1) {
            const msg: Message = { type: 'ping', n: 1 };
            ctx.send(2, msg);
            msg['n'] = 999;
          }
          return { got: 0 };
        },
        onMessage: (ctx, _from, msg) => {
          ctx.state['got'] = msg['n'];
        },
      }),
      until: {},
    });
    const patches = events(run.trace, 'state') as unknown as StateEvent[];
    const nodeTwoFinal = patches.filter((p) => p.node === 2).at(-1);
    expect(nodeTwoFinal?.patch).toEqual({ got: 1 });
  });

  it('until.steps caps the number of dispatched events', () => {
    const run = simulate({
      seed: 1,
      nodes: 1,
      process: proc({
        init: (ctx) => {
          ctx.setTimer('tick', 1);
          return {};
        },
        onTimer: (ctx) => {
          ctx.setTimer('tick', 1); // ticks forever
        },
      }),
      until: { steps: 17 },
    });
    expect(run.steps).toBe(17);
  });

  it('until.simTime stops the clock at the limit', () => {
    const run = simulate({
      seed: 1,
      nodes: 1,
      process: proc({
        init: (ctx) => {
          ctx.setTimer('tick', 100);
          return {};
        },
        onTimer: (ctx) => {
          ctx.setTimer('tick', 100);
        },
      }),
      until: { simTime: 350 },
    });
    expect(run.time).toBe(350);
    const fired = events(run.trace, 'timer') as unknown as TimerEvent[];
    expect(fired.map((f) => f.t)).toEqual([100, 200, 300]);
  });

  it('log events carry the node, the event name and optional data', () => {
    const run = simulate({
      seed: 1,
      nodes: 1,
      process: proc({
        init: (ctx) => {
          ctx.log('born');
          ctx.log('with-data', { answer: 42 });
          return {};
        },
      }),
      until: {},
    });
    const logs = events(run.trace, 'log');
    expect(logs).toHaveLength(2);
    expect(logs[0]).not.toHaveProperty('data');
    expect(logs[1]?.['data']).toEqual({ answer: 42 });
  });

  it('sending to a nonexistent node is a loud error, not a silent drop', () => {
    expect(() =>
      simulate({
        seed: 1,
        nodes: 2,
        process: proc({
          init: (ctx) => {
            ctx.send(9, { type: 'lost' });
            return {};
          },
        }),
        until: {},
      }),
    ).toThrow(/nonexistent node 9/);
  });
});

describe('simulate with a network', () => {
  const pinger = proc({
    init: (ctx) => {
      if (ctx.me === 1) ctx.setTimer('go', 100);
      return {};
    },
    onTimer: (ctx) => {
      ctx.send(2, { type: 'ping' });
    },
  });

  it('records the network config in the header only when one is given', () => {
    const plain = simulate({ seed: 1, nodes: 2, process: pinger, until: {} });
    expect(plain.trace[0]).toEqual({ kind: 'header', v: 2, seed: 1, nodes: 2, unit: 'ms' });
    const net = simulate({
      seed: 1,
      nodes: 2,
      process: pinger,
      until: {},
      network: { latency: [10, 20] },
    });
    expect(net.trace[0]).toEqual({
      kind: 'header',
      v: 2,
      seed: 1,
      nodes: 2,
      unit: 'ms',
      network: { latency: [10, 20] },
    });
  });

  it('delivers after a latency within the configured range', () => {
    const run = simulate({
      seed: 1,
      nodes: 2,
      process: pinger,
      until: {},
      network: { latency: [10, 20] },
    });
    const deliver = run.trace.find((e) => (e as unknown as Bag)['kind'] === 'deliver') as unknown as Bag;
    expect(deliver['t']).toBeGreaterThanOrEqual(110);
    expect(deliver['t']).toBeLessThanOrEqual(120);
  });

  it('marks the duplicate delivery with dup: true and leaves the original unmarked', () => {
    const run = simulate({
      seed: 1,
      nodes: 2,
      process: pinger,
      until: {},
      network: { duplicateRate: 1 },
    });
    const delivers = events(run.trace, 'deliver');
    expect(delivers).toHaveLength(2);
    expect(delivers[0]).not.toHaveProperty('dup');
    expect(delivers[1]?.['dup']).toBe(true);
    expect(delivers[0]?.['msgId']).toBe(delivers[1]?.['msgId']);
  });

  it('records a dropped message as drop with reason loss', () => {
    const run = simulate({
      seed: 1,
      nodes: 2,
      process: pinger,
      until: {},
      network: { dropRate: 1 },
    });
    expect(events(run.trace, 'send')).toHaveLength(1);
    expect(events(run.trace, 'deliver')).toHaveLength(0);
    const drops = events(run.trace, 'drop') as unknown as DropEvent[];
    expect(drops).toHaveLength(1);
    expect(drops[0]?.reason).toBe('loss');
  });
});

describe('simulate with partitions', () => {
  it('drops cross-boundary sends while partitioned and records the fault edges', () => {
    const run = simulate({
      seed: 1,
      nodes: 3,
      process: proc({
        init: (ctx) => {
          if (ctx.me === 1) {
            ctx.setTimer('during', 50);
            ctx.setTimer('after', 100);
          }
          return {};
        },
        onTimer: (ctx) => {
          ctx.broadcast({ type: 'ping' });
        },
      }),
      until: {},
      network: { partitions: [{ groups: [[1, 2], [3]], start: 20, end: 80 }] },
    });
    const faults = events(run.trace, 'fault');
    expect(faults).toEqual([
      { t: 20, seq: expect.anything() as number, kind: 'fault', fault: 'partition', groups: [[1, 2], [3]] },
      { t: 80, seq: expect.anything() as number, kind: 'fault', fault: 'heal', groups: [[1, 2], [3]] },
    ]);
    const drops = events(run.trace, 'drop') as unknown as DropEvent[];
    expect(drops).toHaveLength(1);
    expect(drops[0]?.t).toBe(50);
    expect(drops[0]?.reason).toBe('partition');
    // t=50: 1->2 delivered, 1->3 dropped; t=100: both delivered.
    expect(events(run.trace, 'deliver')).toHaveLength(3);
  });
});

describe('simulate with a crash schedule', () => {
  const restarts: Bag[] = [];

  class Durable implements Process<Bag> {
    persistent = ['term', 'log'] as const;
    init(ctx: Ctx<Bag>): Bag {
      ctx.setTimer('heartbeat', 30);
      return { term: 0, log: [], role: 'follower' };
    }
    onMessage(): void {}
    onTimer(ctx: Ctx<Bag>): void {
      ctx.state['term'] = (ctx.state['term'] as number) + 1;
      (ctx.state['log'] as number[]).push(ctx.now());
      ctx.state['role'] = 'candidate';
      ctx.setTimer('heartbeat', 30);
    }
    onRestart(_ctx: Ctx<Bag>, persisted: Partial<Bag>): void {
      restarts.push({ ...persisted });
    }
  }

  it('a scheduled crash records what survived and what was lost', () => {
    const run = simulate({
      seed: 1,
      nodes: 1,
      process: Durable,
      until: { simTime: 200 },
      faults: { crashes: [{ node: 1, at: 70 }] },
    });
    const faults = events(run.trace, 'fault');
    expect(faults).toEqual([
      {
        t: 70,
        seq: expect.anything() as number,
        kind: 'fault',
        fault: 'crash',
        node: 1,
        cause: 'schedule',
        persisted: ['term', 'log'],
        lost: ['role'],
      },
    ]);
    // Two heartbeats before the crash (30, 60); the node stays down after.
    expect(events(run.trace, 'timer').map((e) => e['t'])).toEqual([30, 60]);
  });

  it('a restart re-inits, overlays the persisted fields and calls onRestart', () => {
    restarts.length = 0;
    const run = simulate({
      seed: 1,
      nodes: 1,
      process: Durable,
      until: { simTime: 200 },
      faults: { crashes: [{ node: 1, at: 70, restartAt: 100 }] },
    });
    const faults = events(run.trace, 'fault');
    expect(faults.map((f) => [f['fault'], f['t']])).toEqual([
      ['crash', 70],
      ['restart', 100],
    ]);
    // The first patch after restart is a full snapshot: fresh role, persisted term/log.
    const patches = events(run.trace, 'state') as unknown as StateEvent[];
    const afterRestart = patches.find((p) => p.t === 100);
    expect(afterRestart?.patch).toEqual({ term: 2, log: [30, 60], role: 'follower' });
    expect(restarts).toEqual([{ term: 2, log: [30, 60] }]);
    // Pre-crash timers died with the node; init set a new one at restart (fires at 130).
    expect(events(run.trace, 'timer').map((e) => e['t'])).toEqual([30, 60, 130, 160, 190]);
  });

  it('crashing an already-crashed node is a no-op, restarting a live node too', () => {
    const run = simulate({
      seed: 1,
      nodes: 1,
      process: Durable,
      until: { simTime: 200 },
      faults: { crashes: [{ node: 1, at: 40, restartAt: 50 }, { node: 1, at: 45 }] },
    });
    expect(events(run.trace, 'fault').map((f) => f['fault'])).toEqual(['crash', 'restart']);
  });

  it('rejects a malformed schedule loudly', () => {
    const bad = (crashes: unknown) => () =>
      simulate({
        seed: 1,
        nodes: 1,
        process: Durable,
        until: { steps: 1 },
        faults: { crashes: crashes as never },
      });
    expect(bad([{ node: 2, at: 1 }])).toThrow(/does not exist/);
    expect(bad([{ node: 1, at: -1 }])).toThrow(/at must be/);
    expect(bad([{ node: 1, at: 10, restartAt: 10 }])).toThrow(/restartAt/);
  });
});
