//! The moirae trace format (SPEC §5) for engines written in Rust (ADR-009).
//!
//! A trace is append-only JSONL: a header line, then one event per line, each stamped
//! with the time `t` and a sequence number `seq`. This crate writes that format, byte for
//! byte as the TypeScript engine's `JSON.stringify` would, so a trace produced here opens
//! in the moirae studio and hashes like any other. It writes; it does not simulate.
//!
//! - [`Json`] is an ordered JSON value with no floats: a JavaScript reader keeps integers
//!   exact only up to 2^53, and float formatting parity between languages is a test nobody
//!   wants, so numbers are integers. One outside plus or minus [`MAX_SAFE_INTEGER`] is
//!   written as its decimal digits in a string, in any integer position, and a reader
//!   takes the string as the integer (SPEC §5).
//! - [`Event`] is the schema, one variant per `kind`, with the engine's field order.
//! - [`Writer`] stamps `seq`, serialises, and hands each line to a [`Sink`]: [`Collect`]
//!   keeps them, [`Verify`] compares them against a recorded trace and stops at the
//!   first divergence.
//! - [`trace_hash`] is the FNV-1a 64 hash over the exact bytes that moirae pins in CI.
//!
//! Parity with the engine is held by committed fixtures under `tests/fixtures`: the
//! TypeScript side asserts the engine still produces those bytes, this crate asserts it
//! reproduces them.

mod event;
mod hash;
mod json;
mod sink;
mod writer;

pub use event::{Cause, CrashFields, Event, Header, MsgId, NodeId, SimTime, TimeUnit};
pub use hash::{fnv1a64, hex64, trace_hash};
pub use json::{Json, MAX_SAFE_INTEGER};
pub use sink::{Collect, Sink, Verify};
pub use writer::{Error, Writer};

/// The trace format version this crate writes.
pub const FORMAT_VERSION: u8 = 2;
