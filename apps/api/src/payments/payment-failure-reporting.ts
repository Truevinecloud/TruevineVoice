/**
 * Payment processing failure reporting.
 *
 * Reads top-up reconciliation outcomes and classifies payment failures for
 * observability. Does NOT modify any payment or wallet logic: it is a
 * read-only reporting layer on top of existing reconciliation results.
 *
 * Unavailable metrics are represented as `undefined`, never as zero.
 */

export type PaymentFailureReason =
  | 'insufficient_funds'
  | 'provider_declined'
  | 'verification_failed'
  | 'reconciliation_required'
  | 'unknown';

/**
 * Classification of a payment failure for observability.
 */
export interface PaymentFailureClassification {
  readonly reason: PaymentFailureReason;
  /** Whether retrying with the same idempotency key is safe. */
  readonly retryable: boolean;
  /** Suggested retry delay in milliseconds, or undefined. */
  readonly retryAfterMs: number | undefined;
}

/**
 * Classifies a top-up reconciliation outcome into a payment failure category.
 *
 * Only non-success outcomes are classified. Success outcomes return undefined.
 */
export function classifyPaymentFailure(
  outcome: string,
): PaymentFailureClassification | undefined {
  switch (outcome) {
    case 'CREDITED':
    case 'ALREADY_RECONCILED':
      return undefined;
    case 'REJECTED':
      return {
        reason: 'provider_declined',
        retryable: false,
        retryAfterMs: undefined,
      };
    case 'UNVERIFIED':
      return {
        reason: 'verification_failed',
        retryable: true,
        retryAfterMs: 60_000,
      };
    case 'RECONCILIATION_REQUIRED':
      return {
        reason: 'reconciliation_required',
        retryable: true,
        retryAfterMs: 300_000,
      };
    default:
      return {
        reason: 'unknown',
        retryable: false,
        retryAfterMs: undefined,
      };
  }
}

/**
 * A snapshot of payment failure metrics collected at one moment.
 */
export interface PaymentFailureSnapshot {
  readonly timestamp: string;
  /** Number of reconciliation failures in the observed window. */
  readonly failureCount: number | undefined;
  /** Number of reconciliation successes in the observed window. */
  readonly successCount: number | undefined;
  /** Failures by reason, when reasons are available. */
  readonly failuresByReason: Readonly<Record<PaymentFailureReason, number>>;
  /** Whether any failure requires manual intervention. */
  readonly requiresIntervention: boolean;
}

/**
 * Creates an empty payment failure snapshot.
 */
export function emptyPaymentFailureSnapshot(): PaymentFailureSnapshot {
  return {
    timestamp: new Date().toISOString(),
    failureCount: undefined,
    successCount: undefined,
    failuresByReason: {
      insufficient_funds: 0,
      provider_declined: 0,
      verification_failed: 0,
      reconciliation_required: 0,
      unknown: 0,
    },
    requiresIntervention: false,
  };
}
