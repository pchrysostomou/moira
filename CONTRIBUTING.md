# Contributing to moirae

The claim this project makes is that when something breaks, you know why: the failure is a seed
that reproduces it exactly and a trace you can scrub through. Everything below follows from that
claim. One plausible-but-wrong protocol implementation destroys it, because the failures it
produces look like engine bugs, and nobody can tell the difference from the outside.

## Most changes get ordinary review

Fault injection, invariants, the studio, the CLI, docs, bug fixes, typos: open a pull request.
Every commit in it must pass `pnpm typecheck && pnpm lint && pnpm test` on its own — not just the
last one — because the history is bisectable and single-commit reverts must work anywhere. Pull
requests are merged without squashing, so the commits you write are the commits that land.

That is the whole bar for everything except protocols. The rest of this document is about
protocols.

## Protocols come from published papers

A protocol accepted into `packages/protocols` is a transcription of a published algorithm — a
paper, a thesis, a specification with a citation. Not for purity. A protocol with a paper can be
reviewed against a specification: each handler can be checked against the rule it claims to
implement, and a disagreement has a referee. A protocol without one can only be reviewed against
the author's intuition and the maintainer's, and that is not review; it is two people agreeing.

Original or unpublished algorithms are welcome as a fork, or as a discussion issue about the
algorithm. They are not accepted as a merge. This produces fewer protocols and correct ones, and
that is the trade.

## How to write a protocol implementation that is actually right

This is the bar a protocol pull request is held to. It is also, in order, how you write one that
is right — the Raft implementation was written this way, and following it is the reason to do the
work, not the gate you clear to get merged.

1. **Start from the paper and write the notes first.** `docs/<PROTOCOL>.md`, in the shape of
   [`docs/RAFT.md`](docs/RAFT.md): what is in scope, persistent versus volatile state, the rules of
   this protocol that are classically implemented wrong, its safety properties, and the scenarios
   that must pass. Where your notes and the paper disagree, the paper wins, and the notes say so.

2. **Every handler cites the section it implements.** A comment on the handler, in the form
   `// §5.4.1 — election restriction`. A handler that cannot say which rule it implements is
   probably implementing an opinion.

3. **For each classically-wrong rule, write the test before the handler, and show it failing
   against the naive form first.** The pull request includes that red output. Where the rule's
   absence fails trivially, write the wrong version on purpose and fail against that. The Raft
   pull request is the worked example: ten such tests, each run red against its naive form before
   the correct handler existed. Its Figure 8 test — the commit rule that loses committed entries if
   you count replicas from an earlier term — failed twice for the *wrong* reasons before it failed
   for the right one, and each wrong failure was a bug in the test, not the code. If a test of a
   subtle rule passes on your first attempt, assume the test is wrong before assuming the code is
   right.

4. **At least one safety invariant**, typed on your protocol's state, in
   `packages/protocols/src/<name>/invariants.ts`. Choose one that catches data loss, not one that
   is merely true. Raft's Election Safety and Log Matching both hold while the Figure 8 sequence
   overwrites a committed entry; only State Machine Safety sees it. An invariant that cannot see the
   failure your protocol is famous for is not the one to ship first.

5. **At least one `simulate()` scenario under faults** — latency, loss, a partition, a crash with
   restart — with its trace hash pinned in a test, so an engine change that alters the run fails
   the build instead of silently changing the story. And a fuzz run: 200 seeds in CI as a floor,
   1,000 before a release, with loss, random partition schedules and crashes. Those are Raft's
   numbers, and they are worth knowing what they are for: the rule tests are the correctness
   argument; the fuzz is what says the implementation survives contact with the engine. A protocol
   with a larger state space needs more seeds than Raft does, and someone who understands the
   distinction will pick them.

6. **Every negative assertion carries its positive sibling.** A test that says something did not
   happen must also show it could have. This project learned that three times before writing it
   down; the essay [A negative claim is satisfied by an empty stage](docs/writing/negative-assertions.md)
   is the short version, and the rule is in [`CLAUDE.md`](CLAUDE.md) with the incidents attached.

7. **Nothing in `packages/protocols` touches an ambient source.** No `Date`, no `Math.random`, no
   timers, no filesystem, no `globalThis`. Lint enforces this and inline disables are dead in that
   directory, but it is worth saying anyway: time is `ctx.now()`, randomness is `ctx.random()` or
   `ctx.randomInt(min, max)`, scheduling is `ctx.setTimer()`. There is no other way, and if you
   find yourself wanting one, see the last section.

