# docs/ABD.md — implementation notes

Source of truth: Attiya, Bar-Noy, Dolev, *Sharing Memory Robustly in Message-Passing Systems* (1995). This document defines the ABD protocol contract for its Moirae implementation; the paper wins where wording differs.

## 1. Scope for v0

In scope:

- single-writer, multi-reader atomic register;
- strict-majority quorums for read and write completion;
- tagged `(counter, writerId)` register values with deterministic lexicographic ordering;
- mandatory read phase-2 write-back to a quorum before a read completes;
- crashes and restart using Moirae's declared top-level persistence model;
- delayed, duplicated and reordered delivery, plus partitions, under the v0 simulator;
- bounded linearizability checking over completed-operation histories extracted from the simulator trace.

The protocol-level v0 model deliberately assumes reliable message delivery when a communicating path exists. There is no retransmission mechanism yet, so dropped-message liveness is not claimed. Crash, partition and delayed-message scenarios are used to verify safety and quorum-dependent incompleteness; a later retry extension can add lossy-channel liveness as a separate change.

Out of scope:

- multi-writer ABD;
- membership reconfiguration;
- Byzantine faults;
- batching or pipelining;
- crash points inside handlers and persistence-ordering semantics, which SPEC §3 does not model.

## 2. Moirae system model

ABD runs as a `Process<S>` over the v0 `Ctx` interface. Handlers are instantaneous. A quorum is a strict majority: `floor(N / 2) + 1`; any two quorums therefore intersect.

The harness deliberately provides no engine fault semantics. `simulate()` scenarios own crash, restart, partition and delivery scheduling.

## 3. Register and tag model

Each replica stores a `(tag, value)` pair.

```ts
interface Tag {
  readonly counter: number;
  readonly writerId: NodeId;
}

interface RegisterValue<T = string> {
  readonly tag: Tag;
  readonly value: T;
}
```

Tags are compared lexicographically: greater counter wins; equal counters are resolved by greater writer ID. `writerId: 0` is reserved for the initial tag `(0, 0)`. The implementation exposes one `compareTags` function as the canonical ordering relation. The bounded history checker and the reference model deliberately re-implement the relation instead of importing it, so a bug in `compareTags` cannot hide inside its own oracle.

## 4. Single-writer write protocol

The v0 writer is a designated node. Its durable counter increases for each new write.

A write:

1. increments the writer counter;
2. constructs `(counter, writerId)` with the value;
3. applies the tagged value locally and sends it to replicas;
4. waits for acknowledgements from a strict majority;
5. records `write-complete` only after the quorum.

Replicas replace their register only for a strictly greater tag. Equal or older tags are no-ops.

## 5. Read protocol

### Phase 1 — query

The reader queries replicas and waits for a strict majority of distinct responses. It selects the maximum tagged value.

### Phase 2 — mandatory write-back

The reader writes the exact selected `(tag, value)` back to replicas and waits for a strict-majority acknowledgement set before `read-complete`.

The write-back is the essential ABD atomicity step: the selected value becomes present on a quorum before the read returns.

Multiple reads may be in flight; operation IDs isolate their response and acknowledgement state.

## 6. Safety properties

### 6.1 Atomicity

Completed operations must be linearizable: every completed read must return a value consistent with some legal position between its invocation and response, while respecting real-time order of non-overlapping operations.

### 6.2 Completed-write / later-read ordering

If a write completes before a read begins, the read must not return a smaller tag.

### 6.3 Per-replica tag monotonicity

A replica's stored tag never decreases. Reordering and duplication cannot move the register backwards.

### 6.4 Quorum completion

No write or read phase completes without a strict majority of distinct replicas participating in the relevant acknowledgement/response set.

## 7. Bounded history checker

The checker is test infrastructure, not shipped API: `packages/protocols/test/abd-history-checker.ts` provides two pieces:

- `historyFromTrace(trace)` extracts completed ABD operations from `write-start`, `write-complete`, `read-start`, and `read-complete` log events;
- `isLinearizable(history)` performs a bounded backtracking search over possible sequentializations of those completed operations.

The checker enforces:

