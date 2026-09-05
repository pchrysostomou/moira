# CLAUDE.md

Instructions for Claude Code working in this repository. Read this first, every session.

## What this project is

**moirae** is a deterministic simulation testing (DST) framework for distributed systems, plus a
visual replay UI. You write a protocol against a tiny interface, run it under a deterministic
scheduler with injected faults, and when an invariant breaks you get a seed that reproduces the
failure exactly and a timeline you can scrub through.

The differentiator is not the engine — madsim, turmoil and anysystem exist. It is that the engine
is accessible (TypeScript, runs in a browser) and that failures are **visible**. Every decision
should be weighed against those two things.

## The one rule

**Nothing in `packages/core` or `packages/protocols` may touch a nondeterministic source.**

Banned: `Date.now`, `Date` constructor without args, `Math.random`, `setTimeout`, `setInterval`,
`process.hrtime`, `performance.now`, `crypto.randomUUID`, `crypto.getRandomValues`, `fs`, `net`,
`fetch`, `Map`/`Set` iteration where insertion order is not deterministic, and `Object.keys` on an
object built from a non-deterministic order.

Time comes from `ctx.now()`. Randomness comes from `ctx.random()`. Scheduling comes from
`ctx.setTimer()`. There is no other way to get any of them.

The ESLint rule enforcing this is not optional and is never disabled with an inline comment.
If you think you need an exception, stop and ask.

## Protocols come from papers, not from intuition

Anything in `packages/protocols` is a transcription of a published algorithm. It is not a design
task and there is nothing to be creative about.

- Work from the paper and from the protocol's note in `docs/` (e.g. `docs/RAFT.md`). If neither
  covers the case in front of you, stop and ask. Do not fill the gap with something reasonable.
- Every handler carries a comment citing the rule it implements and where it comes from
  (`// Raft §5.4.1 — election restriction`).
- Any deliberate deviation from the paper is stated in the PR description with the reason. An
  undocumented deviation is a bug even if the tests pass.
- "This is how it's usually done" is not a justification. Widely-copied implementations of these
  algorithms are frequently wrong in ways that only appear under partition, which is exactly the
  condition this project exists to test.

A protocol implementation that looks right and breaks under fault injection is worse than no
implementation, because it makes the engine look broken.

## Repo layout

```
packages/core/         engine: clock, queue, PRNG, network, trace, invariants, runner
packages/protocols/    protocol implementations, one directory each
apps/studio/           React trace viewer, read-only, no engine import
docs/                  SPEC.md, DECISIONS.md, protocol write-ups
```

## Working style

- **Plan, then wait.** Before any non-trivial change, write the plan as bullets and wait for "go".
- **Tests before implementation** for anything in `packages/core`.
- **One PR per phase.** Do not bundle unrelated changes.
- **No speculative abstraction.** One implementation means a concrete type, not an interface.
  Interfaces are added when the second implementation actually arrives.
- **No new dependencies without asking.** `packages/core` has zero runtime dependencies (ADR-004).
- **Don't reformat files you didn't otherwise change.**
- If a task is underspecified, ask one question rather than picking a direction and building on it.

## Definition of done for any change

1. `scripts/gate.sh` has exited 0 on the exact tree being committed, run as that single
   command (it runs typecheck, lint, test, then cargo fmt, clippy, test and doc), never
   as separate shell lines whose failures can be missed.
2. The determinism test still passes (same seed → identical trace hash).
3. New engine behaviour has a test that would fail without it.
4. Public API changes are reflected in `docs/SPEC.md`.
5. If it changes a decision recorded in `docs/DECISIONS.md`, add a new ADR that supersedes the
   old one. Never edit an accepted ADR in place.

## Rules learned the hard way

**A negative assertion needs a positive sibling.** A test that asserts something did *not* happen
must also assert that it had the opportunity to happen; otherwise it passes when the scenario is
simply absent. This has cost us twice.

- Phase 3, pattern #7: "replaying an old success response never moves `matchIndex` backwards"
  passed trivially against the naive implementation, which set `matchIndex` from the log length
  and never moved it at all. The test meant nothing until it was shown to fail against the
  unguarded echo — the form a contributor would actually write.
- Phase 5, the clean fixture: "the minority elected no leader inside the partition" passed while
  the minority never even *tried* — the leader happened to be inside the minority and its
  heartbeats kept the other node quiet. The fixture had already passed review. The sibling
  assertion, "the minority attempted at least three elections", is what caught it.

Write the positive sibling in the same test. If you cannot say what "had the opportunity" means
for the thing being denied, the negative assertion is not testing anything.

**Absolute paths in every shell chain.** Working directories persist between commands, and a `cd`
in one chain silently changes the next. A commit gate once ran inside `apps/studio` and failed on
a missing `lint` script. Start every chain with `cd` to the repository root by absolute path (locally `d:/moira`; the folder kept its old name) and
refer to files by absolute path — in CI scripts, in verification loops, in one-off commands alike.

## Things that are deliberately out of scope right now

Byzantine faults, trace shrinking/minimisation, other language bindings, a hosted playground,
distributed execution of the simulator itself, persistence to disk in protocols. Do not build
toward these. They are noted only so you don't "helpfully" prepare for them.
