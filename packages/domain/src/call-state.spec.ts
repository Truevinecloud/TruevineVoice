import { describe, expect, it } from 'vitest';

import {
  CALL_TRANSITIONS,
  CallStateError,
  TERMINAL_STATES,
  canTransition,
  isTerminal,
  transition,
  type CallState,
} from './call-state.js';

const ALL_STATES: readonly CallState[] = [
  'QUEUED',
  'DIALING',
  'RINGING',
  'ANSWERED',
  'COMPLETED',
  'FAILED',
  'BUSY',
  'NO_ANSWER',
  'CANCELLED',
  'TIMEOUT',
];

describe('call state machine — happy path', () => {
  it('runs queued -> dialing -> ringing -> answered -> completed', () => {
    let state: CallState = 'QUEUED';
    for (const next of ['DIALING', 'RINGING', 'ANSWERED', 'COMPLETED'] as const) {
      const result = transition(state, next);
      expect(result.changed).toBe(true);
      state = result.state;
    }
    expect(state).toBe('COMPLETED');
  });

  it('allows dialing directly to answered (some providers skip ringing)', () => {
    expect(transition('DIALING', 'ANSWERED').changed).toBe(true);
  });
});

describe('call state machine — terminal outcomes', () => {
  it('reaches every requested outcome: busy, no-answer, failed, cancelled, timeout', () => {
    expect(transition('DIALING', 'BUSY').state).toBe('BUSY');
    expect(transition('RINGING', 'BUSY').state).toBe('BUSY');
    expect(transition('RINGING', 'NO_ANSWER').state).toBe('NO_ANSWER');
    expect(transition('DIALING', 'FAILED').state).toBe('FAILED');
    expect(transition('QUEUED', 'CANCELLED').state).toBe('CANCELLED');
    expect(transition('QUEUED', 'TIMEOUT').state).toBe('TIMEOUT');
  });

  it('marks exactly the six terminal states', () => {
    expect([...TERMINAL_STATES].sort()).toEqual(
      ['BUSY', 'CANCELLED', 'COMPLETED', 'FAILED', 'NO_ANSWER', 'TIMEOUT'].sort(),
    );
    expect(isTerminal('ANSWERED')).toBe(false);
    expect(isTerminal('QUEUED')).toBe(false);
  });

  it('gives every terminal state no outgoing edges', () => {
    for (const state of TERMINAL_STATES) {
      expect(CALL_TRANSITIONS[state]).toHaveLength(0);
    }
  });
});

describe('call state machine — illegal transitions', () => {
  it('refuses to move backwards (answered -> ringing)', () => {
    expect(() => transition('ANSWERED', 'RINGING')).toThrow(CallStateError);
  });

  it('refuses to move backwards (ringing -> dialing)', () => {
    expect(() => transition('RINGING', 'DIALING')).toThrow(CallStateError);
  });

  it('refuses a who-can-tell skip (queued -> answered)', () => {
    expect(() => transition('QUEUED', 'ANSWERED')).toThrow(CallStateError);
  });

  it('refuses ringing -> queued', () => {
    expect(() => transition('RINGING', 'QUEUED')).toThrow(CallStateError);
  });

  it('reports canTransition for legal and illegal edges without throwing', () => {
    expect(canTransition('QUEUED', 'DIALING')).toBe(true);
    expect(canTransition('QUEUED', 'ANSWERED')).toBe(false);
  });
});

describe('call state machine — duplicate and late events', () => {
  it('treats a duplicate event as a no-op, not an error', () => {
    const result = transition('RINGING', 'RINGING');
    expect(result.changed).toBe(false);
    expect(result.state).toBe('RINGING');
  });

  it('ignores a late event after a terminal state', () => {
    const result = transition('COMPLETED', 'ANSWERED');
    expect(result.changed).toBe(false);
    expect(result.state).toBe('COMPLETED');
  });

  it('ignores a duplicate terminal event', () => {
    const result = transition('FAILED', 'FAILED');
    expect(result.changed).toBe(false);
    expect(result.state).toBe('FAILED');
  });

  it('treats self-transition as a no-op for every state', () => {
    for (const state of ALL_STATES) {
      expect(transition(state, state)).toEqual({ state, changed: false });
    }
  });
});

describe('call state machine — totality and unknown states', () => {
  it('defines transitions for every known state', () => {
    for (const state of ALL_STATES) {
      expect(CALL_TRANSITIONS[state]).toBeDefined();
    }
  });

  it('rejects an unknown state', () => {
    expect(() => transition('QUEUED', 'TELEPORTED' as CallState)).toThrow(CallStateError);
  });
});
