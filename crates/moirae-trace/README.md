# moirae-trace

The [moirae](https://github.com/pchrysostomou/moirae) trace format (SPEC §5, format v2) for
engines written in Rust: the schema as types, an ordered JSON value with integers only (past 2^53, as digit strings; SPEC §5), a
writer whose output is byte-identical to the TypeScript engine's `JSON.stringify`, a
`Verify` sink that replays a recording and stops at the first divergence, and the FNV-1a
trace hash moirae pins in CI. It writes traces; it does not simulate.

Parity with the engine is held by committed fixtures under `tests/fixtures`: the pnpm suite
asserts the engine still produces those bytes, `cargo test` asserts this crate reproduces
them. Zero dependencies (ADR-004, ADR-009).
