import { randomUUID } from 'node:crypto';
import { Test } from '@nestjs/testing';
import { describe, expect, it } from 'vitest';

import { BillingAdminService } from '../src/billing-admin/billing-admin.service.js';
import { BILLING_ADMIN_STORE } from '../src/billing-admin/tokens.js';
import type { BillingAdminStore, BillingAdminWalletEntry } from '../src/billing-admin/billing-admin.store.js';
import { AUDIT_STORE } from '../src/auth/tokens.js';
import { AUDITOR_STORE } from '../src/audit/tokens.js';
import { FakeAuditStore } from './fakes/auth.fakes.js';
const ORG_ID = '11111111-1111-1111-1111-111111111111';

class FakeBillingAdminStore implements BillingAdminStore {
  organizations = [
    {
      id: ORG_ID,
      name: 'Org One',
      slug: 'org-one',
      status: 'ACTIVE' as const,
      createdAt: new Date('2026-01-01T00:00:00Z'),
      memberCount: 1,
      campaignCount: 0,
      billingProfilePresent: true,
      walletBalances: [],
      topUpRequests: [],
    },
  ];
  private entries = new Map<string, BillingAdminWalletEntry>();

  async listOrganizations() {
    return this.organizations;
  }
  async findOrganization(id: string) {
    return this.organizations.find((organization) => organization.id === id);
  }
  async walletEntries() {
    return [];
  }
  async topUpRequests() {
    return [];
  }
  async adjustWallet(input: {
    organizationId: string;
    actorUserId: string;
    amountMinor: bigint;
    currency: string;
    reason: string;
    idempotencyKey: string;
  }) {
    const reference = `billing-adjustment:${input.idempotencyKey}`;
    const existing = [...this.entries.values()].find((entry) => entry.reference === reference);
    if (existing) {
      if (existing.amountMinor !== input.amountMinor || existing.currency !== input.currency) {
        throw new Error('idempotency_conflict');
      }
      return { entry: existing, created: false };
    }
    const entry: BillingAdminWalletEntry = {
      id: randomUUID(),
      amountMinor: input.amountMinor,
      currency: input.currency,
      reference,
      description: input.reason,
      createdAt: new Date(),
    };
    this.entries.set(entry.id, entry);
    return { entry, created: true };
  }
}

describe('BillingAdminService adjustments', () => {
  it('records a successful adjustment and identity/security audit evidence', async () => {
    const store = new FakeBillingAdminStore();
    const audit = new FakeAuditStore();
    const auditor = { platformAuditEvents: async () => [] };
    const module = await Test.createTestingModule({
      providers: [
        BillingAdminService,
        { provide: BILLING_ADMIN_STORE, useValue: store },
        { provide: AUDIT_STORE, useValue: audit },
        { provide: AUDITOR_STORE, useValue: auditor },
      ],
    }).compile();
    const service = module.get(BillingAdminService);

    const result = await service.adjustWallet('user-1', ORG_ID, {
      amountMinor: '5000',
      currency: 'UGX',
      reason: 'Correction',
      idempotencyKey: randomUUID(),
    });

    expect(result.created).toBe(true);
    expect(result.entry.amountMinor).toBe('5000');
    expect(audit.identityEvents.map((event) => event.action)).toContain('platform.billing.wallet_adjusted');
    expect(audit.events.map((event) => event.action)).toContain('platform.billing.wallet_adjusted');
  });

  it('rejects an unknown organization before mutating', async () => {
    const store = new FakeBillingAdminStore();
    const audit = new FakeAuditStore();
    const auditor = { platformAuditEvents: async () => [] };
    const module = await Test.createTestingModule({
      providers: [
        BillingAdminService,
        { provide: BILLING_ADMIN_STORE, useValue: store },
        { provide: AUDIT_STORE, useValue: audit },
        { provide: AUDITOR_STORE, useValue: auditor },
      ],
    }).compile();
    const service = module.get(BillingAdminService);

    await expect(
      service.adjustWallet('user-1', randomUUID(), {
        amountMinor: '5000',
        currency: 'UGX',
        reason: 'Correction',
        idempotencyKey: randomUUID(),
      }),
    ).rejects.toMatchObject({ status: 404 });
  });

  it('returns the original entry for a duplicate idempotency key', async () => {
    const store = new FakeBillingAdminStore();
    const audit = new FakeAuditStore();
    const auditor = { platformAuditEvents: async () => [] };
    const module = await Test.createTestingModule({
      providers: [
        BillingAdminService,
        { provide: BILLING_ADMIN_STORE, useValue: store },
        { provide: AUDIT_STORE, useValue: audit },
        { provide: AUDITOR_STORE, useValue: auditor },
      ],
    }).compile();
    const service = module.get(BillingAdminService);
    const key = randomUUID();

    const first = await service.adjustWallet('user-1', ORG_ID, {
      amountMinor: '5000',
      currency: 'UGX',
      reason: 'Correction',
      idempotencyKey: key,
    });
    const second = await service.adjustWallet('user-1', ORG_ID, {
      amountMinor: '5000',
      currency: 'UGX',
      reason: 'Correction',
      idempotencyKey: key,
    });

    expect(second.created).toBe(false);
    expect(second.entry.id).toBe(first.entry.id);
  });
});
