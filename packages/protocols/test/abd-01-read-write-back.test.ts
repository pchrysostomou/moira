import { describe, expect, it } from 'vitest';
import type { ABDState, RegisterValue } from '../src/abd/state';

/*
 * ABD.md §5 — the read write-back phase is mandatory.
 *
 * Intentionally RED in commit 1: the protocol implementation does not exist
 * yet. Commit 2 will provide the imported implementation contract.
 */
import { ABD } from '../src/abd/abd';
import { Harness } from './harness';

describe('ABD #1 — read phase-2 write-back', () => {
  it('must not complete a read after phase 1 alone', () => {
    const h = new Harness<ABDState>(3, ABD);

    const oldValue: RegisterValue = {
      tag: { counter: 0, writerId: 0 },
      value: 'v0',
    };
    const observedValue: RegisterValue = {
      tag: { counter: 1, writerId: 1 },
      value: 'v1',
    };

    // Only one replica has observed the newer value; the corresponding write
    // is intentionally incomplete.
    h.state(1).register = observedValue;
    h.state(2).register = oldValue;
    h.state(3).register = oldValue;

    const abd = h.proc(2) as ABD;
    abd.read(h.ctx(2));

    // Phase 1 queries both peers. Self-participation is local, so the harness
    // should contain exactly two network queries.
    expect(
      h.outbox.filter((m) => m.msg.type === 'ReadPhase1Query'),
    ).toHaveLength(2);

    // Deliver the two requests. Each creates one phase-1 response.
    h.deliver(0); // query node 1 -> response carrying v1
    h.deliver(0); // query node 3 -> response carrying v0

    // Deliver only the two phase-1 responses. Do NOT drain the queue: the
    // assertion below must observe the newly generated phase-2 write-back.
    h.deliver(0);
    h.deliver(0);

    // A majority observation of v1 is not enough to complete the operation.
    // Correct ABD must now issue phase-2 write-back with the exact selected
    // value and must wait for a write-back quorum before reporting completion.
    expect(
      h.outbox.filter(
        (m) =>
          m.msg.type === 'ReadPhase2WriteBack' &&
          (m.msg.value as RegisterValue).value === 'v1',
      ).length,
    ).toBeGreaterThan(0);

    expect(
      h.logCalls.some((entry) => entry.event === 'read-complete'),
    ).toBe(false);
  });
});
