// The scheduler (SPEC §4): a single-threaded loop over a priority queue of
// events totally ordered by (time, seq). One step = pop one event, dispatch
// it, append the resulting effects to the queue, run invariants. Determinism
// is the entire point: every ordering decision goes through the queue's
// explicit comparator, every random draw through a per-node seeded PRNG, and
// the trace is serialized at emission time so later mutation cannot reach it.

import { deepFreeze } from './deep-freeze';
import { EventQueue } from './event-queue';
import { fnv1a64String } from './hash';
import type { Invariant, Violation, WorldNode, WorldView } from './invariants';
import { DefaultNetwork, type NetworkConfig } from './network';
import { Pcg32 } from './pcg32';
import type { TraceEvent } from './trace';
import type { Ctx, Message, NodeId, Process, SimTime } from './types';

interface DeliverEv {
  kind: 'deliver';
  to: NodeId;
  from: NodeId;
  msgId: number;
  msg: Message;
  dup: boolean;
}

interface TimerEv {
  kind: 'timer';
  node: NodeId;
  name: string;
  gen: number;
}

interface PartitionStartEv {
  kind: 'partition-start';
  index: number;
}

interface PartitionEndEv {
  kind: 'partition-end';
  index: number;
}

interface CrashEv {
  kind: 'crash';
  node: NodeId;
}

interface RestartEv {
  kind: 'restart';
  node: NodeId;
}

type EngineEvent = DeliverEv | TimerEv | PartitionStartEv | PartitionEndEv | CrashEv | RestartEv;

export interface CrashSchedule {
  readonly node: NodeId;
  readonly at: SimTime;
  readonly restartAt?: SimTime; // omitted = stays down
}

export interface SimulateOptions<S extends Record<string, unknown>> {
  seed: number;
  nodes: number;
  process: new () => Process<S>;
  // The loop also terminates when the queue is empty or an invariant fails.
  until: { simTime?: SimTime; steps?: number };
  network?: NetworkConfig; // omitted = immediate, lossless delivery
  faults?: { readonly crashes?: readonly CrashSchedule[] };
  invariants?: readonly Invariant<S>[];
}

export interface SimulationResult {
  readonly trace: readonly TraceEvent[];
  readonly jsonl: string;
  readonly steps: number;
  readonly time: SimTime;
  readonly violation: Violation | null;
}

interface NodeRuntime<S> {
  readonly id: NodeId;
  readonly proc: Process<S>;
  readonly prng: Pcg32;
  readonly timers: Map<string, number>; // timer name -> live generation; lookup only, never iterated
  ctx: Ctx<S>;
  state: S;
  crashed: boolean;
  persisted: Record<string, unknown>; // the surviving fields, captured at the crash event
}

