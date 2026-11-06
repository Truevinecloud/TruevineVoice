import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import {
  assertKnownAuditAction,
  isKnownAuditAction,
  isSafeAuditMetadata,
  type PlatformRole,
} from '@truevine/auth';

import type { AuditStore } from '../auth/auth.store.js';
import { AUDIT_STORE } from '../auth/tokens.js';
import type { AuditorAuditEventRecord, AuditorStore } from '../audit/audit.store.js';
import { AUDITOR_STORE } from '../audit/tokens.js';
import { BILLING_ADMIN_STORE } from './tokens.js';
import type { BillingAdminStore } from './billing-admin.store.js';

const PAGE_SIZE = 50;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function invalid(code: string, message: string): never {
  throw new BadRequestException({ error: { code, message } });
}

@Injectable()
export class BillingAdminService {
  constructor(
    @Inject(BILLING_ADMIN_STORE) private readonly store: BillingAdminStore,
    @Inject(AUDIT_STORE) private readonly audit: AuditStore,
    @Inject(AUDITOR_STORE) private readonly auditorStore: AuditorStore,
  ) {}

  operatorContext(platformRole: PlatformRole | null) {
    return { platformRole };
  }

  async overview(actorUserId: string) {
    const organizations = await this.store.listOrganizations({ limit: 500 });
    const walletTotals = new Map<string, { amountMinor: bigint; entryCount: number }>();
    let topUpCount = 0;
    for (const organization of organizations) {
      for (const balance of organization.walletBalances) {
        const current = walletTotals.get(balance.currency) ?? { amountMinor: 0n, entryCount: 0 };
        walletTotals.set(balance.currency, {
          amountMinor: current.amountMinor + balance.amountMinor,
          entryCount: current.entryCount + balance.entryCount,
        });
      }
      for (const topUp of organization.topUpRequests) {
        topUpCount += topUp.requestCount;
      }
    }

    await this.recordIdentity(actorUserId, 'platform.billing.overview_viewed', {
      organizationCount: organizations.length,
    });

    return {
      organizations: { total: organizations.length },
      walletTotals: [...walletTotals.entries()].map(([currency, value]) => ({
        currency,
        amountMinor: value.amountMinor.toString(),
        entryCount: value.entryCount,
      })),
      topUpRequests: { total: topUpCount },
      notAvailable: ['subscriptions', 'reconciliation', 'invoices'] as const,
    };
  }

  async listOrganizations(
    actorUserId: string,
    query: { q?: string; status?: string; cursor?: string },
  ) {
    const status =
      query.status === undefined || query.status === ''
        ? undefined
        : query.status === 'ACTIVE' || query.status === 'SUSPENDED'
          ? query.status
          : (invalid('invalid_status', 'Status must be ACTIVE or SUSPENDED.'), undefined);
    const search = query.q?.trim();
    if (search !== undefined && (search.length < 1 || search.length > 200 || /[\\%_]/.test(search))) {
      invalid('invalid_query', 'Enter between 1 and 200 characters without wildcards.');
    }
    const afterSlug = query.cursor;
    const organizations = await this.store.listOrganizations({
      query: search,
      status,
      afterSlug,
      limit: PAGE_SIZE + 1,
    });
    const page = organizations.slice(0, PAGE_SIZE);

    await this.recordIdentity(actorUserId, 'platform.billing.organizations_viewed', {
      count: page.length,
      ...(status === undefined ? {} : { status }),
    });

    return {
      organizations: page.map((organization) => this.toOrganizationView(organization)),
      nextCursor: organizations.length > PAGE_SIZE ? page.at(-1)?.slug ?? null : null,
    };
  }

  async organization(actorUserId: string, rawOrganizationId: unknown) {
    const organizationId = this.requireUuid(rawOrganizationId, 'organization');
    const organization = await this.store.findOrganization(organizationId);
    if (!organization) throw new NotFoundException();

    await this.recordIdentity(actorUserId, 'platform.billing.organization_viewed', {
      organizationId,
    });

    return this.toOrganizationView(organization);
  }

  async walletEntries(actorUserId: string, rawOrganizationId: unknown, cursor: string | undefined) {
    const organizationId = this.requireUuid(rawOrganizationId, 'organization');
    const organization = await this.store.findOrganization(organizationId);
    if (!organization) throw new NotFoundException();

    const entries = await this.store.walletEntries(organizationId, cursor, PAGE_SIZE + 1);
    const page = entries.slice(0, PAGE_SIZE);

    await this.recordIdentity(actorUserId, 'platform.billing.transactions_viewed', {
      organizationId,
      count: page.length,
    });

    return {
      organization: { id: organization.id, name: organization.name, slug: organization.slug },
      entries: page.map((entry) => ({
        id: entry.id,
        amountMinor: entry.amountMinor.toString(),
        currency: entry.currency,
        reference: entry.reference,
        description: entry.description,
        createdAt: entry.createdAt.toISOString(),
      })),
      nextCursor: entries.length > PAGE_SIZE ? page.at(-1)?.id ?? null : null,
    };
  }

