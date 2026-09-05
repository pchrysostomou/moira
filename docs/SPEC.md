# moirae — SPEC (v0)

Status: draft. This document defines what v0 is and, more importantly, what it is not.

## 1. Goal

A protocol author should be able to write this:

```ts
class Raft implements Process<RaftState> { /* onInit, onMessage, onTimer */ }
```

run this:

```ts
const result = simulate({
  seed: 0xC0FFEE,
  nodes: 5,
  process: Raft,
  network: { latency: [10, 50], dropRate: 0.02, partitions: schedule },
  invariants: [atMostOneLeaderPerTerm],
  until: { simTime: 60_000 },
});
```

and, when it fails, get this:

```
✗ invariant violated: atMostOneLeaderPerTerm
  at simTime=13480, step=8842
  nodes 2 and 4 both leader in term 7
  replay: moirae replay --seed 0xC0FFEE --trace out/0xC0FFEE.jsonl
```

## 2. Non-goals for v0

Byzantine behaviour. Trace shrinking. Modelling CPU time (event handlers are instantaneous).
Real sockets. Disk model. Multiple protocols — v0 ships Raft only. Editing traces in the UI.

## 3. Core interfaces

```ts
type NodeId = number;
type SimTime = number;            // logical milliseconds since t=0

interface Ctx<S> {
  readonly me: NodeId;
  readonly peers: readonly NodeId[];
  state: S;

  now(): SimTime;                 // logical clock, never wall clock
  random(): number;               // [0,1), from the per-node seeded PRNG
  randomInt(min: number, max: number): number;   // integer in [min, max]; exactly one draw of random()

  send(to: NodeId, msg: Message): void;
  broadcast(msg: Message): void;

  setTimer(name: string, delayMs: number): void;   // replaces an existing timer of the same name
  cancelTimer(name: string): void;

  log(event: string, data?: Record<string, unknown>): void;
  crash(): void;                  // self-crash; state is lost unless marked persistent
}

interface Process<S> {
  persistent?: readonly (keyof S)[];   // top-level state fields that survive a crash
  init(ctx: Ctx<S>): S;
  onMessage(ctx: Ctx<S>, from: NodeId, msg: Message): void;
  onTimer(ctx: Ctx<S>, name: string): void;
  onRestart?(ctx: Ctx<S>, persisted: Partial<S>): void;
}
```

A process may only observe the world through `ctx`. Reading another node's state from inside a
process is not prevented by the type system in v0 — it is prevented by review, and it is the one
thing that makes a protocol implementation worthless.

**Persistence.** A process declares which top-level state fields survive a crash with
`persistent`; everything else is lost. On restart the engine runs `init` again for a fresh state,
overlays the persisted fields onto it, then calls `onRestart` with them. The crash event in the
trace lists which fields survived and which were lost.

**Limitation, on the record.** State is snapshotted at the crash event. Handlers are instantaneous
(§2), so there is no crash point inside a handler, and intra-handler write ordering is not
modelled: a handler that replies and then updates a persistent field is indistinguishable from one
that does it the other way round. The "responded before persisting" bug class is therefore
unobservable in v0. Testing it requires crash points inside handlers, which is a future phase and
a breaking change to this API when it lands. The declarative list was chosen over a
`ctx.persist(key)` call precisely so the API does not suggest that write ordering is being tested
when it is not.

## 4. The scheduler

A single-threaded loop over a priority queue of events, ordered by `(time, sequence)`.
`sequence` is a monotonic counter assigned at insertion; it is the tiebreaker that makes ordering
total and therefore reproducible. Ties must never be broken by object identity, insertion into a
`Map`, or anything the JS engine chooses for us.

Event kinds: `Deliver`, `Timer`, `Crash`, `Restart`, `PartitionStart`, `PartitionEnd`.

One step = pop one event, dispatch it, append the resulting effects to the queue, run invariants.
The loop terminates on: `until.simTime` reached, `until.steps` reached, queue empty, or an
invariant violation.

Every draw from the PRNG happens in the engine, in a fixed order per step. Per-node PRNGs are
derived from the root seed as `hash(rootSeed, nodeId)` so that adding a node does not reshuffle
the random stream of existing nodes.

PRNG: a small, self-contained xoshiro128** or PCG32. Written in-repo, not a dependency (ADR-004).
The engine exports the PRNG (`Pcg32`) and the trace hash (`fnv1a64String`, `hex64`) for tests
and tooling: the Raft fuzz test derives each seed's fault schedule from the PRNG, so a failing
seed reproduces exactly.

## 5. Trace format

Append-only JSONL. One object per event. This file is the interface between the engine and every
consumer — CLI output, the studio UI, future tooling.

