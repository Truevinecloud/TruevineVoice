/**
 * Shared PostgreSQL advisory-lock references for W6-01 dispatch control.
 *
 * A stop mutation and a paid provider invocation must serialize on the same
 * key. If each module spelled the key differently, a stop could commit while a
 * provider call was starting; keeping the reference here makes that impossible
 * to express by accident.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function requireUuid(value: string, label: string): string {
  if (typeof value !== 'string' || !UUID.test(value)) {
    throw new Error(`${label} must be a UUID.`);
  }
  return value.toLowerCase();
}

/** Serializes campaign stop mutations against provider invocation transactions. */
export function campaignDispatchLockReference(organizationId: string, campaignId: string): string {
  return `campaign-dispatch:${requireUuid(organizationId, 'organizationId')}:${requireUuid(campaignId, 'campaignId')}`;
}

/**
 * Matches the organization/currency advisory key already used by wallet
 * adjustments and usage settlement. Do not change this format independently.
 */
export function walletBalanceLockReference(organizationId: string, currency = 'UGX'): string {
  if (currency !== 'UGX') throw new Error('Only UGX wallet reservations are supported.');
  return `${requireUuid(organizationId, 'organizationId')}:${currency}`;
}

/** Minimal SQL surface shared by Prisma clients and unit-test fakes. */
export interface LockableClient {
  $executeRaw(sql: TemplateStringsArray, ...values: readonly unknown[]): Promise<number>;
}

export async function lockCampaignDispatch(
  tx: LockableClient,
  organizationId: string,
  campaignId: string,
): Promise<void> {
  await tx.$executeRaw`SELECT 1::int FROM (SELECT pg_advisory_xact_lock(hashtext(${campaignDispatchLockReference(organizationId, campaignId)})) AS lock) AS advisory_lock`;
}

/** Content with the wallet settlement/adjustment advisory key. */
export async function lockWalletBalance(
  tx: LockableClient,
  organizationId: string,
  currency = 'UGX',
): Promise<void> {
  await tx.$executeRaw`SELECT 1::int FROM (SELECT pg_advisory_xact_lock(hashtext(${walletBalanceLockReference(organizationId, currency)})) AS lock) AS advisory_lock`;
}
