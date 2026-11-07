export type PaymentIntentStatus = 'PENDING' | 'INITIATED' | 'VERIFYING' | 'SUCCEEDED' | 'FAILED' | 'EXPIRED' | 'RECONCILIATION_REQUIRED';

export type PaymentIntentRecord = {
  id: string;
  organizationId: string;
  purpose: string;
  amountMinor: bigint;
  currency: string;
  status: PaymentIntentStatus;
  idempotencyKey: string;
  provider: string | null;
  environment: string | null;
  providerReference: string | null;
  createdAt: Date;
  updatedAt: Date;
};

export type CreatePaymentIntentInput = {
  organizationId: string;
  purpose: string;
  amountMinor: bigint;
  currency: string;
  idempotencyKey: string;
};

export interface PaymentIntentStore {
  createPending(input: CreatePaymentIntentInput): Promise<PaymentIntentRecord>;
  findById(organizationId: string, id: string): Promise<PaymentIntentRecord | null>;
  findByIdempotencyKey(organizationId: string, idempotencyKey: string): Promise<PaymentIntentRecord | null>;
}
