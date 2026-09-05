//! moirae's seeded scheduling for engines written in Rust (ADR-009).
//!
//! A deterministic simulator has three sources of randomness that must never leak into
//! one another: what the *scheduler* decides, what the *fault model* draws, and what the
//! *protocol* itself asks for. This crate supplies the first, and the generator all three
//! are built from.
//!
//! - [`Pcg32`] is PCG32 XSH-RR seeded exactly as the engine's `pcg32.ts`, checked
//!   against the same reference vectors.
//! - [`stream`] derives a named substream from a seed the way `simulate.ts` derives its
//!   per-node and network streams: FNV-1a over `"{seed}/{label}"`.
//! - [`Scheduler`] is what an executor asks: which runnable task polls next, and a fair
//!   coin for symmetric choices such as which of two ready futures to serve first.
//!   [`Uniform`] draws every choice uniformly; [`Pct`] is the priority-based scheduler
//!   of Burckhardt, Kothari, Musuvathi and Nagarakatte, "A Randomized Scheduler with
//!   Probabilistic Guarantees of Finding Bugs" (ASPLOS 2010). [`Policy::for_seed`] picks
//!   one per run so a fuzz campaign gets both.

mod pcg32;
mod policy;

pub use pcg32::{Pcg32, stream};
pub use policy::{Pct, Policy, Scheduler, TaskId, Uniform};
