// The timeline: one lane per node, time on x. Role strips colour each lane by
// the `role` convention; partitions are shaded windows with a wall between
// the groups and a plain-word caption; dropped messages are arcs that stop
// short — at the wall when the wall is what stopped them.

import type { TraceModel, PartitionWindow } from '../trace/model';
import { roleColour } from '../trace/labels';
import type { TimeUnit } from 'moirae-core';
import { BARE_GUTTER, BARE_WIDTH, LANE, LANE_PAD, formatTime, makeScale, type Scale, unitsPerMs, WIDTH } from './layout';

const ARC_COLOURS: Readonly<Record<string, string>> = {
  RequestVote: '#e0a100',
  RequestVoteResponse: '#efc65a',
  AppendEntries: '#7a8ba8',
  AppendEntriesResponse: '#b8c2d3',
};

function arcColour(type: string): string {
  return ARC_COLOURS[type] ?? '#8c8c86';
}

// The one place the studio has an opinion about message types: vote traffic
// is drawn loud, everything else quiet. Unknown types are treated as quiet.
export function isElectionTraffic(type: string): boolean {
  return type === 'RequestVote' || type === 'RequestVoteResponse';
}

function groupOf(window: PartitionWindow, node: number): number {
  return window.groups.findIndex((g) => g.includes(node));
}

function listNodes(nodes: readonly number[]): string {
  return nodes.length === 1 ? `node ${nodes[0]}` : `nodes ${nodes.join(', ')}`;
}

export interface TimelineProps {
  readonly model: TraceModel;
  readonly playhead: number;
  readonly selected: number | null; // msgId
  readonly bare?: boolean; // recording layout: narrower frame, larger type
  onSeek(t: number): void;
  onSelect(msgId: number | null): void;
}

export function Timeline({ model, playhead, selected, bare = false, onSeek, onSelect }: TimelineProps) {
  const width = bare ? BARE_WIDTH : WIDTH;
  const scale = makeScale(model.duration, model.nodes.length, width, bare ? BARE_GUTTER : undefined);
  const ticks: number[] = [];
  // Ticks every half second, every second past ten seconds, in the trace's unit.
  const per = unitsPerMs(model.unit);
  const step = (model.duration > 10_000 * per ? 1000 : 500) * per;
  for (let t = 0; t <= model.duration; t += step) ticks.push(t);
  const xHead = scale.x(playhead);

  const seekFromEvent = (e: React.MouseEvent<SVGSVGElement>): void => {
    const rect = e.currentTarget.getBoundingClientRect();
    const x = ((e.clientX - rect.left) / rect.width) * width;
    if (x < scale.plotLeft || x > scale.plotRight) return;
    onSeek(((x - scale.plotLeft) / (scale.plotRight - scale.plotLeft)) * model.duration);
  };

  return (
    <svg
      className="timeline"
      viewBox={`0 0 ${width} ${scale.height}`}
      width={width}
      height={scale.height}
      role="img"
      aria-label="trace timeline"
      onClick={(e) => {
        onSelect(null);
        seekFromEvent(e);
      }}
    >
      <defs>
        <pattern id="hatch" width="8" height="8" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
          <rect width="8" height="8" fill="#e9e9e4" />
          <line x1="0" y1="0" x2="0" y2="8" stroke="#9a9a94" strokeWidth="2" />
        </pattern>
        {/* Nothing past the playhead exists yet: the story is revealed, not previewed. */}
        <clipPath id="past">
          <rect x={0} y={0} width={Math.max(xHead, scale.plotLeft)} height={scale.height} />
        </clipPath>
      </defs>

      <LaneBackgrounds model={model} scale={scale} />
      <g clipPath="url(#past)">
        <Lanes model={model} scale={scale} />
        <Partitions model={model} scale={scale} playhead={playhead} />
        <Arcs model={model} scale={scale} selected={selected} onSelect={onSelect} bare={bare} />
        <Crashes model={model} scale={scale} />
      </g>
      <Axis ticks={ticks} scale={scale} unit={model.unit} />
      <line x1={xHead} y1={scale.laneTop(1) - 24} x2={xHead} y2={scale.height - 16} stroke="#1d1d1b" strokeWidth={2} pointerEvents="none" />
      {/* Captions are whole sentences: either there or not, never clipped mid-word. */}
      <PartitionCaptions model={model} scale={scale} playhead={playhead} />
    </svg>
  );
}