8. **Deviations from the paper are named**, in the notes, with the reason and the test that makes
   the deviation safe. RAFT.md's D1 — the follower echoing the matched index in its response — is
   the shape: what the paper says, what this implementation does instead, why, and the replay test
   that proves the property the deviation rests on.

9. **Name the state fields the studio understands.** A top-level `role` string colours a node's
   lane; `currentTerm` (or `term`) labels it. That is the whole convention ([SPEC §9](docs/SPEC.md)),
   and it is what makes your protocol's failures visible without anyone reading your code.

## The interface, and a skeleton to copy

A process sees the world only through `ctx`. [SPEC §3](docs/SPEC.md) is authoritative for `Ctx`;
the process side is this:

```ts
interface Process<S> {
  persistent?: readonly (keyof S)[];   // top-level state fields that survive a crash
  init(ctx: Ctx<S>): S;
  onMessage(ctx: Ctx<S>, from: NodeId, msg: Message): void;
  onTimer(ctx: Ctx<S>, name: string): void;
  onRestart?(ctx: Ctx<S>, persisted: Partial<S>): void;
}
```

The skeleton below is [`examples/src/ping.ts`](examples/src/ping.ts), verbatim. It is a real file —
typechecked and linted under the same rules as the shipped protocols — and CI asserts that this copy,
the README's, and the file are byte-identical, so it cannot go stale. Copy it and replace `Ping`.

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

## Where files go

```
packages/protocols/src/<name>/
  state.ts        the state type and constants, citing the paper's figure
  messages.ts     the RPCs as message types
  <name>.ts       the Process implementation, every handler cited
  invariants.ts   safety properties as engine invariants, typed on the state
packages/protocols/src/index.ts       export the class and the invariants
packages/protocols/test/
  harness.ts                          shared: records sends and timers, delivers on command
  <name>-NN-<rule>.test.ts            one file per classically-wrong rule, red-first
  <name>-scenarios.test.ts            simulate() under faults, with the pinned hash
  <name>-fuzz.test.ts                 the seeds
docs/<NAME>.md                        the notes, in the shape of RAFT.md
```

The harness records sends and timer calls and delivers messages when a test says so. It implements
no engine semantics — no clock, no ordering, no crash, no persistence — on purpose: a test that
passes against a harness that diverges from the engine is worse than no test. Anything that needs
those semantics is a `simulate()` scenario.

## Running the suite

**The gate is one command.** `scripts/gate.sh` runs every check in sequence under
`set -euo pipefail`. No commit is made unless it has exited 0 on the exact tree being
committed, run as that single command, never as separate shell lines whose failures can
be scrolled past. CI runs the same checks.


```
pnpm install
scripts/gate.sh     # the gate every commit passes on its own: pnpm typecheck, lint, test, then cargo fmt, clippy, test, doc
pnpm examples                                 # regenerates the example traces into out/
pnpm --filter @moirae/studio dev              # then open ?trace=/clean-partition.jsonl
pnpm --filter moirae build                    # the CLI: dist/cli.js and the bundled studio
```

## When the interface can't express what you need — and when you think a rule here is wrong

If the paper needs something `ctx` cannot express, open an issue. That is a finding about the
engine, and it is worth more than a workaround: SPEC §3 records one such gap — persistence ordering
inside a handler is not observable in v0 — found while implementing Raft and written down instead
of patched around. Do not reach outside `ctx` to get what you need; the lint will stop you, and if it
does not, the reason it exists is exactly your case.

If you think a rule in this document is wrong, open an issue and argue it. Every rule here has a
reason, and the reasons are written down — in [`docs/DECISIONS.md`](docs/DECISIONS.md), in
[`CLAUDE.md`](CLAUDE.md), and above. A reason that does not survive being argued with should change,
and several of these rules exist because an earlier version of them did not survive contact with
the work.

## Reporting a failure

A bug report is a seed. Include the seed, the scenario, and the trace if you have it;
`npx moirae replay <trace.jsonl>` opens it. If an invariant fired, the violation line in the trace
names the invariant, the step and the time, and that is usually the whole report.