```jsonc
{"kind":"header","v":2,"seed":12648430,"nodes":5,"unit":"ms"}
{"t":0,    "seq":0, "kind":"init",      "node":1}
{"t":150,  "seq":42,"kind":"send",      "from":1,"to":3,"msgId":88,"msg":{"type":"RequestVote","term":2}}
{"t":183,  "seq":43,"kind":"deliver",   "msgId":88}
{"t":183,  "seq":44,"kind":"drop",      "msgId":89,"reason":"partition"}
{"t":183,  "seq":45,"kind":"state",     "node":3,"patch":{"role":"follower","term":2}}
{"t":190,  "seq":46,"kind":"deliver",   "msgId":88,"dup":true}
{"t":200,  "seq":50,"kind":"timer",     "node":1,"name":"election"}
{"t":200,  "seq":51,"kind":"log",       "node":1,"event":"election-started","data":{"term":3}}
{"t":300,  "seq":70,"kind":"fault",     "fault":"crash","node":2,"cause":"schedule","persisted":["currentTerm","votedFor","log"],"lost":["role","leaderId"]}
{"t":450,  "seq":80,"kind":"fault",     "fault":"restart","node":2}
{"t":900,  "seq":91,"kind":"fault",     "fault":"partition","groups":[[1,2],[3,4,5]]}
{"t":1200, "seq":95,"kind":"fault",     "fault":"heal","groups":[[1,2],[3,4,5]]}
{"t":1340, "seq":99,"kind":"violation", "invariant":"atMostOneLeaderPerTerm","detail":"..."}
```

Rules: `state` events carry patches, not full snapshots — the viewer reconstructs by folding.
A patch holds the changed top-level state fields; a field deleted from the state appears as
`null`. `ctx.log(event, data?)` emits `log` events. Node ids are 1-based (`1..nodes`). `msgId`
is assigned at send and is how send/deliver/drop are correlated. The header line records the
trace format version, seed, node count, network config and moirae version so a trace is
self-describing.

Every line is readable without the source that produced it (ADR-003). `drop.reason` is `loss`
(random loss), `partition` (crossed a partition boundary at send time) or `crashed` (destination
was down at delivery time). A duplicated message's extra copy is a `deliver` line with
`dup: true`; the original carries no flag, so a consumer can tell a duplicate from a repeated
line. `fault` events are `crash` (with `cause`: `self` for `ctx.crash()` or `schedule`, plus the
`persisted` and `lost` field lists), `restart`, `partition` (the groups) and `heal` (the groups
that just ended). The header's `network` field is present only when a network was configured;
absent means immediate, lossless delivery.

**Format version 2.** The header carries `unit`, what `t` counts in: `ms` for this engine, `ns`
for a foreign engine such as ananke, whose virtual clock is nanoseconds and whose runs outlive
the precision a float millisecond would keep. A reader treats a missing `unit` — every v1 trace —
as `ms`, and a v2 reader accepts v1. `crash` events may omit `persisted` and `lost`, which
describe this engine's declared-state model, when the emitting engine has none. `drop.reason`
gains `queue-full`: the sender's bounded per-destination queue overflowed and the oldest frame
was discarded; this engine never emits it. A foreign engine namespaces its `log` event names
`<engine>.<topic>`, for example `ananke.task.polled`; a protocol's `ctx.log` names stay
unprefixed. `seq`, `msgId` and node ids are unchanged. The Rust writer in `crates/moirae-trace`
(ADR-009) emits v2 only and is held to these bytes by committed fixtures.

A trace is a byte stream, not a text document. Lines end in `\n` (LF) on every platform, and the
acceptance criterion of byte-identical traces (§10.1) is a hash over those exact bytes. To keep
git from silently breaking this: the repo's `.gitattributes` forces `eol=lf` for all text files
and marks `*.jsonl` (traces and trace fixtures) as `-text` so git never rewrites them, and any
formatter configuration must set line endings to LF. A trace fixture that has been CRLF-converted
is corrupt even though it looks identical in an editor.

## 6. Network model

```ts
class DefaultNetwork {
  // Called once per send. All randomness via the engine's dedicated network PRNG stream.
  route(msg: InFlight, rng: Rng, now: SimTime): Routing;
}
type Routing =
  | { kind: 'drop'; reason: 'loss' | 'partition' }
  | { kind: 'deliver'; deliveries: { at: SimTime; dup: boolean }[] };
```

`DefaultNetwork` is the only network model, so it is a concrete class rather than an interface;
an interface is extracted when a second model actually exists. Deviation from the original
sketch (`Delivery[]`, empty for dropped): a drop carries its reason, because the trace records it.

Configuration: `latency: [min, max]` (integer milliseconds, uniform, inclusive), `dropRate` and
`duplicateRate` (probabilities), and `partitions` — hard partitions defined as a list of disjoint
node groups covering every node, each with a start and end time (active for `start <= t < end`),
not overlapping in time. Whether a message crosses a partition boundary is decided at send time;
such messages are dropped, not delayed. With no `network` configured, delivery is immediate and
lossless and no network randomness is drawn at all.