// The stage: empty lanes and their labels, always fully drawn.
function LaneBackgrounds({ model, scale }: { model: TraceModel; scale: Scale }) {
  return (
    <g>
      {model.nodes.map((node) => {
        const top = scale.laneTop(node);
        return (
          <g key={node}>
            <rect x={scale.plotLeft} y={top} width={scale.plotRight - scale.plotLeft} height={LANE} fill="#f4f4f0" />
            <line x1={scale.plotLeft} y1={top + LANE} x2={scale.plotRight} y2={top + LANE} stroke="#e1e1da" />
            <text x={12} y={scale.laneMid(node) + 5} className="lane-label">
              node {node}
            </text>
          </g>
        );
      })}
    </g>
  );
}

function Lanes({ model, scale }: { model: TraceModel; scale: Scale }) {
  return (
    <g>
      {model.nodes.map((node) => {
        const top = scale.laneTop(node);
        const intervals = model.roles.get(node) ?? [];
        let lastTerm: number | null = null;
        return (
          <g key={node}>
            {intervals.map((iv) => {
              const showTerm = iv.term !== null && iv.term !== lastTerm;
              lastTerm = iv.term;
              const x0 = scale.x(iv.start);
              const w = Math.max(scale.x(iv.end) - x0, 1);
              return (
                <g key={iv.start}>
                  <rect
                    x={x0}
                    y={top + LANE_PAD}
                    width={w}
                    height={LANE - 2 * LANE_PAD}
                    fill={roleColour(iv.role)}
                    opacity={iv.role === 'follower' ? 0.55 : 0.9}
                  >
                    <title>
                      node {node}: {iv.role}
                      {iv.term !== null ? `, term ${iv.term}` : ''} ({formatTime(iv.start, model.unit)}–{formatTime(iv.end, model.unit)})
                    </title>
                  </rect>
                  {showTerm && w > 14 && (
                    <text x={x0 + 3} y={top + LANE_PAD + 11} className="term-label">
                      t{iv.term}
                    </text>
                  )}
                </g>
              );
            })}
          </g>
        );
      })}
    </g>
  );
}

function Partitions({ model, scale, playhead }: { model: TraceModel; scale: Scale; playhead: number }) {
  return (
    <g>
      {model.partitions.map((w) => {
        // A partition exists on screen from the moment it happens: the wall,
        // its caption and the running count appear when the playhead reaches
        // it, not before.
        if (playhead < w.start) return null;
        const x0 = scale.x(w.start);
        const x1 = scale.x(w.end);
        const walls: number[] = [];
        for (let k = 0; k + 1 < model.nodes.length; k++) {
          const a = model.nodes[k] as number;
          const b = model.nodes[k + 1] as number;
          if (groupOf(w, a) !== groupOf(w, b)) walls.push(scale.laneTop(b));
        }
        return (
          <g key={w.start}>
            <rect
              x={x0}
              y={scale.laneTop(1)}
              width={x1 - x0}
              height={LANE * model.nodes.length}
              fill="#c0392b"
              opacity={0.07}
            />
            {walls.map((y) => (
              <line key={y} x1={x0} y1={y} x2={x1} y2={y} stroke="#c0392b" strokeWidth={4} strokeDasharray="10 6" />
            ))}
          </g>
        );
      })}
    </g>
  );
}

