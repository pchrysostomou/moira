/**
 * Test infrastructure, not shipped API.
 *
 * Small semantic reference model for the single-writer ABD register.
 *
 * Deliberately independent from the protocol implementation: it owns its own
 * tag representation and comparison relation and contains no networking,
 * quorum, pending-operation, or handler logic.
 */
export interface ReferenceTag {
  readonly counter: number;
  readonly writerId: number;
}

export interface ReferenceValue<T = string> {
  readonly tag: ReferenceTag;
  readonly value: T;
}

export interface ReferenceState<T = string> {
  readonly register: ReferenceValue<T>;
}

export const REFERENCE_INITIAL: ReferenceValue = Object.freeze({
  tag: Object.freeze({ counter: 0, writerId: 0 }),
  value: '',
});

export function referenceCompareTags(a: ReferenceTag, b: ReferenceTag): number {
  if (a.counter < b.counter) return -1;
  if (a.counter > b.counter) return 1;
  if (a.writerId < b.writerId) return -1;
  if (a.writerId > b.writerId) return 1;
  return 0;
}

export function referenceInitialState<T = string>(): ReferenceState<T> {
  return { register: REFERENCE_INITIAL as ReferenceValue<T> };
}

/** Apply the abstract register rule: only a strictly newer tag replaces state. */
export function referenceWrite<T>(state: ReferenceState<T>, next: ReferenceValue<T>): ReferenceState<T> {
  return referenceCompareTags(next.tag, state.register.tag) > 0
    ? { register: next }
    : state;
}

export function referenceRead<T>(state: ReferenceState<T>): ReferenceValue<T> {
  return state.register;
}

export type ReferenceEvent<T = string> =
  | { readonly kind: 'write'; readonly value: ReferenceValue<T> }
  | { readonly kind: 'read'; readonly observed: ReferenceTag };

/**
 * Replay completed operations through the abstract register semantics.
 * Reads are checked against the abstract value at their chosen sequence point.
 */
export function referenceReplay<T>(events: readonly ReferenceEvent<T>[]): boolean {
  let state = referenceInitialState<T>();
  for (const event of events) {
    if (event.kind === 'write') {
      state = referenceWrite(state, event.value);
      continue;
    }
    if (referenceCompareTags(event.observed, referenceRead(state).tag) !== 0) return false;
  }
  return true;
}
