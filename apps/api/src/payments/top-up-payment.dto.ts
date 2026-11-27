/**
 * Provider-neutral payment DTOs for W5-02 synthetic local testing only.
 *
 * These shapes do not describe any real mobile-money provider. They are the
 * internal contract between the synthetic top-up integration service and its
 * local-only consumers.
 */

export const SYNTHETIC_PAYMENT_PROVIDER = 'SYNTHETIC_SANDBOX';
export const SYNTHETIC_PAYMENT_ENVIRONMENT = 'SANDBOX';
export const SYNTHETIC_PAYMENT_CURRENCY = 'UGX';

export interface CreateSyntheticTopUpInput {
  readonly organizationId: string;
  readonly actorUserId: string;
  readonly amountMinor: string;
  readonly idempotencyKey: string;
}

export interface SyntheticTopUpResult {
  readonly topUpRequestId: string;
  readonly paymentIntentId: string;
  readonly providerReference: string;
  readonly status: 'PENDING';
}

export interface SyntheticSettlementCallback {
  readonly provider: typeof SYNTHETIC_PAYMENT_PROVIDER;
  readonly environment: typeof SYNTHETIC_PAYMENT_ENVIRONMENT;
  readonly eventId: string;
  readonly providerReference: string;
  readonly status: 'SUCCESS' | 'FAILED' | 'PENDING';
  readonly amountMinor: string;
  readonly currency: typeof SYNTHETIC_PAYMENT_CURRENCY;
  readonly signature: string;
}

export interface SyntheticSettlementOutcome {
  readonly outcome:
    | 'CREDITED'
    | 'ALREADY_RECONCILED'
    | 'REJECTED'
    | 'RECONCILIATION_REQUIRED'
    | 'UNVERIFIED';
  readonly eventId: string | null;
  readonly organizationId: string | null;
  readonly walletEntryId: string | null;
}

export interface SyntheticPaymentStatus {
  readonly paymentIntentId: string;
  readonly organizationId: string;
  readonly status: 'PENDING' | 'INITIATED' | 'VERIFYING' | 'SUCCEEDED' | 'FAILED' | 'EXPIRED' | 'RECONCILIATION_REQUIRED';
  readonly amountMinor: string;
  readonly currency: string;
  readonly walletEntryId: string | null;
}

export interface SyntheticWalletBalance {
  readonly organizationId: string;
  readonly currency: string;
  readonly amountMinor: string;
}