import { describe, expect, it } from 'vitest';
import { ABD, quorumSize } from '../src/index';
import type { ABDState } from '../src/index';
import { Harness } from './harness';

describe('ABD #3 — strict-majority quorum behavior', () => {
  it('requires a distinct-replica majority before read phase 2 starts', () => {
    expect(quorumSize(5)).toBe(3);

    const h = new Harness<ABDState>(5, ABD);
    const abd = h.proc(2) as ABD;
    abd.read(h.ctx(2));

    const deliverFirst = (pred: Parameters<Harness<ABDState>['deliverOnly']>[0]): void => {
      const index = h.outbox.findIndex(pred);
      expect(index).toBeGreaterThanOrEqual(0);
      h.deliver(index);
    };

    // Node 2 already supplied its local response. One distinct remote
    // response gives 2/5 participants, still below the strict majority of 3.
    deliverFirst((m) => m.msg.type === 'ReadPhase1Query' && m.to === 3);
    const response3 = h.outbox.findIndex((m) => m.msg.type === 'ReadPhase1Response' && m.from === 3);
    expect(response3).toBeGreaterThanOrEqual(0);
    h.duplicate(response3); // node 3's response arrives: 2/5, below quorum
    expect(h.outbox.filter((m) => m.msg.type === 'ReadPhase2WriteBack')).toHaveLength(0);
    expect(h.logCalls.some((entry) => entry.event === 'read-complete')).toBe(false);

    // The same response again, twice — duplicates must not manufacture quorum.
    h.duplicate(response3);
    h.deliver(response3);
    expect(h.outbox.filter((m) => m.msg.type === 'ReadPhase2WriteBack')).toHaveLength(0);

    // A second distinct remote response makes 3/5 and must start phase 2.
    deliverFirst((m) => m.msg.type === 'ReadPhase1Query' && m.to === 4);
    deliverFirst((m) => m.msg.type === 'ReadPhase1Response' && m.from === 4);
    expect(h.outbox.filter((m) => m.msg.type === 'ReadPhase2WriteBack')).toHaveLength(4);
    expect(h.logCalls.some((entry) => entry.event === 'read-complete')).toBe(false);
  });

  it('requires a distinct write-back acknowledgement majority before read completion', () => {
    const h = new Harness<ABDState>(5, ABD);
    const abd = h.proc(2) as ABD;
    abd.read(h.ctx(2));

    const deliverFirst = (pred: Parameters<Harness<ABDState>['deliverOnly']>[0]): void => {
      const index = h.outbox.findIndex(pred);
      expect(index).toBeGreaterThanOrEqual(0);
      h.deliver(index);
    };

    // Produce three distinct remote phase-1 responses. Together with the
    // reader's local response this is already beyond the minimum quorum.
    for (const node of [3, 4, 5]) {
      deliverFirst((m) => m.msg.type === 'ReadPhase1Query' && m.to === node);
      deliverFirst((m) => m.msg.type === 'ReadPhase1Response' && m.from === node);
    }
    expect(h.outbox.filter((m) => m.msg.type === 'ReadPhase2WriteBack')).toHaveLength(4);

    // Local participation counts as one write-back acknowledgement. One
    // distinct remote ack therefore leaves us at 2/5, below quorum.
    deliverFirst((m) => m.msg.type === 'ReadPhase2WriteBack' && m.to === 1);
    expect(h.outbox.filter((m) => m.msg.type === 'ReadPhase2Ack')).toHaveLength(1);
    const ack1 = h.outbox.findIndex((m) => m.msg.type === 'ReadPhase2Ack' && m.from === 1);
    expect(ack1).toBeGreaterThanOrEqual(0);
    h.duplicate(ack1);
    h.deliver(ack1);
    expect(h.logCalls.some((entry) => entry.event === 'read-complete')).toBe(false);

    // A second distinct remote acknowledgement reaches 3/5 and is the first
    // point at which the read may complete.
    deliverFirst((m) => m.msg.type === 'ReadPhase2WriteBack' && m.to === 3);
    deliverFirst((m) => m.msg.type === 'ReadPhase2Ack' && m.from === 3);
    expect(h.logCalls.some((entry) => entry.event === 'read-complete')).toBe(true);
  });
});
