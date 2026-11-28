import { describe, expect, it } from 'vitest';

import {
  classifyPaymentFailure,
  emptyPaymentFailureSnapshot,
  type PaymentFailureClassification,
  type PaymentFailureReason,
} from './payment-failure-reporting.js';

describe('payment failure reporting', () => {
  it('returns undefined for successful outcomes', () => {
    expect(classifyPaymentFailure('CREDITED')).toBeUndefined();
    expect(classifyPaymentFailure('ALREADY_RECONCILED')).toBeUndefined();
  });

  it('classifies REJECTED as provider_declined and not retryable', () => {
    const result = classifyPaymentFailure('REJECTED');

    expect(result).toBeDefined();
    expect(result!.reason).toBe('provider_declined');
    expect(result!.retryable).toBe(false);
    expect(result!.retryAfterMs).toBeUndefined();
  });

  it('classifies UNVERIFIED as verification_failed and retryable', () => {
    const result = classifyPaymentFailure('UNVERIFIED');

    expect(result).toBeDefined();
    expect(result!.reason).toBe('verification_failed');
    expect(result!.retryable).toBe(true);
    expect(result!.retryAfterMs).toBe(60_000);
  });

  it('classifies RECONCILIATION_REQUIRED as retryable', () => {
    const result = classifyPaymentFailure('RECONCILIATION_REQUIRED');

    expect(result).toBeDefined();
    expect(result!.reason).toBe('reconciliation_required');
    expect(result!.retryable).toBe(true);
    expect(result!.retryAfterMs).toBe(300_000);
  });

  it('classifies unknown outcomes as unknown and not retryable', () => {
    const result = classifyPaymentFailure('UNKNOWN_OUTCOME');

    expect(result).toBeDefined();
    expect(result!.reason).toBe('unknown');
    expect(result!.retryable).toBe(false);
  });

  it('emptyPaymentFailureSnapshot returns zeroed structure', () => {
    const snapshot = emptyPaymentFailureSnapshot();

    expect(snapshot.failureCount).toBeUndefined();
    expect(snapshot.successCount).toBeUndefined();
    expect(snapshot.failuresByReason.insufficient_funds).toBe(0);
    expect(snapshot.failuresByReason.provider_declined).toBe(0);
    expect(snapshot.failuresByReason.verification_failed).toBe(0);
    expect(snapshot.failuresByReason.reconciliation_required).toBe(0);
    expect(snapshot.failuresByReason.unknown).toBe(0);
    expect(snapshot.requiresIntervention).toBe(false);
    expect(typeof snapshot.timestamp).toBe('string');
  });

  it('has correct type shape', () => {
    const classification: PaymentFailureClassification = {
      reason: 'provider_declined' as PaymentFailureReason,
      retryable: false,
      retryAfterMs: undefined,
    };
    expect(classification.reason).toBe('provider_declined');
    expect(classification.retryable).toBe(false);
  });
});
