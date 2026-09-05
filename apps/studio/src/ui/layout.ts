// Geometry shared by the timeline pieces. Everything is drawn in one SVG
// coordinate space; time maps linearly onto x.

import type { TimeUnit } from 'moirae-core';

export const WIDTH = 1400;
export const GUTTER = 96; // node labels
export const RIGHT = 24;
export const TOP = 56; // time axis and captions
export const LANE = 72;
export const LANE_PAD = 10;

export interface Scale {
  readonly x: (t: number) => number;
  readonly laneTop: (node: number) => number;
  readonly laneMid: (node: number) => number;
  readonly height: number;
  readonly plotLeft: number;
  readonly plotRight: number;
}

// The bare (recording) layout: a narrower frame drawn 1:1 with larger type,
// so the picture survives GitHub's ~800px README column and a phone.
export const BARE_WIDTH = 1000;
export const BARE_GUTTER = 84;

export function makeScale(duration: number, nodeCount: number, width = WIDTH, gutter = GUTTER): Scale {
  const plotLeft = gutter;
  const plotRight = width - RIGHT;
  const span = Math.max(duration, 1);
  return {
    x: (t) => plotLeft + (t / span) * (plotRight - plotLeft),
    laneTop: (node) => TOP + (node - 1) * LANE,
    laneMid: (node) => TOP + (node - 1) * LANE + LANE / 2,
    height: TOP + nodeCount * LANE + 16,
    plotLeft,
    plotRight,
  };
}

// How many trace time units make one millisecond (SPEC §5: v1 traces and the
// engine count milliseconds; a v2 header may say nanoseconds).
export function unitsPerMs(unit: TimeUnit): number {
  return unit === 'ns' ? 1_000_000 : 1;
}

export function formatTime(t: number, unit: TimeUnit): string {
  return `${(t / (1000 * unitsPerMs(unit))).toFixed(1)}s`;
}
