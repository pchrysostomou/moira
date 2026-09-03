# moirae-protocols

Protocol implementations for the [moirae](https://github.com/pchrysostomou/moirae) deterministic
simulator. v0 ships three: Raft, single-decree Paxos, and the ABD atomic register.

`Raft` is a transcription of Ongaro & Ousterhout, *In Search of an Understandable Consensus
Algorithm* (USENIX ATC 2014): leader election, log replication, the §5.4 safety restrictions, and
persistence across simulated crashes. Every handler cites the rule it implements, and every
deliberate deviation from the paper is named in
[docs/RAFT.md](https://github.com/pchrysostomou/moirae/blob/main/docs/RAFT.md). The ten classically
mis-implemented rules — term comparison, the Figure 8 commit rule, conflict-only truncation, the
election restriction, and the rest — each have a test that was first shown to fail against the
naive form.

Also here, as engine invariants: the Figure 3 safety properties `electionSafety()`, `logMatching()`
and `stateMachineSafety()`.

`Paxos` is a transcription of Lamport, *Paxos Made Simple* (2001): single-decree, every node a
proposer, acceptor and learner, safety under loss, duplication, reordering, partitions and
acceptor restarts. Every handler cites its section; every choice the paper leaves open is named
in [docs/PAXOS.md](https://github.com/pchrysostomou/moirae/blob/main/docs/PAXOS.md), and the
classically mis-implemented rules — accept `>` where the paper means ≥, phase 2 ignoring the
highest reported value, stale and duplicated promises counted — each have a test first shown to
fail against the naive form. Its invariants: `agreement()`, `validity()`, `proposalIntegrity()`.

`ABD` is a transcription of Attiya, Bar-Noy and Dolev, *Sharing Memory Robustly in
Message-Passing Systems* (1995): a single-writer, multi-reader atomic register with the
mandatory read write-back, deterministic tag ordering, and acceptor-grade persistence across
simulated restarts. Contributed from #31; every choice the paper leaves open is named in
[docs/ABD.md](https://github.com/pchrysostomou/moirae/blob/main/docs/ABD.md). Its invariants:
`tagMonotonicity()` and `completedWriteReadFreshness()` — the stale-read catcher.

```ts
import { simulate } from 'moirae-core';
import { Raft, electionSafety, logMatching, stateMachineSafety } from 'moirae-protocols';

const result = simulate({
  seed: 19,
  nodes: 5,
  process: Raft,
  until: { simTime: 6_000 },
  network: {
    latency: [10, 50],
    dropRate: 0.02,
    partitions: [{ groups: [[1, 2], [3, 4, 5]], start: 1500, end: 3500 }],
  },
  invariants: [electionSafety(), logMatching(), stateMachineSafety()],
});
```

The bare `Raft` elects leaders and replicates whatever is proposed; to feed it entries, subclass
it and call `propose(ctx, command)` from a timer — the repository's `examples` show how.

Out of scope in v0: membership changes, snapshots, client interaction, pre-vote, Multi-Paxos.
Read the protocol's notes — RAFT.md or PAXOS.md — before contributing a handler. Apache-2.0.