function PartitionCaptions({ model, scale, playhead }: { model: TraceModel; scale: Scale; playhead: number }) {
  return (
    <g pointerEvents="none">
      {model.partitions.map((w) => {
        if (playhead < w.start) return null;
        const x0 = scale.x(w.start);
        const smaller = [...w.groups].sort((g1, g2) => g1.length - g2.length)[0] ?? [];
        const rest = w.groups.filter((g) => g !== smaller).flat();
        return (
          <g key={w.start}>
            <text x={x0 + 6} y={scale.laneTop(1) - 8} className="caption caption-partition">
              Partition — {listNodes(smaller)} cut off from {listNodes(rest)} ({formatTime(w.start, model.unit)}–{formatTime(w.end, model.unit)})
            </text>
            {w.groups.map((group) => {
              const story = groupStory(model, w, group, playhead);
              if (story === null) return null;
              // Next to the lane that proves the sentence: the group's leader
              // lane if it has one, else the seam between its first two lanes
              // (or mid-lane for a group of one), away from any wall.
              const leaderLane = group.find((node) =>
                (model.roles.get(node) ?? []).some((iv) => iv.role === 'leader' && iv.start < w.end && iv.end > w.start),
              );
              const first = group[0] as number;
              let y: number;
              if (leaderLane !== undefined) y = scale.laneTop(leaderLane) + LANE_PAD - 3;
              else if (group.length > 1) y = scale.laneTop(first) + LANE + 4;
              else y = scale.laneMid(first) + 4;
              return (
                <text key={group.join('-')} x={x0 + 8} y={y} className="caption caption-story">
                  {story}
                </text>
              );
            })}
          </g>
        );
      })}
    </g>
  );
}

function Arcs({
  model,
  scale,
  selected,
  onSelect,
  bare,
}: {
  model: TraceModel;
  scale: Scale;
  selected: number | null;
  onSelect(msgId: number | null): void;
  bare: boolean;
}) {
  return (
    <g fill="none">
      {model.messages.map((m) => {
        const x0 = scale.x(m.send.t);
        const y0 = scale.laneMid(m.send.from);
        const y1 = scale.laneMid(m.send.to);
        const type = m.send.msg.type;
        const colour = arcColour(type);
        // Elections are the story; replication is the background hum — and in
        // the recording layout it is not drawn at all.
        const election = isElectionTraffic(type);
        if (bare && !election) return null;
        const isSelected = selected === m.send.msgId;
        const pick = (e: React.MouseEvent): void => {
          e.stopPropagation();
          onSelect(isSelected ? null : m.send.msgId);
        };
        if (m.drop !== null) {
          // Stop short. A partition drop dies at the wall between the two
          // lanes; any other drop dies part-way toward the receiver.
          const wall = wallBetween(model, m.send.t, m.send.from, m.send.to, scale);
          const xEnd = scale.x(m.drop.t) + 10;
          const yEnd = wall ?? y0 + (y1 - y0) * 0.35;
          const style = dropStyle(isSelected, election);
          return (
            <g
              key={m.send.msgId}
              className="arc"
              stroke={style.stroke}
              strokeWidth={style.width}
              opacity={style.opacity}
              onClick={pick}
            >
              <path d={`M ${x0} ${y0} L ${xEnd} ${yEnd}`} />
              {(election || isSelected) && (
                <path d={`M ${xEnd - 5} ${yEnd - 5} L ${xEnd + 5} ${yEnd + 5} M ${xEnd - 5} ${yEnd + 5} L ${xEnd + 5} ${yEnd - 5}`} strokeWidth={2} />
              )}
            </g>
          );
        }
        return m.delivers.map((d) => {
          const x1 = scale.x(d.t);
          const dx = Math.max((x1 - x0) / 2, 6);
          const style = arcStyle(isSelected, election, d.dup === true, colour);
          return (
            <g key={`${m.send.msgId}-${d.seq}`} className="arc" onClick={pick}>
              <path
                d={`M ${x0} ${y0} C ${x0 + dx} ${y0} ${x1 - dx} ${y1} ${x1} ${y1}`}
                stroke={style.stroke}
                strokeWidth={style.width}
                strokeDasharray={d.dup ? '3 3' : undefined}
                opacity={style.opacity}
              />
              {isSelected && (
                <>
                  <circle cx={x0} cy={y0} r={5} fill="#1d1d1b" />
                  <circle cx={x1} cy={y1} r={5} fill="#1d1d1b" />
                </>
              )}
            </g>
          );
        });
      })}
    </g>
  );
}

