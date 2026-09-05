# moirae-sched

Seeded scheduling from [moirae](https://github.com/pchrysostomou/moirae) for engines written in
Rust: PCG32 seeded exactly as the TypeScript engine seeds it, named substreams derived from a
seed, and the policies a deterministic simulator asks for decisions — uniform random and PCT
(Burckhardt et al., ASPLOS 2010) — behind one `Scheduler` trait.

This version is a placeholder that reserves the name (ADR-009). The first release follows.
