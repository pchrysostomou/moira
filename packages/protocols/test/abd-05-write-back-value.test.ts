import { describe, expect, it } from 'vitest';
import { ABD } from '../src/index';
import type { ABDState, RegisterValue } from '../src/index';
import { Harness, type Sent } from './harness';

describe('ABD #5 — exact phase-2 write-back value', () => {
  it('writes back the maximum value selected by phase 1', () => {
    const h = new Harness<ABDState>(3, ABD);
    const oldValue: RegisterValue = {
      tag: { counter: 0, writerId: 0 },
      value: 'v0',
    };
    const maxValue: RegisterValue = {
      tag: { counter: 2, writerId: 1 },
      value: 'v2',
    };

    h.state(1).register = maxValue;
    h.state(2).register = oldValue;
    h.state(3).register = oldValue;

    const abd = h.proc(2) as ABD;
    abd.read(h.ctx(2));

    const deliver = (pred: (m: Sent) => boolean): void => {
      const index = h.outbox.findIndex(pred);
      expect(index).toBeGreaterThanOrEqual(0);
      h.deliver(index);
    };

    deliver((m) => m.msg.type === 'ReadPhase1Query' && m.to === 1);
    deliver((m) => m.msg.type === 'ReadPhase1Response' && m.from === 1);
    deliver((m) => m.msg.type === 'ReadPhase1Query' && m.to === 3);
    deliver((m) => m.msg.type === 'ReadPhase1Response' && m.from === 3);

    const writeBacks = h.outbox.filter((m) => m.msg.type === 'ReadPhase2WriteBack');
    expect(writeBacks).toHaveLength(2);
    for (const message of writeBacks) {
      expect(message.msg.value).toEqual(maxValue);
    }
    expect(h.logCalls.some((entry) => entry.event === 'read-complete')).toBe(false);
  });
});