1. real-time precedence for non-overlapping operations;
2. legal sequential register semantics;
3. read results matching the tag installed at the read's chosen linearization point;
4. omission of incomplete operations from the completed-history decision.

It is intentionally a bounded checker: the cost grows with the number of completed operations. Large fuzz traces should therefore feed a minimized completed history rather than an unbounded global search.

The test suite contains both positive and negative histories, including an explicit stale read after a completed write. This is a semantic check, not merely a structural assertion.

## 8. Classically wrong implementations

### 8.1 Missing read write-back

A reader returning after phase 1 can expose a value from an incomplete write without making that value durable on a quorum. A later reader can then observe an older value, violating atomicity.

### 8.2 Returning before write-back quorum

Sending phase-2 messages is insufficient; the read completion boundary is after a strict-majority acknowledgement set.

### 8.3 Non-deterministic equal-tag ordering

Counter-only comparison cannot deterministically order equal counters in the multi-writer extension. v0 fixes the ordering with writer ID even though only one writer is active.

### 8.4 Non-monotonic replica updates

Older or equal tags must not overwrite newer state.

### 8.5 Incorrect quorum size

The quorum condition is `received * 2 > N`. For three replicas, two distinct participants are required.

### 8.6 Reusing operation IDs after restart

Delayed pre-crash messages can survive restart in the simulator. Reusing an identifier would let stale responses satisfy a new operation, so the allocator is durable.

## 9. Persistence and restart

The register, single-writer counter and operation-id allocator are durable. In-flight read/write bookkeeping is volatile.

```ts
persistent = ['register', 'writeCounter', 'nextOperationId'] as const;
```

The declared simulator model does not expose persistence ordering inside a handler.

## 10. Fault matrix

Safety and liveness are evaluated separately. A quorum-unavailable operation may remain incomplete; that is not a safety violation.

| Fault / schedule | Target | Required observation | Status |
|---|---|---|---|
| duplication | distinct-replica accounting | duplicate response/ack does not advance quorum twice | covered |
| reordering | monotone register | older tag never replaces newer tag | covered |
| finite delay | safety under delayed delivery | completed history remains safe | covered |
| writer-minority partition | quorum liveness gate | no `write-complete` without quorum | covered |
| reader-minority partition | quorum liveness gate | no `read-complete` without quorum | covered |
| partition healing | convergence | later completed reads do not regress | covered |
| crash before write completion | completion honesty | no fabricated completion | covered |
| crash/restart after durable state | persistence boundary | register/counter/allocator survive restart | covered |
| stale post-restart delivery | operation identity | stale message cannot satisfy new operation | covered |
| equal-tag conflicting value | deterministic state | first equal-tag value remains | covered |
| completed-history linearizability | atomic register semantics | checker rejects illegal history and accepts legal overlap | added |

Dropped-message liveness is intentionally not part of v0 because ABD has no retry mechanism. It becomes a valid target only with an explicit retransmission extension.

## 11. Verification strategy

The repository workflow is:

1. red-first conformance tests for the mandatory write-back rule;
2. tag-ordering and quorum tests;
3. history-aware safety invariants;
4. deterministic `simulate()` fault scenarios;
5. deterministic seeded fuzzing;
6. bounded linearizability/history checking;
7. full repository CI and review.

The fuzz campaign uses fixed seeds, partitions and reader crashes while keeping message delivery reliable, so a missing retry mechanism cannot turn safety testing into a meaningless liveness failure.

## 12. Acceptance criteria

- the mandatory-write-back test catches its naive removal;
- quorum and tag tests catch their corresponding mutations;
- invariants catch tag regression and stale reads after completed writes;
- fault scenarios distinguish incomplete operations from safety violations;
- 200 seeded fuzz executions remain invariant-clean with a non-vacuous read-completion floor;
- operation IDs remain unique across restart executions;
- the bounded history checker rejects known non-linearizable histories and accepts legal overlapping ABD histories;
- the write-then-read scenario's trace hash is pinned (SPEC §10.1) and moves only with a deliberate change;
- typecheck, lint, full test suite and repository CI are green.

## 13. Future extension

Multi-writer ABD is separate work. A multi-writer phase must first discover the highest timestamp from a quorum and then choose a strictly larger deterministic tag.
