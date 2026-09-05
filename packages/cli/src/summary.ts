// A plain-text account of a trace: what happened, in order, and how it
// ended. Pure: JSONL in, lines out. Works on any protocol's trace; the
// role/term lines appear only when the state carries the SPEC §9 fields.

interface Ev {
  readonly kind: string;
  readonly t: number;
  readonly [k: string]: unknown;
}

export function summarize(jsonl: string): string {
  const lines = jsonl.split('\n').filter((l) => l.length > 0);
  const header = JSON.parse(lines[0] ?? '{}') as { seed?: number; nodes?: number; kind?: string; unit?: string };
  if (header.kind !== 'header') throw new Error('not a moirae trace: no header line');
  // SPEC §5: a v2 header says what t counts in; v1 traces count milliseconds.
  const perSecond = header.unit === 'ns' ? 1_000_000_000 : 1000;
  const fmt = (t: number): string => `${(t / perSecond).toFixed(2)}s`;
  const events = lines.slice(1).map((l) => JSON.parse(l) as Ev);
  const nodes = header.nodes ?? 0;
  const out: string[] = [];

  // Fold state per node to know roles and terms as they change.
  const state: Record<string, unknown>[] = Array.from({ length: nodes }, () => ({}));
  const crashed: boolean[] = Array.from({ length: nodes }, () => false);
  const timeline: string[] = [];
  let sends = 0;
  let delivers = 0;
  let dups = 0;
  const drops: Record<string, number> = {};

  for (const e of events) {
    switch (e.kind) {
      case 'state': {
        const node = e['node'] as number;
        const patch = e['patch'] as Record<string, unknown>;
        const s = state[node - 1] as Record<string, unknown>;
        for (const [k, v] of Object.entries(patch)) {
          if (v === null) delete s[k];
          else s[k] = v;
        }
        if (patch['role'] === 'leader') {
          const term = s['currentTerm'] ?? s['term'];
          timeline.push(`${fmt(e.t)}  node ${node} became leader${typeof term === 'number' ? ` (term ${term})` : ''}`);
        }
        break;
      }
      case 'fault': {
        const f = e['fault'];
        if (f === 'partition') timeline.push(`${fmt(e.t)}  partition ${JSON.stringify(e['groups'])}`);
        if (f === 'heal') timeline.push(`${fmt(e.t)}  partition healed`);
        if (f === 'crash') {
          crashed[(e['node'] as number) - 1] = true;
          timeline.push(`${fmt(e.t)}  node ${e['node']} crashed (kept ${JSON.stringify(e['persisted'])})`);
        }
        if (f === 'restart') {
          crashed[(e['node'] as number) - 1] = false;
          state[(e['node'] as number) - 1] = {};
          timeline.push(`${fmt(e.t)}  node ${e['node']} restarted`);
        }
        break;
      }
      case 'send':
        sends++;
        break;
      case 'deliver':
        delivers++;
        if (e['dup'] === true) dups++;
        break;
      case 'drop': {
        const reason = String(e['reason']);
        drops[reason] = (drops[reason] ?? 0) + 1;
        break;
      }
      case 'violation':
        timeline.push(`${fmt(e.t)}  INVARIANT VIOLATED: ${e['invariant']} — ${e['detail']}`);
        break;
      default:
        break;
    }
  }

  const last = events.at(-1);
  out.push(`seed ${header.seed}, ${nodes} nodes, ${fmt(last?.t ?? 0)} of simulated time, ${events.length} trace events`);
  out.push('');
  out.push(...timeline);
  out.push('');
  const dropText = Object.entries(drops)
    .map(([r, n]) => `${n} ${r}`)
    .join(', ');
  out.push(`${sends} messages sent, ${delivers} delivered (${dups} duplicates), ${Object.values(drops).reduce((a, b) => a + b, 0)} lost${dropText ? ` (${dropText})` : ''}`);
  out.push('');

  const summaries = state.map((s, i) => {
    if (crashed[i]) return `node ${i + 1}: crashed`;
    const parts: string[] = [];
    if (typeof s['role'] === 'string') parts.push(s['role']);
    const term = s['currentTerm'] ?? s['term'];
    if (typeof term === 'number') parts.push(`term ${term}`);
    if (Array.isArray(s['log'])) parts.push(`${s['log'].length} log entries`);
    if (typeof s['commitIndex'] === 'number') parts.push(`${s['commitIndex']} committed`);
    if (Array.isArray(s['applied'])) parts.push(`${s['applied'].length} applied`);
    return `node ${i + 1}: ${parts.join(', ') || JSON.stringify(s)}`;
  });
  out.push(...summaries);

  const applied = state.filter((_, i) => !crashed[i]).map((s) => JSON.stringify(s['applied'] ?? null));
  if (applied.length > 1 && applied.every((a) => a !== 'null')) {
    const same = applied.every((a) => a === applied[0]);
    out.push('');
    out.push(same ? 'every live node applied the same sequence' : 'LIVE NODES DISAGREE on what they applied');
  }
  return out.join('\n');
}
