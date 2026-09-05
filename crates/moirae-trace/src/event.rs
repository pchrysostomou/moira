//! The schema (SPEC §5), one variant per event `kind`.

use crate::json::Json;

/// A node id as written in traces: 1-based, `1..=nodes`.
pub type NodeId = u32;
/// A message id, assigned at send; how `send`, `deliver` and `drop` lines correlate.
pub type MsgId = u64;
/// A time in the header's [`TimeUnit`].
pub type SimTime = u64;

/// What `t` counts in.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TimeUnit {
    /// Milliseconds, what the TypeScript engine writes.
    Ms,
    /// Nanoseconds, for engines with a finer clock.
    Ns,
}

impl TimeUnit {
    /// The header value.
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            TimeUnit::Ms => "ms",
            TimeUnit::Ns => "ns",
        }
    }
}

/// The header line. Field order on the wire: `kind`, `v`, `seed`, `nodes`, `unit`,
/// `network` if present, then `extra` in the order given.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Header {
    /// The seed; must not exceed 2^53 - 1.
    pub seed: u64,
    /// How many nodes; ids run `1..=nodes`.
    pub nodes: u32,
    /// What `t` counts in.
    pub unit: TimeUnit,
    /// The engine's network config, an object, if one was configured.
    pub network: Option<Json>,
    /// Engine-specific fields a v2 reader ignores, for example `"ananke": {...}`.
    pub extra: Vec<(String, Json)>,
}

/// Why a node crashed.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Cause {
    /// The node crashed itself.
    SelfCrash,
    /// The fault schedule crashed it.
    Schedule,
}

impl Cause {
    /// The wire value.
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Cause::SelfCrash => "self",
            Cause::Schedule => "schedule",
        }
    }
}

/// The declared-state lists on a crash, for engines that have such a model.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CrashFields {
    /// State fields that survive, in state key order.
    pub persisted: Vec<String>,
    /// State fields that do not.
    pub lost: Vec<String>,
}

/// One trace event. `seq` is not here: the [`Writer`](crate::Writer) stamps it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Event {
    /// A node initialised.
    Init {
        /// When.
        t: SimTime,
        /// Which node.
        node: NodeId,
    },
    /// A message left a node.
    Send {
        /// When.
        t: SimTime,
        /// Sender.
        from: NodeId,
        /// Destination.
        to: NodeId,
        /// The id `deliver` and `drop` lines refer to.
        msg_id: MsgId,
        /// The message, an object with a string `type`.
        msg: Json,
    },
    /// A message reached its destination.
    Deliver {
        /// When.
        t: SimTime,
        /// Which message.
        msg_id: MsgId,
        /// `true` for the extra copy of a duplicated message.
        dup: bool,
    },
    /// A message will never arrive.
    Drop {
        /// When.
        t: SimTime,
        /// Which message.
        msg_id: MsgId,
        /// `loss`, `partition`, `crashed` or `queue-full`.
        reason: String,
    },
    /// A node's state changed; the patch holds the changed top-level fields.
    State {
        /// When.
        t: SimTime,
        /// Which node.
        node: NodeId,
        /// The changed fields, an object; a deleted field appears as `null`.
        patch: Json,
    },
    /// A named timer fired.
    Timer {
        /// When.
        t: SimTime,
        /// Which node.
        node: NodeId,
        /// The timer's name.
        name: String,
    },
    /// A log line from the protocol or the engine.
    Log {
        /// When.
        t: SimTime,
        /// Which node.
        node: NodeId,
        /// The event name; a foreign engine prefixes its own with `<engine>.`.
        event: String,
        /// Structured detail, an object, if any.
        data: Option<Json>,
    },
    /// A node crashed.
    Crash {
        /// When.
        t: SimTime,
        /// Which node.
        node: NodeId,
        /// Why.
        cause: Cause,
        /// The declared-state lists; `None` for an engine without that model (v2).
        fields: Option<CrashFields>,
    },
    /// A crashed node came back.
    Restart {
        /// When.
        t: SimTime,
        /// Which node.
        node: NodeId,
    },
    /// A partition began: disjoint groups covering every node.
    Partition {
        /// When.
        t: SimTime,
        /// The groups.
        groups: Vec<Vec<NodeId>>,
    },
    /// A partition ended.
    Heal {
        /// When.
        t: SimTime,
        /// The groups that just ended.
        groups: Vec<Vec<NodeId>>,
    },
    /// An invariant failed; the run stops.
    Violation {
        /// When.
        t: SimTime,
        /// The invariant's name.
        invariant: String,
        /// What it saw.
        detail: String,
    },
}

impl Event {
    /// The event's time.
    #[must_use]
    pub fn t(&self) -> SimTime {
        match self {
            Event::Init { t, .. }
            | Event::Send { t, .. }
            | Event::Deliver { t, .. }
            | Event::Drop { t, .. }
            | Event::State { t, .. }
            | Event::Timer { t, .. }
            | Event::Log { t, .. }
            | Event::Crash { t, .. }
            | Event::Restart { t, .. }
            | Event::Partition { t, .. }
            | Event::Heal { t, .. }
            | Event::Violation { t, .. } => *t,
        }
    }
}