// A plain-word sentence about what a group did inside a partition window,
// computed from the role convention: how many times its nodes tried to
// become leader, and whether any succeeded. Counted only up to the playhead,
// so the failures pile up as the viewer watches rather than being announced
// in advance. Null when there is nothing to say.
export function groupStory(model: TraceModel, w: PartitionWindow, group: readonly number[], playhead: number): string | null {
  if (!model.conventions.role || playhead < w.start) return null;
  const until = Math.min(w.end, playhead);
  const ongoing = playhead < w.end;
  let attempts = 0;
  let won = 0;
  let ledThroughout = false;
  for (const node of group) {
    for (const iv of model.roles.get(node) ?? []) {
      const inside = iv.start >= w.start && iv.start < until;
      if (iv.role === 'candidate' && inside) attempts++;
      if (iv.role === 'leader' && inside) won++;
      if (iv.role === 'leader' && iv.start < w.start && iv.end >= until) ledThroughout = true;
    }
  }
  const who = listNodes(group);
  const n = `${attempts} ${attempts === 1 ? 'attempt' : 'attempts'}`;
  if (attempts === 0 && won === 0) {
    if (ledThroughout) return `${who}: kept their leader`;
    return ongoing ? `${who}: cut off` : null;
  }
  if (won === 0) return ongoing ? `${who}: ${n} so far, none won` : `${who} tried to elect a leader ${attempts} times — none won`;
  return `${who} elected a leader (${n})`;
}

// The y of the first group boundary an arc from lane a to lane b crosses,
// walking from the sender, if a partition is active at t and separates them.
function wallBetween(model: TraceModel, t: number, a: number, b: number, scale: Scale): number | null {
  const w = model.partitions.find((p) => t >= p.start && t < p.end);
  if (w === undefined || groupOf(w, a) === groupOf(w, b)) return null;
  const step = a < b ? 1 : -1;
  for (let n = a; n !== b; n += step) {
    const next = n + step;
    if (groupOf(w, n) !== groupOf(w, next)) return scale.laneTop(Math.max(n, next));
  }
  return null;
}

function dropStyle(selected: boolean, election: boolean): { stroke: string; width: number; opacity: number } {
  if (selected) return { stroke: '#1d1d1b', width: 3, opacity: 1 };
  if (election) return { stroke: '#c0392b', width: 1.6, opacity: 0.95 };
  return { stroke: '#c0392b', width: 0.8, opacity: 0.18 };
}

function arcStyle(selected: boolean, election: boolean, dup: boolean, colour: string): { stroke: string; width: number; opacity: number } {
  if (selected) return { stroke: '#1d1d1b', width: 3, opacity: 1 };
  if (election) return { stroke: colour, width: dup ? 2 : 1.4, opacity: 0.8 };
  return { stroke: colour, width: 0.7, opacity: 0.1 };
}

function Crashes({ model, scale }: { model: TraceModel; scale: Scale }) {
  return (
    <g>
      {model.crashes.map((c) => {
        const x0 = scale.x(c.start);
        const x1 = scale.x(c.end);
        const top = scale.laneTop(c.node);
        return (
          <g key={`${c.node}-${c.start}`}>
            <rect x={x0} y={top + 2} width={Math.max(x1 - x0, 2)} height={LANE - 4} fill="url(#hatch)" opacity={0.95} />
            <text x={x0 + 4} y={top + LANE / 2 + 4} className="caption caption-crash">
              crashed{c.restarted ? '' : ' (never restarted)'}
            </text>
          </g>
        );
      })}
    </g>
  );
}

function Axis({ ticks, scale, unit }: { ticks: number[]; scale: Scale; unit: TimeUnit }) {
  return (
    <g>
      {ticks.map((t) => (
        <g key={t}>
          <line x1={scale.x(t)} y1={scale.laneTop(1) - 4} x2={scale.x(t)} y2={scale.height - 16} stroke="#d9d9d2" strokeDasharray="2 4" />
          <text x={scale.x(t)} y={scale.height - 2} className="tick" textAnchor="middle">
            {formatTime(t, unit)}
          </text>
        </g>
      ))}
    </g>
  );
}
