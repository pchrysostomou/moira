import { describe, expect, it } from 'vitest';
import { ABD } from '../src/index';
import type { ABDState, RegisterValue } from '../src/index';
import { Harness } from './harness';

describe('ABD #4 — monotone replica register updates', () => {
  it('must ignore an older tagged write without changing the register', () => {
    const h = new Harness<ABDState>(3, ABD);
    const newer: RegisterValue = {
      tag: { counter: 5, writerId: 1 },
      value: 'v5',
    };
    const older: RegisterValue = {
      tag: { counter: 4, writerId: 1 },
      value: 'v4',
    };

    h.state(2).register = newer;
    h.proc(2).onMessage(h.ctx(2), 1, {
      type: 'WriteRequest',
      operationId: 'w-old',
      value: older,
    });

    expect(h.state(2).register).toEqual(newer);
    expect(h.outbox).toHaveLength(1);
    expect(h.outbox[0]?.msg.type).toBe('WriteAck');
  });

  it('must treat equal-tag delivery as idempotent and preserve the first value', () => {
    const h = new Harness<ABDState>(3, ABD);
    const first: RegisterValue = {
      tag: { counter: 6, writerId: 1 },
      value: 'first',
    };
    const sameTagDifferentValue: RegisterValue = {
      tag: { counter: 6, writerId: 1 },
      value: 'conflicting',
    };

    h.state(2).register = first;
    h.proc(2).onMessage(h.ctx(2), 1, {
      type: 'WriteRequest',
      operationId: 'w-equal',
      value: sameTagDifferentValue,
    });

    expect(h.state(2).register).toEqual(first);
    expect(h.outbox.filter((m) => m.msg.type === 'WriteAck')).toHaveLength(1);
  });
});
