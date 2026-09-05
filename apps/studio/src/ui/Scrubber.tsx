import type { TimeUnit } from 'moirae-core';
import type { Playback } from './usePlayback';
import { formatTime } from './layout';

export function Scrubber({ playback, duration, unit }: { playback: Playback; duration: number; unit: TimeUnit }) {
  return (
    <div className="scrubber">
      <button type="button" className="play" onClick={playback.toggle} aria-label={playback.playing ? 'pause' : 'play'}>
        {playback.playing ? '❚❚' : '▶'}
      </button>
      <input
        type="range"
        min={0}
        max={duration}
        step={1}
        value={Math.round(playback.t)}
        onChange={(e) => playback.seek(Number(e.target.value))}
        aria-label="playhead"
      />
      <span className="scrubber-time">
        {formatTime(playback.t, unit)} / {formatTime(duration, unit)}
      </span>
      <label className="scrubber-speed">
        speed
        <select value={playback.speed} onChange={(e) => playback.setSpeed(Number(e.target.value))}>
          <option value={0.25}>¼×</option>
          <option value={0.5}>½×</option>
          <option value={1}>1×</option>
          <option value={2}>2×</option>
        </select>
      </label>
    </div>
  );
}
