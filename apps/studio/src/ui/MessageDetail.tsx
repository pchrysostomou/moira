import type { TraceModel } from '../trace/model';
import { messageLabel } from '../trace/labels';
import { formatTime } from './layout';

const DROP_WORDS: Readonly<Record<string, string>> = {
  partition: 'lost at the wall — a partition stopped it',
  loss: 'lost in the network',
  crashed: 'the receiver was down',
};

export function MessageDetail({ model, msgId }: { model: TraceModel; msgId: number }) {
  const m = model.byMsgId.get(msgId);
  if (m === undefined) return null;
  const type = m.send.msg.type;
  let fate: string;
  if (m.drop !== null) fate = DROP_WORDS[m.drop.reason] ?? `dropped (${m.drop.reason})`;
  else if (m.delivers.length === 0) fate = 'still in flight when the trace ended';
  else fate = m.delivers.map((d) => `delivered ${formatTime(d.t, model.unit)}${d.dup ? ' (duplicate)' : ''}`).join(', ');
  return (
    <div className="message-detail">
      <strong>{messageLabel(type)}</strong> <span className="muted">({type})</span> from node {m.send.from} to node{' '}
      {m.send.to}, sent {formatTime(m.send.t, model.unit)} — {fate}
      <details>
        <summary>payload</summary>
        <code>{JSON.stringify(m.send.msg)}</code>
      </details>
    </div>
  );
}
