// The trace schema, transcribed from SPEC §5. This file is the contract
// between the engine and every consumer (ADR-003): the studio imports these
// types and nothing else from the engine. Field order in the emitting literals
// is the serialization order — keep it stable, it is part of the byte format.

import type { NetworkConfig } from './network';
import type { Message, NodeId, SimTime } from './types';

// What `t` counts in. The engine writes milliseconds; a foreign engine such as ananke
// writes nanoseconds. Absent, which is every v1 trace, means 'ms'.
export type TimeUnit = 'ms' | 'ns';

export interface TraceHeader {
  kind: 'header';
  // Trace format version (ADR-003: versioned from day one). v2 added `unit`, made the
  // crash field lists optional, and documented `queue-full` and log namespacing; a v2
  // reader accepts v1.
  v: 1 | 2;
  seed: number;
  nodes: number;
  unit?: TimeUnit; // v2; the engine always writes it
  network?: NetworkConfig; // present only when a network was configured; absent = default network
}

export interface InitEvent {
  t: SimTime;
  seq: number;
  kind: 'init';
  node: NodeId;
}

export interface SendEvent {
  t: SimTime;
  seq: number;
  kind: 'send';
  from: NodeId;
  to: NodeId;
  msgId: number;
  msg: Message;
}

export interface DeliverEvent {
  t: SimTime;
  seq: number;
  kind: 'deliver';
  msgId: number;
  dup?: true; // the extra copy of a duplicated message; absent on the original delivery
}

// reason: `loss` (random loss), `partition` (crossed a partition boundary at send
// time), `crashed` (destination down at delivery time), or `queue-full` (the sender's
// bounded per-destination queue overflowed; written by foreign engines, never by this one).
export interface DropEvent {
  t: SimTime;
  seq: number;
  kind: 'drop';
  msgId: number;
  reason: string;
}

// patch: changed top-level state fields; a field deleted from the state
// appears as null. The viewer reconstructs state by folding patches.
export interface StateEvent {
  t: SimTime;
  seq: number;
  kind: 'state';
  node: NodeId;
  patch: Record<string, unknown>;
}

export interface TimerEvent {
  t: SimTime;
  seq: number;
  kind: 'timer';
  node: NodeId;
  name: string;
}

// A foreign engine namespaces its own event names `<engine>.<topic>`, for example
// `ananke.task.polled`, so they never collide with a protocol's `ctx.log` names, which
// are unprefixed.
export interface LogEvent {
  t: SimTime;
  seq: number;
  kind: 'log';
  node: NodeId;
  event: string;
  data?: Record<string, unknown>;
}

// Self-describing (ADR-003): a reader must be able to tell why a node came
// back with an empty log without the source that produced the trace. The two
// field lists describe this engine's declared-state model; an engine without
// one (v2) omits both.
export interface CrashFault {
  t: SimTime;
  seq: number;
  kind: 'fault';
  fault: 'crash';
  node: NodeId;
  cause: 'self' | 'schedule'; // ctx.crash() vs the fault schedule
  persisted?: string[]; // state fields that survive, in state key order
  lost?: string[]; // state fields that do not
}

export interface RestartFault {
  t: SimTime;
  seq: number;
  kind: 'fault';
  fault: 'restart';
  node: NodeId;
}

export interface PartitionFault {
  t: SimTime;
  seq: number;
  kind: 'fault';
  fault: 'partition';
  groups: readonly (readonly NodeId[])[];
}

export interface HealFault {
  t: SimTime;
  seq: number;
  kind: 'fault';
  fault: 'heal';
  groups: readonly (readonly NodeId[])[]; // the partition that just ended
}

export type FaultEvent = CrashFault | RestartFault | PartitionFault | HealFault;

export interface ViolationEvent {
  t: SimTime;
  seq: number;
  kind: 'violation';
  invariant: string;
  detail: string;
}

export type TraceEvent =
  | TraceHeader
  | InitEvent
  | SendEvent
  | DeliverEvent
  | DropEvent
  | StateEvent
  | TimerEvent
  | LogEvent
  | FaultEvent
  | ViolationEvent;
