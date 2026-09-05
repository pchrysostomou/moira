// The studio is a pure function of a trace file (ADR-003): it reads JSONL,
// derives, renders. It never runs a simulation and imports nothing from the
// engine but the trace schema type — enforced by lint.
//
// A trace arrives one of three ways: a file picked or dropped (produced by
// anyone, on any machine), a URL (?trace=), or a string embedded by a
// single-file export (window.__MOIRAE_TRACE__). ?t= sets the playhead.

import { useCallback, useEffect, useState, type DragEvent } from 'react';
import { deriveModel, type TraceModel } from './trace/model';
import { TraceParseError, parseJsonl } from './trace/parse';
import { formatTime } from './ui/layout';
import { Legend } from './ui/Legend';
import { MessageDetail } from './ui/MessageDetail';
import { Scrubber } from './ui/Scrubber';
import { StatePanel } from './ui/StatePanel';
import { Timeline } from './ui/Timeline';
import { usePlayback } from './ui/usePlayback';

type Status =
  | { kind: 'idle' }
  | { kind: 'loading'; source: string }
  | { kind: 'error'; source: string; message: string }
  | { kind: 'ready'; source: string; model: TraceModel };

// ?trace= is user input: accept only http(s) URLs or paths resolved against
// this page, never other schemes.
function traceUrl(raw: string): string | null {
  try {
    const u = new URL(raw, window.location.href);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.href : null;
  } catch {
    return null;
  }
}

function explain(err: unknown): string {
  if (err instanceof TraceParseError) {
    return `${err.message}. This does not look like a moirae v1 trace — expected JSONL with a header line first (SPEC §5).`;
  }
  return err instanceof Error ? err.message : String(err);
}

export function App() {
  const [status, setStatus] = useState<Status>({ kind: 'idle' });

  const load = useCallback((source: string, text: string): void => {
    try {
      setStatus({ kind: 'ready', source, model: deriveModel(parseJsonl(text)) });
    } catch (err) {
      setStatus({ kind: 'error', source, message: explain(err) });
    }
  }, []);

  const loadFile = useCallback(
    (file: File): void => {
      setStatus({ kind: 'loading', source: file.name });
      file
        .text()
        .then((text) => load(file.name, text))
        .catch((err: unknown) => setStatus({ kind: 'error', source: file.name, message: explain(err) }));
    },
    [load],
  );

  useEffect(() => {
    const embedded = (window as unknown as { __MOIRAE_TRACE__?: unknown }).__MOIRAE_TRACE__;
    if (typeof embedded === 'string') {
      load('embedded trace', embedded);
      return;
    }
    const raw = new URLSearchParams(window.location.search).get('trace');
    if (raw === null) return;
    const url = traceUrl(raw);
    if (url === null) {
      setStatus({ kind: 'error', source: raw, message: 'only http(s) URLs or paths on this site can be loaded' });
      return;
    }
    setStatus({ kind: 'loading', source: url });
    fetch(url)
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.text();
      })
      .then((text) => load(url, text))
      .catch((err: unknown) => setStatus({ kind: 'error', source: url, message: explain(err) }));
  }, [load]);

  const onDrop = (e: DragEvent<HTMLElement>): void => {
    e.preventDefault();
    const file = e.dataTransfer.files[0];
    if (file !== undefined) loadFile(file);
  };

  const isBare = bare();
  return (
    <main className={isBare ? 'studio studio-bare' : 'studio'} onDragOver={(e) => e.preventDefault()} onDrop={onDrop}>
      <header className="studio-header" hidden={isBare && status.kind === 'ready'}>
        <div className="studio-title">
          <h1>moirae studio</h1>
          <label className="file-button">
            open a trace…
            <input
              type="file"
              accept=".jsonl,application/jsonl,text/plain"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file !== undefined) loadFile(file);
                e.target.value = '';
              }}
            />
          </label>
        </div>
        {status.kind === 'loading' && <p className="muted">Loading {status.source}…</p>}
        {status.kind === 'error' && (
          <p className="error">
            Could not open {status.source}: {status.message}
          </p>
        )}
        {status.kind === 'ready' && (
          <p className="muted">
            {status.source} — seed {status.model.header.seed}, {status.model.nodes.length} nodes,{' '}
            {status.model.messages.length} messages, {formatTime(status.model.duration, status.model.unit)} of simulated time
          </p>
        )}
      </header>
      {status.kind === 'ready' ? <Viewer key={status.source} model={status.model} /> : <Landing />}
    </main>
  );
}

function Landing() {
  return (
    <section className="landing">
      <p>
        Drop a <code>.jsonl</code> trace here, or open one with the button above. A trace is what the moirae engine
        writes; it replays byte for byte on any machine.
      </p>
      <p className="muted">
        To make the example traces: <code>pnpm examples</code>, then open <code>?trace=/clean-partition.jsonl</code>{' '}
        or <code>?trace=/harsh.jsonl</code>. Add <code>&amp;t=2600</code> to start the playhead 2600 trace time units in — 2.6 seconds
        for an engine trace, which counts milliseconds; a v2 header says what <code>t</code> counts.
      </p>
    </section>
  );
}

function initialPlayhead(duration: number): number {
  const raw = new URLSearchParams(window.location.search).get('t');
  const t = raw === null ? Number.NaN : Number(raw);
  return Number.isFinite(t) ? t : duration;
}

// ?chrome=0 shows the legend and the timeline alone — for recordings and
// embeds; the playhead still comes from ?t=.
function bare(): boolean {
  return new URLSearchParams(window.location.search).get('chrome') === '0';
}

function Viewer({ model }: { model: TraceModel }) {
  const playback = usePlayback(model.duration, initialPlayhead(model.duration), model.unit);
  const [selected, setSelected] = useState<number | null>(null);
  const isBare = bare();

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return;
      if (e.key === ' ') {
        e.preventDefault();
        playback.toggle();
      } else if (e.key === 'ArrowLeft') playback.seek(playback.t - 50);
      else if (e.key === 'ArrowRight') playback.seek(playback.t + 50);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [playback]);

  if (isBare) {
    return (
      <div className="bare">
        <Legend model={model} />
        <Timeline model={model} playhead={playback.t} selected={null} bare onSeek={playback.seek} onSelect={() => undefined} />
      </div>
    );
  }
  return (
    <>
      <Legend model={model} />
      <Scrubber playback={playback} duration={model.duration} unit={model.unit} />
      <Timeline model={model} playhead={playback.t} selected={selected} onSeek={playback.seek} onSelect={setSelected} />
      {selected !== null && <MessageDetail model={model} msgId={selected} />}
      <StatePanel model={model} t={playback.t} />
    </>
  );
}
