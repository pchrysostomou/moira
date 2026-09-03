<p align="center">
  <img src="docs/moirae-demo.gif" width="800" alt="Five Raft nodes on a timeline. A partition cuts two of them off; they turn amber again and again trying to elect a leader, every vote request dies at the wall, and they never turn blue. The other three keep their leader. When the wall lifts, one election settles it.">
</p>

# moirae

You just watched five Raft nodes lose their network for two seconds. The two on the wrong side of
the wall tried twelve times to elect a leader and never could — every vote request died at the
wall. The three on the right side kept theirs. When the wall came down, one election settled it,
and a node that crashed came back with its log intact.

This is v0: three protocols (Raft, single-decree Paxos and the ABD atomic register), no trace
shrinking, no Byzantine faults, no membership changes, no pre-vote, nothing hosted. If you
arrived expecting Antithesis, this is the small, readable TypeScript end of that idea — not a
replacement for it.

That run is not a recording of luck. It is seed 19, and it replays byte for byte on your machine:

```
npx moirae demo
```

runs it, prints what happened, writes `moirae-demo.jsonl`, and opens it in the studio. Any trace
opens the same way: `npx moirae replay some-trace.jsonl`.

## What it is

moirae is deterministic simulation testing for distributed systems, in TypeScript. You write a
protocol against a small interface, run it under a deterministic scheduler with injected faults —
latency, loss, duplication, partitions, crashes — and when an invariant breaks you get a seed that
reproduces the failure exactly, and a trace you can scrub through.

The engine is small and has no dependencies. Raft ships as the proof that the interface is enough:
a transcription of the paper, with each of the ten classically mis-implemented rules tested
against its naive form, including the Figure 8 sequence. Single-decree Paxos and the ABD atomic
register sit beside it, built the same way from their papers.

## Write a protocol

```ts
// examples/src/ping.ts — the protocol in the README, kept real: this file is
// typechecked and linted under the same rules as the shipped protocols, and
// CI asserts that the README's copy is identical to it.

import { simulate, type Ctx, type Process, type SimulationResult } from 'moirae-core';

interface State {
  count: number;
  [field: string]: unknown;
}

// Every node pings its first peer on a timer. Time, randomness and timers
// come from ctx, and from nowhere else.
class Ping implements Process<State> {
  init(ctx: Ctx<State>): State {
    ctx.setTimer('tick', ctx.randomInt(10, 30));
    return { count: 0 };
  }
  onTimer(ctx: Ctx<State>): void {
    ctx.state.count++;
    ctx.send(ctx.peers[0] as number, { type: 'ping', n: ctx.state.count });
    ctx.setTimer('tick', 30);
  }
  onMessage(ctx: Ctx<State>): void {
    ctx.state.count++;
  }
}

export function run(): SimulationResult {
  return simulate<State>({
    seed: 0xc0ffee,
    nodes: 3,
    process: Ping,
    until: { simTime: 5_000 },
    network: {
      latency: [10, 50],
      dropRate: 0.02,
      partitions: [{ groups: [[1], [2, 3]], start: 1000, end: 2000 }],
    },
    faults: { crashes: [{ node: 2, at: 2500, restartAt: 3000 }] },
    invariants: [
      {
        name: 'countNeverNegative',
        check: (world) => (world.nodes.some((n) => n.state !== null && n.state.count < 0) ? 'negative' : null),
      },
    ],
  });
}

// run().violation is null, or { invariant, detail, step, time } — and the seed
// above reproduces it. run().jsonl is the trace: `npx moirae replay` opens it.
```

A process sees the world only through `ctx`. There is no other way to get the time, a random
number, or a timer, and a lint rule keeps it that way.

## Architecture

Three pieces, and a file between them.

```
   you write                  moirae runs                                 you look
+------------------+     +------------------------------------+     +--------------------+
|  Process         | --> |  engine  (moirae-core)             | --> |  trace.jsonl       | --> studio:
|    init          |     |    clock, (time, seq) event queue, |     |    one event per   |     scrub it,
|    onMessage     |     |    PRNG, network model, faults,    |     |    line; versioned |     or write
|    onTimer       |     |    invariants                      |     |    the contract    |     your own
+------------------+     +------------------------------------+     +--------------------+
```

- **Engine** — [`packages/core`](packages/core), published as `moirae-core`: the clock, the
  `(time, seq)` event queue, the PRNG, the network model, fault injection and invariant checking.
  Zero dependencies.
- **Protocols** — [`packages/protocols`](packages/protocols), `moirae-protocols`: `Process`
  implementations. Raft, single-decree Paxos and the ABD register today, each transcribed from
  its paper ([`docs/RAFT.md`](docs/RAFT.md), [`docs/PAXOS.md`](docs/PAXOS.md),
  [`docs/ABD.md`](docs/ABD.md)).
  [`examples`](examples) holds the fixed scenarios, with their trace hashes pinned in CI, and the
  sample above.
- **Studio** — [`apps/studio`](apps/studio): a pure function of a trace file. It imports one type
  from the engine and nothing else.

The data flow is `simulate()` → `trace.jsonl` → studio, and **the trace file is the contract**:
versioned JSONL, one self-describing event per line. Anyone can write another viewer against it,
or replace the engine behind it, without touching the other side.

- The interfaces, precisely: [`docs/SPEC.md`](docs/SPEC.md).
- Why TypeScript, and why the engine has zero dependencies: [`docs/DECISIONS.md`](docs/DECISIONS.md)
  (ADR-001 and ADR-004).

## Reading

- [A negative claim is satisfied by an empty stage](docs/writing/negative-assertions.md) — why a
  test that asserts something did not happen must also prove it could have, through three cases
  from this project.
- [Devlog](docs/devlog.md) — what broke while building this, phase by phase, and what each break
  changed.

## Determinism, enforced

Same seed, same trace, byte for byte — across runs, machines and Node versions. CI hashes the
example traces on Node 20, 22 and 24 on every push; an engine change that alters a single byte
fails the build. When a fuzz run finds a violation, the seed is the whole bug report.

Apache-2.0.
