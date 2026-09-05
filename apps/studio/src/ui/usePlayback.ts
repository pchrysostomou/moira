// Playhead state: a simulated time t in [0, duration], optionally advancing
// in real time at `speed` simulated ms per real ms, whatever unit the trace
// counts in.

import type { TimeUnit } from 'moirae-core';
import { useCallback, useEffect, useRef, useState } from 'react';
import { unitsPerMs } from './layout';

export interface Playback {
  readonly t: number;
  readonly playing: boolean;
  readonly speed: number;
  seek(t: number): void;
  toggle(): void;
  setSpeed(speed: number): void;
}

export function usePlayback(duration: number, initial: number, unit: TimeUnit): Playback {
  const [t, setT] = useState(Math.min(Math.max(initial, 0), duration));
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(0.5);
  const last = useRef<number | null>(null);

  useEffect(() => {
    if (!playing) {
      last.current = null;
      return;
    }
    let frame = 0;
    const step = (now: number): void => {
      if (last.current !== null) {
        const dt = (now - last.current) * speed * unitsPerMs(unit);
        setT((cur) => {
          const next = cur + dt;
          if (next >= duration) {
            setPlaying(false);
            return duration;
          }
          return next;
        });
      }
      last.current = now;
      frame = requestAnimationFrame(step);
    };
    frame = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame);
  }, [playing, speed, duration, unit]);

  const seek = useCallback((next: number) => setT(Math.min(Math.max(next, 0), duration)), [duration]);
  const toggle = useCallback(() => {
    setPlaying((p) => {
      if (!p && t >= duration) setT(0); // play from the start when at the end
      return !p;
    });
  }, [t, duration]);

  return { t, playing, speed, seek, toggle, setSpeed };
}
