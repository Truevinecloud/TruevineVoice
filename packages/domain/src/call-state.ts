/**
 * The outbound call lifecycle as an explicit state machine.
 *
 * ARCHITECTURAL RULES ENFORCED HERE
 * ---------------------------------
 * - A call is a long-lived, money-affecting entity driven by asynchronous events
 *   (a queue dispatch, provider callbacks, operator action, timeouts). Scattered
 *   status strings let an out-of-order provider event move a completed call back
 *   to "ringing". This module makes the legal moves the only expressible ones.
 * - Provider events arrive more than once and out of order. Duplicate and
 *   late-arriving events must be idempotent no-ops that report "no change",
 *   never illegal transitions and never a second chargeable state.
 * - This module is pure: no I/O, no clocks, no provider SDK.
 */

/**
 * Every state an outbound call can be in.
 *
 * - `QUEUED`   - accepted, waiting to be dispatched.
 * - `DIALING`  - dispatch has begun; the provider is being asked to place it.
 * - `RINGING`  - the provider reports the destination is ringing.
 * - `ANSWERED` - the destination answered; billable time may accrue.
 * - `COMPLETED`- the call ended normally after being answered. Terminal.
 * - `FAILED`   - a terminal error prevented or ended the call. Terminal.
 * - `BUSY`     - the destination was busy. Terminal.
 * - `NO_ANSWER`- the call rang but was not answered. Terminal.
 * - `CANCELLED`- cancelled on our side before completion. Terminal.
 * - `TIMEOUT`  - no terminal provider event arrived within the deadline. Terminal.
 */
export type CallState =
  | 'QUEUED'
  | 'DIALING'
  | 'RINGING'
  | 'ANSWERED'
  | 'COMPLETED'
  | 'FAILED'
  | 'BUSY'
  | 'NO_ANSWER'
  | 'CANCELLED'
  | 'TIMEOUT';

/** Raised when a state transition is not legal. */
export class CallStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CallStateError';
  }
}

/** The states from which no further transition is permitted. */
export const TERMINAL_STATES: readonly CallState[] = Object.freeze([
  'COMPLETED',
  'FAILED',
  'BUSY',
  'NO_ANSWER',
  'CANCELLED',
  'TIMEOUT',
]);

const TERMINAL_SET: ReadonlySet<CallState> = new Set(TERMINAL_STATES);

/**
 * The legal transition graph.
 *
 * Each entry lists the states reachable *from* the keyed state. Terminal states
 * map to an empty list. The graph is total over `CallState` by construction of
 * the constant's type, so a new state cannot be added without stating its edges.
 */
export const CALL_TRANSITIONS: Readonly<Record<CallState, readonly CallState[]>> = Object.freeze({
  QUEUED: Object.freeze(['DIALING', 'CANCELLED', 'FAILED', 'TIMEOUT']),
  DIALING: Object.freeze(['RINGING', 'ANSWERED', 'BUSY', 'NO_ANSWER', 'FAILED', 'CANCELLED', 'TIMEOUT']),
  RINGING: Object.freeze(['ANSWERED', 'BUSY', 'NO_ANSWER', 'FAILED', 'CANCELLED', 'TIMEOUT']),
  ANSWERED: Object.freeze(['COMPLETED', 'FAILED', 'TIMEOUT']),
  COMPLETED: Object.freeze([]),
  FAILED: Object.freeze([]),
  BUSY: Object.freeze([]),
  NO_ANSWER: Object.freeze([]),
  CANCELLED: Object.freeze([]),
  TIMEOUT: Object.freeze([]),
} satisfies Record<CallState, readonly CallState[]>);

/** True when the state is terminal. */
export function isTerminal(state: CallState): boolean {
  return TERMINAL_SET.has(state);
}

/**
 * The outcome of applying an event to a state.
 *
 * `changed: false` means the event was a duplicate or late arrival that left the
 * state untouched. Callers MUST treat that as success, not as an error: it is
 * how out-of-order or repeated provider events are tolerated.
 */
export interface TransitionResult {
  readonly state: CallState;
  readonly changed: boolean;
}

/**
 * Applies a target state to a current state, idempotently.
 *
 * - If `to === from`, the event is a duplicate and returns `{ changed: false }`.
 *   This is the duplicate-event rule: re-delivering the same event is a no-op.
 * - If `from` is terminal, the event is late; returns `{ changed: false }` so a
 *   stray provider callback cannot resurrect a finished call.
 * - If the edge exists, returns the new state with `changed: true`.
 * - Otherwise it is an illegal transition and throws `CallStateError`.
 */
export function transition(from: CallState, to: CallState): TransitionResult {
  assertKnownState(from, 'from');
  assertKnownState(to, 'to');

  if (from === to) {
    return { state: from, changed: false };
  }
  if (isTerminal(from)) {
    // A late event after the call finished. Tolerated as a no-op, never applied.
    return { state: from, changed: false };
  }
  const allowed = CALL_TRANSITIONS[from];
  if (!allowed.includes(to)) {
    throw new CallStateError(`Illegal call transition: ${from} -> ${to}.`);
  }
  return { state: to, changed: true };
}

/** True when `to` is reachable from `from` in one legal step. */
export function canTransition(from: CallState, to: CallState): boolean {
  assertKnownState(from, 'from');
  assertKnownState(to, 'to');
  if (from === to) return true;
  if (isTerminal(from)) return false;
  return CALL_TRANSITIONS[from].includes(to);
}

function assertKnownState(state: CallState, label: string): void {
  if (!Object.prototype.hasOwnProperty.call(CALL_TRANSITIONS, state)) {
    throw new CallStateError(`Unknown call state (${label}): ${String(state)}.`);
  }
}