Randomness comes from a dedicated stream (sequence selector 0; nodes use 1..n) so network
behaviour never perturbs a protocol's draws, and is drawn in a fixed order per send: drop, then
duplicate, then one latency per delivery. A partition drop is decided before any draw. That order
is part of the byte format — changing it changes every trace.

**Lognormal latency is deliberately not offered.** Sampling it needs `Math.log`, `Math.sqrt` and
`Math.cos` (or `Math.exp`), and ECMAScript does not specify those functions bit-exactly: engines
may legitimately differ in the last bit. One such draw feeding a delivery time would turn
byte-identical traces across engines (§10.1) into a matter of luck rather than construction.
Uniform latency is pure integer arithmetic. Do not add a lognormal option without a deterministic
in-repo approximation that is itself proven bit-exact across the CI matrix.

## 7. Invariants

```ts
interface Invariant<S> {
  name: string;
  every?: number;                              // check every n steps; default 1
  check(world: WorldView<S>): string | null;   // null = holds, string = violation detail
}

interface WorldView<S> {
  time: SimTime;
  step: number;
  nodes: { id: NodeId; crashed: boolean; state: S | null }[];   // ascending by id; null while crashed
  trace: TraceEvent[];                                            // the history so far
}
```

`WorldView` is a deep-frozen copy of every node's state (a copy, so the protocol stays free to
mutate its own), the crashed set, current simTime, and the event history so far (shared with the
engine and read-only). Invariants run after init (step 0) and after every step by default;
expensive ones can declare `every: n` steps. The first violation emits a `violation` event and
ends the run; `simulate()` reports it.

v0 ships, in `packages/protocols`, the Figure 3 checkers `electionSafety`, `logMatching` and
`stateMachineSafety` — see `docs/RAFT.md` for why a fuzz gate needs the third.

## 8. Fuzzing

`moirae fuzz --seeds 10000 --protocol raft` runs the same scenario across N seeds, in parallel
worker threads (the engine is single-threaded per run, so this parallelises trivially), and
reports every violating seed with the step at which it broke. Each failure prints a one-line
replay command. Shrinking is v1.

## 9. Studio

Vite + React. Loads a `.jsonl` trace via file picker or URL. Renders:

- one horizontal lane per node, time on the x-axis
- messages as arcs from sender lane to receiver lane; dropped messages as arcs that stop short
- partitions as shaded bands across the affected lanes
- a scrubber; the state panel shows each node's folded state at the playhead
- clicking a message highlights its send and deliver events

The studio imports the trace schema type and nothing else from the engine (ADR-003); a lint rule
in `eslint.config.mjs` makes that mechanical. It runs no simulation. A trace reaches it as a
dropped or picked file, as `?trace=URL`, or as a string in `window.__MOIRAE_TRACE__` for
single-file exports; `?t=` sets the playhead, in the trace's time unit. In development the server serves the repo's
`out/` directory, where `pnpm examples` writes the example traces.

**Display conventions.** The studio is protocol-agnostic and knows nothing about Raft; the trace
gives it only generic `state` patches. So two conventions do the work of colouring the picture:

- A top-level state field named `role` (a string) colours the node's lane. Fixed palette:
  `leader` blue, `candidate` amber, `follower` grey — and, in the same hues, `learned` blue,
  `proposing` amber, `idle` grey for protocols where nobody leads (Paxos, PAXOS.md C9); any
  other value gets a neutral colour and its raw name. A field named `currentTerm` (or `term`, a number) labels each stretch of a lane.
- If a trace has no `role` field, the studio says so in the legend — *"this trace has no
  top-level `role` field, so lanes aren't coloured by state; see SPEC §9"* — rather than showing
  grey lanes and letting the viewer conclude the tool is broken. Likewise for a missing term.

Reason: protocol authors name their state as they like, and the studio must not import a
protocol to find out what the names mean; a naming convention costs an author nothing and keeps
the viewer a pure function of the file. **Upgrade path**, should a contributed protocol
genuinely not be able to satisfy the naming: a protocol-emitted role-change trace event (a new
`kind`), which is a trace-format change and needs a format version bump.

Message types get plain-language legend labels from a small lookup table in
`apps/studio/src/trace/labels.ts` (`RequestVote` → "asking for votes"), falling back to the raw
`msg.type`. It is data, not logic. Vote traffic is drawn loud and everything else quiet, so an
election reads at a glance; a dropped message stops short — at the partition wall when the wall
is what stopped it.

## 10. Acceptance criteria for v0

1. `simulate()` with a fixed seed produces a byte-identical trace across runs, machines and
   Node versions. Enforced in CI by hashing.
2. A 5-node Raft cluster elects exactly one leader and replicates entries under a lossy network.
3. Under a `[1,2] | [3,4,5]` partition, the minority side elects no leader; after healing, the
   cluster converges to one leader and consistent logs.
4. `fuzz --seeds 1000` completes in under two minutes on a laptop.
5. The studio replays the partition scenario and the split is visible without reading any code.