export function simulate<S extends Record<string, unknown>>(
  opts: SimulateOptions<S>,
): SimulationResult {
  const nodeCount = opts.nodes;
  const invariants = opts.invariants ?? [];
  for (const inv of invariants) {
    const every = inv.every ?? 1;
    if (!Number.isInteger(every) || every < 1) {
      throw new Error(`invariant '${inv.name}': every must be a positive integer, got ${every}`);
    }
  }

  const network = new DefaultNetwork(opts.network ?? {}, nodeCount);
  // The network's own stream (sequence selector 0; nodes use 1..n), so
  // network randomness never perturbs a protocol's draws.
  const netRng = new Pcg32(fnv1a64String(`${opts.seed}/network`), 0n);

  const lines: string[] = [];
  const events: TraceEvent[] = []; // parsed and frozen at emission: the history invariants see
  const queue = new EventQueue<EngineEvent>();
  let now: SimTime = 0;
  let traceSeq = 0;
  let nextMsgId = 0;
  let nextTimerGen = 0;
  let steps = 0;
  let violation: Violation | null = null;

  // Serialize immediately: a trace line captures values as they were at
  // emission, so a protocol mutating its state or a sent message afterwards
  // cannot rewrite history. Field order in these literals is the byte format.
  const emit = (event: TraceEvent): void => {
    const line = JSON.stringify(event);
    lines.push(line);
    events.push(deepFreeze(JSON.parse(line) as TraceEvent));
  };

  emit(
    opts.network === undefined
      ? { kind: 'header', v: 2, seed: opts.seed, nodes: nodeCount, unit: 'ms' }
      : { kind: 'header', v: 2, seed: opts.seed, nodes: nodeCount, unit: 'ms', network: opts.network },
  );

  const runtimes: NodeRuntime<S>[] = [];
  const byId = (id: NodeId): NodeRuntime<S> => {
    const rt = runtimes[id - 1];
    if (rt === undefined) throw new Error(`no such node: ${id}`);
    return rt;
  };

  const send = (rt: NodeRuntime<S>, to: NodeId, msg: Message): void => {
    if (rt.crashed) return; // a crashed node sends nothing
    if (!Number.isInteger(to) || to < 1 || to > nodeCount) {
      throw new Error(`node ${rt.id} sent to nonexistent node ${to}`);
    }
    // Copy so the in-flight message is isolated from later sender mutation.
    const copy = JSON.parse(JSON.stringify(msg)) as Message;
    const msgId = nextMsgId++;
    emit({ t: now, seq: traceSeq++, kind: 'send', from: rt.id, to, msgId, msg: copy });
    const routing = network.route({ from: rt.id, to, msgId }, netRng, now);
    if (routing.kind === 'drop') {
      emit({ t: now, seq: traceSeq++, kind: 'drop', msgId, reason: routing.reason });
      return;
    }
    for (const d of routing.deliveries) {
      queue.insert(d.at, { kind: 'deliver', to, from: rt.id, msgId, msg: copy, dup: d.dup });
    }
  };

  // Per-key JSON snapshot of the state, so nested mutation is visible in the
  // diff. Object.keys and Map iteration are safe here: the state object is
  // built by deterministic protocol code, so its key insertion order is
  // itself deterministic.
  const snapshot = (state: Record<string, unknown> | undefined): Map<string, string> => {
    const snap = new Map<string, string>();
    if (state !== undefined) {
      for (const key of Object.keys(state)) {
        snap.set(key, JSON.stringify(state[key]) ?? 'undefined');
      }
    }
    return snap;
  };

  const emitStatePatch = (rt: NodeRuntime<S>, before: Map<string, string>): void => {
    if (rt.crashed) return; // a crashed node has no state to report
    const state = rt.state as Record<string, unknown>;
    const patch: Record<string, unknown> = {};
    let changed = false;
    // Deleted fields first (as null), in pre-handler key order.
    for (const key of before.keys()) {
      if (!(key in state)) {
        patch[key] = null;
        changed = true;
      }
    }
    for (const key of Object.keys(state)) {
      const serialized = JSON.stringify(state[key]) ?? 'undefined';
      if (before.get(key) !== serialized) {
        patch[key] = state[key];
        changed = true;
      }
    }
    if (changed) {
      emit({ t: now, seq: traceSeq++, kind: 'state', node: rt.id, patch });
    }
  };

  // A crash snapshots the fields the process declared persistent and loses
  // the rest (SPEC §3). Timers die with the node; deliveries to it become
  // drops; its sends are ignored. The trace line lists what survived.
  const crashNode = (rt: NodeRuntime<S>, cause: 'self' | 'schedule'): void => {
    if (rt.crashed) return;
    // A crash inside init() finds no state yet: nothing to persist.
    const state = (rt.state ?? {}) as Record<string, unknown>;
    const keep = new Set((rt.proc.persistent ?? []).map(String)); // membership only
    const persisted: string[] = [];
    const lost: string[] = [];
    const kept: Record<string, unknown> = {};
    for (const key of Object.keys(state)) {
      if (keep.has(key)) {
        persisted.push(key);
        const serialized = JSON.stringify(state[key]);
        if (serialized !== undefined) kept[key] = JSON.parse(serialized);
      } else {
        lost.push(key);
      }
    }
    rt.persisted = deepFreeze(kept); // the snapshot handed to onRestart must not drift
    rt.crashed = true;
    rt.timers.clear();
    emit({ t: now, seq: traceSeq++, kind: 'fault', fault: 'crash', node: rt.id, cause, persisted, lost });
  };

  // Restart = init() for a fresh state, persisted fields overlaid, then the
  // optional onRestart hook. The first state patch after a restart is a
  // full snapshot, so the viewer can fold from it.
  const restartNode = (rt: NodeRuntime<S>): void => {
    if (!rt.crashed) return;
    rt.crashed = false;
    emit({ t: now, seq: traceSeq++, kind: 'fault', fault: 'restart', node: rt.id });
    const before = snapshot(undefined);
    const fresh = rt.proc.init(rt.ctx);
    // Overlay a copy: the live state must not alias the frozen snapshot.
    const revived = JSON.parse(JSON.stringify(rt.persisted)) as Record<string, unknown>;
    rt.state = { ...fresh, ...revived } as S;
    rt.proc.onRestart?.(rt.ctx, rt.persisted as Partial<S>);
    emitStatePatch(rt, before);
  };

  // SPEC §7: a deep-frozen copy of every node's state, the crashed set, the
  // clock and the history. Copying (rather than freezing the live state)
  // keeps the protocol free to mutate its own state afterwards.
  const worldView = (): WorldView<S> => {
    const nodes: WorldNode<S>[] = runtimes.map((rt) =>
      deepFreeze({
        id: rt.id,
        crashed: rt.crashed,
        state: rt.crashed ? null : (JSON.parse(JSON.stringify(rt.state)) as S),
      }),
    );
    return Object.freeze({ time: now, step: steps, nodes: Object.freeze(nodes), trace: events });
  };

  // Returns true when an invariant was violated (the loop then stops).
  const checkInvariants = (): boolean => {
    let world: WorldView<S> | null = null;
    for (const inv of invariants) {
      if (steps % (inv.every ?? 1) !== 0) continue;
      world ??= worldView();
      const detail = inv.check(world);
      if (detail !== null) {
        emit({ t: now, seq: traceSeq++, kind: 'violation', invariant: inv.name, detail });
        violation = { invariant: inv.name, detail, step: steps, time: now };
        return true;
      }
    }
    return false;
  };

  for (let id = 1; id <= nodeCount; id++) {
    const peers: NodeId[] = [];
    for (let p = 1; p <= nodeCount; p++) {
      if (p !== id) peers.push(p);
    }
    const rt: NodeRuntime<S> = {
      id,
      proc: new opts.process(),
      // SPEC §4: per-node streams derived from the root seed, so adding a
      // node does not reshuffle the streams of existing nodes.
      prng: new Pcg32(fnv1a64String(`${opts.seed}/${id}`), BigInt(id)),
      timers: new Map(),
      ctx: undefined as unknown as Ctx<S>,
      state: undefined as unknown as S,
      crashed: false,
      persisted: {},
    };
    rt.ctx = {
      me: id,
      peers,
      get state(): S {
        return rt.state;
      },
      set state(s: S) {
        rt.state = s;
      },
      now: () => now,
      random: () => rt.prng.random(),
      // Exactly one draw, mapped the way protocol authors were doing by hand,
      // so switching to randomInt never changes a trace.
      randomInt: (min, max) => {
        if (!Number.isInteger(min) || !Number.isInteger(max) || min > max) {
          throw new Error(`node ${id} called randomInt(${min}, ${max}): need integers with min <= max`);
        }
        return min + Math.floor(rt.prng.random() * (max - min + 1));
      },
      send: (to, msg) => {
        send(rt, to, msg);
      },
      broadcast: (msg) => {
        for (const p of peers) send(rt, p, msg);
      },
      setTimer: (name, delayMs) => {
        if (!Number.isFinite(delayMs) || delayMs < 0) {
          throw new Error(`node ${id} set timer '${name}' with invalid delay ${delayMs}`);
        }
        const gen = ++nextTimerGen;
        rt.timers.set(name, gen); // replaces any live timer of the same name
        queue.insert(now + delayMs, { kind: 'timer', node: id, name, gen });
      },
      cancelTimer: (name) => {
        rt.timers.delete(name);
      },
      log: (event, data) => {
        emit(
          data === undefined
            ? { t: now, seq: traceSeq++, kind: 'log', node: id, event }
            : { t: now, seq: traceSeq++, kind: 'log', node: id, event, data },
        );
      },
      crash: () => {
        crashNode(rt, 'self');
      },
    };
    runtimes.push(rt);
  }

  // The fault schedule goes into the queue before any protocol code runs, so
  // its seq numbers are fixed by the schedule alone.
  network.partitions.forEach((p, index) => {
    queue.insert(p.start, { kind: 'partition-start', index });
    queue.insert(p.end, { kind: 'partition-end', index });
  });
  (opts.faults?.crashes ?? []).forEach((c, i) => {
    const where = `faults.crashes[${i}]`;
    if (!Number.isInteger(c.node) || c.node < 1 || c.node > nodeCount) {
      throw new Error(`${where}: node ${c.node} does not exist`);
    }
    if (!(c.at >= 0)) throw new Error(`${where}: at must be >= 0, got ${c.at}`);
    if (c.restartAt !== undefined && !(c.restartAt > c.at)) {
      throw new Error(`${where}: restartAt (${c.restartAt}) must be after at (${c.at})`);
    }
    queue.insert(c.at, { kind: 'crash', node: c.node });
    if (c.restartAt !== undefined) queue.insert(c.restartAt, { kind: 'restart', node: c.node });
  });

  for (const rt of runtimes) {
    emit({ t: 0, seq: traceSeq++, kind: 'init', node: rt.id });
    const before = snapshot(undefined);
    rt.state = rt.proc.init(rt.ctx);
    emitStatePatch(rt, before);
  }

  const untilTime = opts.until.simTime ?? Infinity;
  const untilSteps = opts.until.steps ?? Infinity;
  let stop = checkInvariants(); // step 0: the initial world must hold too
  while (!stop && steps < untilSteps) {
    const next = queue.pop();
    if (next === undefined) break;
    if (next.time > untilTime) {
      now = untilTime;
      break;
    }
    now = next.time;
    steps++;
    const ev = next.event;
    if (ev.kind === 'deliver') {
      const rt = byId(ev.to);
      if (rt.crashed) {
        emit({ t: now, seq: traceSeq++, kind: 'drop', msgId: ev.msgId, reason: 'crashed' });
      } else {
        emit(
          ev.dup
            ? { t: now, seq: traceSeq++, kind: 'deliver', msgId: ev.msgId, dup: true }
            : { t: now, seq: traceSeq++, kind: 'deliver', msgId: ev.msgId },
        );
        const before = snapshot(rt.state);
        rt.proc.onMessage(rt.ctx, ev.from, ev.msg);
        emitStatePatch(rt, before);
      }
    } else if (ev.kind === 'partition-start') {
      network.startPartition(ev.index);
      const groups = (network.partitions[ev.index] as { groups: readonly (readonly NodeId[])[] }).groups;
      emit({ t: now, seq: traceSeq++, kind: 'fault', fault: 'partition', groups });
    } else if (ev.kind === 'partition-end') {
      network.endPartition();
      const groups = (network.partitions[ev.index] as { groups: readonly (readonly NodeId[])[] }).groups;
      emit({ t: now, seq: traceSeq++, kind: 'fault', fault: 'heal', groups });
    } else if (ev.kind === 'crash') {
      crashNode(byId(ev.node), 'schedule');
    } else if (ev.kind === 'restart') {
      restartNode(byId(ev.node));
    } else {
      const rt = byId(ev.node);
      // A stale generation means the timer was replaced or cancelled; a
      // crashed node's timers never fire. Either way: silently discarded.
      if (!rt.crashed && rt.timers.get(ev.name) === ev.gen) {
        rt.timers.delete(ev.name); // timers are one-shot
        emit({ t: now, seq: traceSeq++, kind: 'timer', node: rt.id, name: ev.name });
        const before = snapshot(rt.state);
        rt.proc.onTimer(rt.ctx, ev.name);
        emitStatePatch(rt, before);
      }
    }
    stop = checkInvariants();
  }

  return {
    trace: events,
    jsonl: lines.join('\n') + '\n',
    steps,
    time: now,
    violation,
  };
}