  async payments(actorUserId: string, rawOrganizationId: unknown, limit = PAGE_SIZE) {
    const organizationId =
      rawOrganizationId === undefined || rawOrganizationId === null || rawOrganizationId === ''
        ? undefined
        : this.requireUuid(rawOrganizationId, 'organization');
    const requests = await this.store.topUpRequests({
      organizationId,
      limit: Math.min(limit + 1, 101),
    });
    const page = requests.slice(0, limit);

    await this.recordIdentity(actorUserId, 'platform.billing.payments_viewed', {
      count: page.length,
      ...(organizationId === undefined ? {} : { organizationId }),
    });

    return {
      payments: page.map((request) => ({
        id: request.id,
        organizationId: request.organizationId,
        organizationName: request.organizationName,
        organizationSlug: request.organizationSlug,
        amountMinor: request.amountMinor.toString(),
        currency: request.currency,
        createdById: request.createdById,
        createdAt: request.createdAt.toISOString(),
        status: 'PENDING',
      })),
      nextCursor: requests.length > limit ? page.at(-1)?.id ?? null : null,
    };
  }

  async reconciliation(actorUserId: string) {
    const organizations = await this.store.listOrganizations({ limit: 500 });
    const alerts: Array<{ organizationId: string; organizationName: string; currency: string; reason: string }> = [];
    for (const organization of organizations) {
      for (const balance of organization.walletBalances) {
        if (balance.amountMinor < 0n) {
          alerts.push({
            organizationId: organization.id,
            organizationName: organization.name,
            currency: balance.currency,
            reason: 'negative_wallet_balance',
          });
        }
      }
    }

    await this.recordIdentity(actorUserId, 'platform.billing.reconciliation_viewed', {
      alertCount: alerts.length,
    });

    return {
      alerts,
      unmatchedTransactions: [] as const,
      notAvailable: ['payment_provider_settlement', 'subscriptions', 'invoices'] as const,
    };
  }

  async auditTrail(actorUserId: string, query: { action?: string; cursor?: string }) {
    const action =
      query.action === undefined || query.action === ''
        ? undefined
        : isKnownAuditAction(query.action)
          ? query.action
          : (invalid('invalid_action', 'Unknown audit action.'), undefined);
    const after =
      query.cursor === undefined
        ? undefined
        : this.requireCursor(query.cursor);

    const events = await this.auditorStore.platformAuditEvents({
      action,
      after,
      limit: PAGE_SIZE + 1,
    });
    const page = events.slice(0, PAGE_SIZE);

    await this.recordIdentity(actorUserId, 'platform.billing.audit_viewed', {
      ...(action === undefined ? {} : { action }),
    });

    return {
      events: page.map((event: AuditorAuditEventRecord) => ({
        id: event.id,
        trail: event.trail,
        action: event.action,
        outcome: event.outcome,
        scope: event.scope,
        targetType: event.targetType,
        targetId: event.targetId,
        occurredAt: event.occurredAt.toISOString(),
        actor: { userId: event.actorUserId, email: event.actorEmail },
        metadata: event.metadata,
      })),
      nextCursor:
        events.length > PAGE_SIZE ? `${page.at(-1)!.trail}:${page.at(-1)!.id}` : null,
    };
  }

