# moirae-sched

Seeded scheduling from [moirae](https://github.com/pchrysostomou/moirae) for engines written in
Rust: PCG32 seeded exactly as the TypeScript engine seeds it and checked against the same
reference vectors, named substreams derived from a seed by FNV-1a, and the policies a
deterministic simulator asks for decisions — uniform random and PCT (Burckhardt et al.,
ASPLOS 2010) — behind one `Scheduler` trait, plus a fair per-node coin for symmetric
choices. `Policy::for_seed` gives a fuzz campaign both policies. Zero third-party
dependencies (ADR-004, ADR-009).
