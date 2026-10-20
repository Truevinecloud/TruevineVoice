/** UGX-only amounts cross JSON as integer strings, never JavaScript numbers. */
export interface Wallet {
  readonly currency: 'UGX';
  readonly amountMinor: string;
}
export interface Transaction extends Wallet {
  readonly id: string;
  readonly description: string;
  readonly createdAt: string;
}
export interface Transactions {
  readonly entries: readonly Transaction[];
  readonly nextCursor: string | null;
}
export interface BillingProfile {
  readonly name: string;
  readonly email: string;
  readonly address: string;
}
export interface TopUp extends Wallet {
  readonly id: string;
  readonly status: 'PENDING';
  readonly createdAt: string;
}
export interface Billing {
  readonly profile: BillingProfile | null;
  readonly topUps: readonly TopUp[];
  readonly collectionAvailable: false;
}
export function formatUgx(amountMinor: string): string {
  return `UGX ${BigInt(amountMinor).toLocaleString('en-UG')}`;
}
