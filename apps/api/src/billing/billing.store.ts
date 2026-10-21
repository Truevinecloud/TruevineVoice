export const BILLING_STORE = Symbol('BILLING_STORE');

export interface BillingProfile {
  readonly name: string;
  readonly email: string;
  readonly address: string;
}
export interface TopUpRecord {
  readonly id: string;
  readonly organizationId: string;
  readonly idempotencyKey: string;
  readonly amountMinor: bigint;
  readonly currency: string;
  readonly createdAt: Date;
}
export interface LedgerRecord {
  readonly id: string;
  readonly amountMinor: bigint;
  readonly currency: string;
  readonly description: string;
  readonly createdAt: Date;
}
/** Every persistence operation explicitly names the tenant. No customer credit mutation exists. */
export interface BillingStore {
  balance(organizationId: string): Promise<bigint>;
  transactions(organizationId: string, cursor?: string): Promise<readonly LedgerRecord[]>;
  profile(organizationId: string): Promise<BillingProfile | null>;
  saveProfile(organizationId: string, profile: BillingProfile, actorUserId: string): Promise<BillingProfile>;
  topUps(organizationId: string): Promise<readonly TopUpRecord[]>;
  requestTopUp(input: {
    organizationId: string;
    createdById: string;
    amountMinor: bigint;
    idempotencyKey: string;
  }): Promise<TopUpRecord>;
}
