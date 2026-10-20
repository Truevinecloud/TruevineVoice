import { randomUUID } from 'node:crypto';
import type {
  BillingProfile,
  BillingStore,
  LedgerRecord,
  TopUpRecord,
} from '../../src/billing/billing.store.js';
export class FakeBillingStore implements BillingStore {
  profiles = new Map<string, BillingProfile>();
  entries = new Map<string, LedgerRecord[]>();
  requests: TopUpRecord[] = [];
  async balance(organizationId: string) {
    return (this.entries.get(organizationId) ?? []).reduce((sum, row) => sum + row.amountMinor, 0n);
  }
  async transactions(organizationId: string, cursor?: string) {
    const entries = this.entries.get(organizationId) ?? [];
    return entries.slice(cursor ? entries.findIndex((row) => row.id === cursor) + 1 : 0, 51);
  }
  async profile(organizationId: string) {
    return this.profiles.get(organizationId) ?? null;
  }
  async saveProfile(organizationId: string, profile: BillingProfile) {
    this.profiles.set(organizationId, profile);
    return profile;
  }
  async topUps(organizationId: string) {
    return this.requests.filter((row) => row.organizationId === organizationId).slice(0, 50);
  }
  async requestTopUp(input: Parameters<BillingStore['requestTopUp']>[0]) {
    const existing = this.requests.find(
      (row) =>
        row.organizationId === input.organizationId && row.idempotencyKey === input.idempotencyKey,
    );
    if (existing) return existing;
    const row = { ...input, id: randomUUID(), currency: 'UGX', createdAt: new Date() };
    this.requests.push(row);
    return row;
  }
}
