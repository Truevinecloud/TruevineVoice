import { describe, expect, it } from 'vitest';

import { CALLBACK_SOURCES } from '../../callback-sources.js';
import {
  CallbackNormalizationError,
  normalizeAfricaTalkingCallback,
} from './africa-talking-callback.js';

const receivedAt = new Date('2026-11-23T12:00:00.000Z');

function payload(overrides: Record<string, unknown> = {}) {
  return {
    sessionId: 'ATVId_0496051a90c295c4fa62fac955555a6b',
    callSessionState: 'Bridged',
    isActive: '1',
    ...overrides,
  };
}

function codeOf(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    if (error instanceof CallbackNormalizationError) return error.code;
    throw error;
  }
  throw new Error('Expected normalization to fail.');
}

describe('Africa’s Talking callback normalization', () => {
  it('maps documented states without inventing status values', () => {
    const cases = [
      ['Dialing', '1', 'DIALING'],
      ['Ringing', 1, 'RINGING'],
      ['Bridged', '1', 'ANSWERED'],
      ['Completed', '0', 'COMPLETED'],
      ['NotAnswered', 0, 'NO_ANSWER'],
      ['Expired', '0', 'FAILED'],
    ] as const;

    for (const [callSessionState, isActive, expected] of cases) {
      const event = normalizeAfricaTalkingCallback(
        payload({ callSessionState, isActive }),
        receivedAt,
      );
      expect(event.state).toBe(expected);
      expect(event.source).toBe(CALLBACK_SOURCES.africasTalking);
    }
  });

  it('rejects documented but ambiguous or unsupported event words', () => {
    for (const callSessionState of ['Active', 'Enqueued', 'Dequeued', 'Aborted']) {
      expect(codeOf(() => normalizeAfricaTalkingCallback(
        payload({ callSessionState, isActive: '1' }),
        receivedAt,
      ))).toBe('unsupported_state');
    }
    expect(codeOf(() => normalizeAfricaTalkingCallback(
      payload({ callSessionState: '', isActive: '1' }),
      receivedAt,
    ))).toBe('invalid_state');
  });

  it('keeps receipt time separate from provider event time', () => {
    const event = normalizeAfricaTalkingCallback(payload(), receivedAt);
    expect(event.eventTime).toBeNull();
    expect(event.receivedAt).toBe(receivedAt);
    expect(event.occurredAt).toBe(receivedAt);
  });

  it('validates the session identifier and active flag for consistency', () => {
    expect(codeOf(() => normalizeAfricaTalkingCallback(
      payload({ sessionId: 'None' }),
      receivedAt,
    ))).toBe('invalid_session_id');
    expect(codeOf(() => normalizeAfricaTalkingCallback(
      payload({ sessionId: 'has spaces' }),
      receivedAt,
    ))).toBe('invalid_session_id');
    expect(codeOf(() => normalizeAfricaTalkingCallback(
      payload({ isActive: 'yes' }),
      receivedAt,
    ))).toBe('invalid_is_active');
    expect(codeOf(() => normalizeAfricaTalkingCallback(
      payload({ callSessionState: 'Completed', isActive: '1' }),
      receivedAt,
    ))).toBe('inconsistent_is_active');
    expect(codeOf(() => normalizeAfricaTalkingCallback(
      payload({ callSessionState: 'Ringing', isActive: '0' }),
      receivedAt,
    ))).toBe('inconsistent_is_active');
  });

  it('rejects malformed and undocumented payload shapes', () => {
    expect(codeOf(() => normalizeAfricaTalkingCallback(null, receivedAt))).toBe('invalid_body');
    expect(codeOf(() => normalizeAfricaTalkingCallback([], receivedAt))).toBe('invalid_body');
    expect(codeOf(() => normalizeAfricaTalkingCallback(
      { ...payload(), status: 'Completed' },
      receivedAt,
    ))).toBe('unsupported_field');
    expect(codeOf(() => normalizeAfricaTalkingCallback(
      { sessionId: 'ATVId_abc' },
      receivedAt,
    ))).toBe('invalid_state');
  });

  it('accepts documented context fields and bounded non-authoritative evidence', () => {
    const first = normalizeAfricaTalkingCallback(payload({
      direction: 'Outbound',
      callerCountryCode: '254',
      callerNumber: '+254705336634',
      destinationNumber: '+254711082369',
      callStartTime: 'None',
      clientRequestId: 'campaign-1',
      durationInSeconds: '12',
      currencyCode: 'KES',
      amount: '1.2300',
      errorMessage: '',
      hangupCause: 'NORMAL_CLEARING',
    }), receivedAt);

    expect(first.evidence).toEqual({
      durationSeconds: 12,
      currencyCode: 'KES',
      amount: '1.2300',
      errorMessage: '',
      hangupCause: 'NORMAL_CLEARING',
    });

    const second = normalizeAfricaTalkingCallback(payload({
      durationInSeconds: '99',
      currencyCode: 'UGX',
      amount: '5000',
    }), receivedAt);
    expect(second.eventKey).toBe(first.eventKey);
  });

  it('rejects malformed optional evidence rather than coercing it', () => {
    expect(codeOf(() => normalizeAfricaTalkingCallback(
      payload({ durationInSeconds: '-1' }),
      receivedAt,
    ))).toBe('invalid_optional_field');
    expect(codeOf(() => normalizeAfricaTalkingCallback(
      payload({ currencyCode: 'KES ' }),
      receivedAt,
    ))).toBe('invalid_optional_field');
    expect(codeOf(() => normalizeAfricaTalkingCallback(
      payload({ destinationNumber: '0711082369' }),
      receivedAt,
    ))).toBe('invalid_optional_field');
  });

  it('uses a stable event key for exact retries and separates different states', () => {
    const first = normalizeAfricaTalkingCallback(payload(), receivedAt);
    const retry = normalizeAfricaTalkingCallback(payload(), new Date('2026-11-23T13:00:00Z'));
    const later = normalizeAfricaTalkingCallback(
      payload({ callSessionState: 'Completed', isActive: '0' }),
      receivedAt,
    );

    expect(retry.eventKey).toBe(first.eventKey);
    expect(later.eventKey).not.toBe(first.eventKey);
  });
});