  async adjustWallet(
    actorUserId: string,
    rawOrganizationId: unknown,
    rawBody: unknown,
  ) {
    const organizationId = this.requireUuid(rawOrganizationId, 'organization');
    const organization = await this.store.findOrganization(organizationId);
    if (!organization) throw new NotFoundException();

    if (!rawBody || typeof rawBody !== 'object' || Array.isArray(rawBody)) {
      invalid('invalid_request', 'Adjustment details are required.');
    }
    const body = rawBody as Record<string, unknown>;
    const idempotencyKey = this.requireUuid(body.idempotencyKey, 'idempotency key');
    const reason = typeof body.reason === 'string' ? body.reason.trim() : '';
    if (reason.length < 3 || reason.length > 500) {
      invalid('invalid_reason', 'Enter a reason between 3 and 500 characters.');
    }
    if (typeof body.currency !== 'string' || !/^[A-Z]{3}$/.test(body.currency)) {
      invalid('invalid_currency', 'Currency must be a three-letter code.');
    }
    const currency = body.currency;
    if (typeof body.amountMinor !== 'string' || !/^-?[1-9][0-9]{0,18}$/.test(body.amountMinor)) {
      invalid('invalid_amount', 'Enter a nonzero whole amount as text.');
    }
    const amountMinor = BigInt(body.amountMinor);
    if (amountMinor === 0n) invalid('invalid_amount', 'Adjustment amount cannot be zero.');

    const result = await this.store.adjustWallet({
      organizationId,
      actorUserId,
      amountMinor,
      currency,
      reason,
      idempotencyKey,
    });

    await this.recordIdentity(actorUserId, 'platform.billing.wallet_adjusted', {
      organizationId,
      amountMinor: amountMinor.toString(),
      currency,
    });

    // Also record org-scoped security audit event for financial action.
    await this.audit.record({
      organizationId,
      actorUserId,
      action: 'platform.billing.wallet_adjusted',
      scope: 'PLATFORM',
      outcome: 'SUCCESS',
      targetType: 'wallet',
      targetId: result.entry.id,
      metadata: { amountMinor: amountMinor.toString(), currency, reason },
    });

    return {
      entry: {
        id: result.entry.id,
        amountMinor: result.entry.amountMinor.toString(),
        currency: result.entry.currency,
        reference: result.entry.reference,
        description: result.entry.description,
        createdAt: result.entry.createdAt.toISOString(),
      },
      created: result.created,
    };
  }

  private toOrganizationView(organization: {
    id: string;
    name: string;
    slug: string;
    status: 'ACTIVE' | 'SUSPENDED';
    createdAt: Date;
    memberCount: number;
    campaignCount: number;
    billingProfilePresent: boolean;
    walletBalances: readonly { currency: string; amountMinor: bigint; entryCount: number; lastEntryAt: Date | null }[];
    topUpRequests: readonly { currency: string; requestCount: number; totalRequestedMinor: bigint; lastRequestedAt: Date | null }[];
  }) {
    return {
      id: organization.id,
      name: organization.name,
      slug: organization.slug,
      status: organization.status,
      createdAt: organization.createdAt.toISOString(),
      memberCount: organization.memberCount,
      campaignCount: organization.campaignCount,
      billingProfilePresent: organization.billingProfilePresent,
      walletBalances: organization.walletBalances.map((balance) => ({
        currency: balance.currency,
        amountMinor: balance.amountMinor.toString(),
        entryCount: balance.entryCount,
        lastEntryAt: balance.lastEntryAt?.toISOString() ?? null,
      })),
      topUpRequests: organization.topUpRequests.map((topUp) => ({
        currency: topUp.currency,
        requestCount: topUp.requestCount,
        totalRequestedMinor: topUp.totalRequestedMinor.toString(),
        lastRequestedAt: topUp.lastRequestedAt?.toISOString() ?? null,
      })),
    };
  }

  private requireUuid(value: unknown, what: string): string {
    if (typeof value !== 'string' || !UUID.test(value)) {
      invalid('invalid_request', `A valid ${what} is required.`);
    }
    return value;
  }

  private requireCursor(value: unknown): { trail: 'identity' | 'security'; eventId: string } {
    if (typeof value !== 'string') invalid('invalid_cursor', 'That position is not valid.');
    const separator = value.indexOf(':');
    const trail = separator === -1 ? '' : value.slice(0, separator);
    const eventId = separator === -1 ? '' : value.slice(separator + 1);
    if ((trail !== 'identity' && trail !== 'security') || !UUID.test(eventId)) {
      invalid('invalid_cursor', 'That position is not valid.');
    }
    return { trail, eventId };
  }

  private async recordIdentity(
    actorUserId: string,
    action:
      | 'platform.billing.overview_viewed'
      | 'platform.billing.organizations_viewed'
      | 'platform.billing.organization_viewed'
      | 'platform.billing.wallets_viewed'
      | 'platform.billing.transactions_viewed'
      | 'platform.billing.payments_viewed'
      | 'platform.billing.reconciliation_viewed'
      | 'platform.billing.audit_viewed'
      | 'platform.billing.wallet_adjusted',
    metadata: Readonly<Record<string, unknown>> = {},
  ): Promise<void> {
    assertKnownAuditAction(action);
    if (!isSafeAuditMetadata(metadata)) {
      throw new Error('Refusing to write audit metadata containing a credential-shaped key.');
    }
    await this.audit.recordIdentity({ actorUserId, action, outcome: 'SUCCESS', metadata });
  }
}
