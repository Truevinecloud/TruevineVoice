import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import {
  assertKnownAuditAction,
  isKnownAuditAction,
  isSafeAuditMetadata,
  type PlatformRole,
} from '@truevine/auth';

import type { AuditStore } from '../auth/auth.store.js';
import { AUDIT_STORE } from '../auth/tokens.js';
import { SUPPORT_STORE } from './tokens.js';
import type { SupportStore } from './support.store.js';

/**
 * Read-only customer lookup and diagnostics for support operators (RBAC-009).
 *
 * Every method records an audit event before returning data, and an audit
 * failure fails the request rather than the read: "we could not record that
 * this happened" must never mean "it happened invisibly" (AGENTS.md 7, 9).
 *
 * The query string an operator searched for is never recorded - it can contain
 * customer-identifying input - only the fact that a search happened and which
 * non-sensitive filters it used.
 */

/** Page size for searches and audit trails. Fixed; no caller-supplied limit. */
const PAGE_SIZE = 50;

/** Members and memberships rendered on a detail page. */
const DETAIL_LIST_LIMIT = 100;

/**
 * Diagnostic domains with no data model yet.
 *
 * Named in the response rather than silently omitted: a diagnostics view that
 * simply lacks a voice-call section reads as "there were no calls", which is a
 * different - and false - statement from "calls are not modelled yet".
 */
const NOT_AVAILABLE_DOMAINS = [
  'voice_calls',
  'messages',
  'deliveries',
  'pricing',
  'invoices',
] as const;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function invalid(code: string, message: string): never {
  throw new BadRequestException({ error: { code, message } });
}

/** Validates a path identifier without trusting the caller's shape. */
function requireUuid(value: unknown, what: string): string {
  if (typeof value !== 'string' || !UUID.test(value)) {
    invalid('invalid_request', `A valid ${what} is required.`);
  }
  return value;
}

export interface SupportSearchQuery {
  readonly q?: string;
  readonly status?: string;
  readonly cursor?: string;
}

export interface SupportAuditQuery {
  readonly action?: string;
  readonly cursor?: string;
}

@Injectable()
export class SupportService {
  constructor(
    @Inject(SUPPORT_STORE) private readonly store: SupportStore,
    @Inject(AUDIT_STORE) private readonly audit: AuditStore,
  ) {}

  operatorContext(platformRole: PlatformRole | null) {
    return { platformRole };
  }

  async searchOrganizations(actorUserId: string, query: SupportSearchQuery) {
    const search = query.q === undefined ? undefined : this.optionalSearchQuery(query.q, 1, 200);
    const status = this.optionalStatus(query.status);
    const afterSlug = query.cursor === undefined ? undefined : this.requireSlugCursor(query.cursor);

    const rows = await this.store.searchOrganizations({
      query: search,
      status,
      afterSlug,
      limit: PAGE_SIZE + 1,
    });
    const organizations = rows.slice(0, PAGE_SIZE);

    await this.recordIdentityEvent(
      actorUserId,
      'platform.support.organization_searched',
      status === undefined ? {} : { status },
    );

    return {
      organizations: organizations.map((organization) => ({
        ...organization,
        createdAt: organization.createdAt.toISOString(),
      })),
      nextCursor: rows.length > PAGE_SIZE ? (organizations.at(-1)?.slug ?? null) : null,
    };
  }

  async organization(actorUserId: string, rawOrganizationId: unknown) {
    const organizationId = requireUuid(rawOrganizationId, 'organization');
    const organization = await this.store.findOrganizationDetail(organizationId);
    if (!organization) throw new NotFoundException();

    const members = await this.store.listMembers(organizationId, DETAIL_LIST_LIMIT);
    await this.recordPlatformEvent(
      organizationId,
      actorUserId,
      'platform.support.organization_viewed',
    );

    return {
      organization: {
        id: organization.id,
        name: organization.name,
        slug: organization.slug,
        status: organization.status,
        createdAt: organization.createdAt.toISOString(),
        updatedAt: organization.updatedAt.toISOString(),
        suspendedAt: organization.suspendedAt?.toISOString() ?? null,
        memberCount: organization.memberCount,
        campaignCount: organization.campaignCount,
      },
      members: members.map((member) => ({
        userId: member.userId,
        email: member.email,
        userStatus: member.userStatus,
        role: member.role,
        joinedAt: member.joinedAt.toISOString(),
        lockedUntil: member.lockedUntil?.toISOString() ?? null,
      })),
      memberCount: organization.memberCount,
    };
  }

  async diagnostics(
    actorUserId: string,
    rawOrganizationId: unknown,
    accessContext?: { readonly supportSessionId: string; readonly reasonCode: string },
  ) {
    const organizationId = requireUuid(rawOrganizationId, 'organization');
    const [organization, diagnostics] = await Promise.all([
      this.store.findOrganizationDetail(organizationId),
      this.store.diagnostics(organizationId),
    ]);
    if (!organization || !diagnostics) throw new NotFoundException();

    await this.recordPlatformEvent(
      organizationId,
      actorUserId,
      accessContext
        ? 'platform.support.context_diagnostics_viewed'
        : 'platform.support.diagnostics_viewed',
      accessContext ?? {},
    );

    return {
      organization: {
        id: organization.id,
        name: organization.name,
        slug: organization.slug,
        status: organization.status,
      },
      memberCount: diagnostics.memberCount,
      auditEventCount: diagnostics.auditEventCount,
      billingProfilePresent: diagnostics.billingProfilePresent,
      campaigns: {
        total: diagnostics.campaigns.total,
        byStatus: diagnostics.campaigns.byStatus,
        emergencyStoppedCount: diagnostics.campaigns.emergencyStoppedCount,
        recent: diagnostics.campaigns.recent.map((campaign) => ({
          id: campaign.id,
          name: campaign.name,
          status: campaign.status,
          emergencyStoppedAt: campaign.emergencyStoppedAt?.toISOString() ?? null,
          updatedAt: campaign.updatedAt.toISOString(),
        })),
      },
      walletBalances: diagnostics.walletBalances.map((balance) => ({
        currency: balance.currency,
        amountMinor: balance.amountMinor.toString(),
        entryCount: balance.entryCount,
        lastEntryAt: balance.lastEntryAt?.toISOString() ?? null,
      })),
      topUpRequests: diagnostics.topUpRequests.map((topUp) => ({
        currency: topUp.currency,
        requestCount: topUp.requestCount,
        totalRequestedMinor: topUp.totalRequestedMinor.toString(),
        lastRequestedAt: topUp.lastRequestedAt?.toISOString() ?? null,
      })),
      notAvailable: NOT_AVAILABLE_DOMAINS,
    };
  }

  async searchUsers(actorUserId: string, query: SupportSearchQuery) {
    const search = this.optionalSearchQuery(
      query.q,
      3,
      200,
      'Enter at least 3 characters to search users.',
    );
    if (search === undefined) {
      invalid('invalid_query', 'Enter at least 3 characters to search users.');
    }
    const afterEmail =
      query.cursor === undefined ? undefined : this.requireEmailCursor(query.cursor);

    const rows = await this.store.searchUsers({
      query: search,
      afterEmail,
      limit: PAGE_SIZE + 1,
    });
    const users = rows.slice(0, PAGE_SIZE);

    await this.recordIdentityEvent(actorUserId, 'platform.support.user_searched');

    return {
      users: users.map((user) => ({
        id: user.id,
        email: user.email,
        status: user.status,
        createdAt: user.createdAt.toISOString(),
        lockedUntil: user.lockedUntil?.toISOString() ?? null,
        platformRole:
          user.platformRole === null
            ? null
            : {
                role: user.platformRole.role,
                grantedAt: user.platformRole.grantedAt.toISOString(),
              },
        membershipCount: user.membershipCount,
      })),
      nextCursor: rows.length > PAGE_SIZE ? (users.at(-1)?.email ?? null) : null,
    };
  }

  async user(actorUserId: string, rawUserId: unknown) {
    const userId = requireUuid(rawUserId, 'user');
    const [detail, memberships, sessionSummary] = await Promise.all([
      this.store.findUserDetail(userId),
      this.store.listUserMemberships(userId, DETAIL_LIST_LIMIT),
      this.store.sessionSummary(userId),
    ]);
    if (!detail) throw new NotFoundException();

    await this.recordIdentityEvent(actorUserId, 'platform.support.user_viewed', {
      targetUserId: userId,
    });

    return {
      user: {
        id: detail.id,
        email: detail.email,
        status: detail.status,
        createdAt: detail.createdAt.toISOString(),
        updatedAt: detail.updatedAt.toISOString(),
        lockedUntil: detail.lockedUntil?.toISOString() ?? null,
        failedLoginCount: detail.failedLoginCount,
        passwordChangedAt: detail.passwordChangedAt.toISOString(),
        platformRole:
          detail.platformRole === null
            ? null
            : {
                role: detail.platformRole.role,
                grantedAt: detail.platformRole.grantedAt.toISOString(),
              },
        membershipCount: detail.membershipCount,
      },
      memberships: memberships.map((membership) => ({
        organizationId: membership.organizationId,
        organizationName: membership.organizationName,
        organizationSlug: membership.organizationSlug,
        role: membership.role,
        joinedAt: membership.joinedAt.toISOString(),
      })),
      sessionSummary: {
        active: sessionSummary.active,
        revoked: sessionSummary.revoked,
        expired: sessionSummary.expired,
        lastUsedAt: sessionSummary.lastUsedAt?.toISOString() ?? null,
      },
    };
  }

  async organizationAudit(
    actorUserId: string,
    rawOrganizationId: unknown,
    query: SupportAuditQuery,
  ) {
    const organizationId = requireUuid(rawOrganizationId, 'organization');
    const organization = await this.store.findOrganizationDetail(organizationId);
    if (!organization) throw new NotFoundException();

    const action = this.optionalAuditAction(query.action);
    const after = query.cursor === undefined ? undefined : this.requireEventCursor(query.cursor);

    const events = await this.store.organizationAuditEvents(organizationId, {
      action,
      after,
      limit: PAGE_SIZE + 1,
    });
    const page = events.slice(0, PAGE_SIZE);

    await this.recordPlatformEvent(
      organizationId,
      actorUserId,
      'platform.support.audit_viewed',
      action === undefined ? {} : { action },
    );

    return {
      events: page.map((event) => this.toAuditView(event)),
      nextCursor: events.length > PAGE_SIZE ? (page.at(-1)?.id ?? null) : null,
    };
  }

  async userAudit(actorUserId: string, rawUserId: unknown, query: SupportAuditQuery) {
    const userId = requireUuid(rawUserId, 'user');
    const user = await this.store.findUserDetail(userId);
    if (!user) throw new NotFoundException();

    const action = this.optionalAuditAction(query.action);
    const after = query.cursor === undefined ? undefined : this.requireEventCursor(query.cursor);

    const events = await this.store.userAuditEvents(userId, {
      action,
      after,
      limit: PAGE_SIZE + 1,
    });
    const page = events.slice(0, PAGE_SIZE);

    await this.recordIdentityEvent(actorUserId, 'platform.support.audit_viewed', {
      targetUserId: userId,
      ...(action === undefined ? {} : { action }),
    });

    return {
      events: page.map((event) => this.toAuditView(event)),
      nextCursor: events.length > PAGE_SIZE ? (page.at(-1)?.id ?? null) : null,
    };
  }

  private toAuditView(event: {
    readonly id: string;
    readonly action: string;
    readonly outcome: string;
    readonly scope: string | null;
    readonly targetType: string | null;
    readonly targetId: string | null;
    readonly occurredAt: Date;
    readonly actorUserId: string;
    readonly actorEmail: string;
    readonly metadata: unknown;
  }) {
    return {
      id: event.id,
      action: event.action,
      outcome: event.outcome,
      scope: event.scope,
      targetType: event.targetType,
      targetId: event.targetId,
      occurredAt: event.occurredAt.toISOString(),
      actor: { userId: event.actorUserId, email: event.actorEmail },
      metadata: event.metadata,
    };
  }

  private optionalSearchQuery(
    value: unknown,
    min: number,
    max: number,
    message = `Enter between ${min} and ${max} characters to search.`,
  ): string | undefined {
    if (typeof value !== 'string') invalid('invalid_query', message);
    const search = value.trim();
    if (search.length === 0) return undefined;
    if (search.length < min || search.length > max) invalid('invalid_query', message);
    // Wildcards are rejected so the operator sees literal matching only: a
    // silently interpreted `%` would search more than they asked for.
    if (/[\\%_]/.test(search)) {
      invalid('invalid_query', 'Wildcards are not supported. Enter the text as it appears.');
    }
    return search;
  }

  private optionalStatus(value: unknown): 'ACTIVE' | 'SUSPENDED' | undefined {
    if (value === undefined || value === null || value === '') return undefined;
    if (value === 'ACTIVE' || value === 'SUSPENDED') return value;
    invalid('invalid_status', 'Status must be ACTIVE or SUSPENDED.');
  }

  private optionalAuditAction(value: unknown): string | undefined {
    if (value === undefined || value === null || value === '') return undefined;
    if (typeof value === 'string' && isKnownAuditAction(value)) return value;
    invalid('invalid_action', 'Unknown audit action.');
  }

  private requireSlugCursor(value: unknown): string {
    if (
      typeof value !== 'string' ||
      value.length === 0 ||
      value.length > 63 ||
      !/^[A-Za-z0-9-]+$/.test(value)
    ) {
      invalid('invalid_cursor', 'That position is not valid.');
    }
    return value;
  }

  private requireEmailCursor(value: unknown): string {
    if (
      typeof value !== 'string' ||
      value.length === 0 ||
      value.length > 254 ||
      !value.includes('@')
    ) {
      invalid('invalid_cursor', 'That position is not valid.');
    }
    return value;
  }

  private requireEventCursor(value: unknown): { eventId: string } {
    if (typeof value !== 'string' || !UUID.test(value)) {
      invalid('invalid_cursor', 'That position is not valid.');
    }
    return { eventId: value };
  }

  private async recordPlatformEvent(
    organizationId: string,
    actorUserId: string,
    action:
      | 'platform.support.organization_viewed'
      | 'platform.support.diagnostics_viewed'
      | 'platform.support.context_diagnostics_viewed'
      | 'platform.support.audit_viewed',
    metadata: Readonly<Record<string, unknown>> = {},
  ): Promise<void> {
    assertKnownAuditAction(action);
    if (!isSafeAuditMetadata(metadata)) {
      throw new Error('Refusing to write audit metadata containing a credential-shaped key.');
    }
    await this.audit.record({
      organizationId,
      actorUserId,
      action,
      scope: 'PLATFORM',
      outcome: 'SUCCESS',
      targetType: 'organization',
      targetId: organizationId,
      metadata,
    });
  }

  private async recordIdentityEvent(
    actorUserId: string,
    action:
      | 'platform.support.organization_searched'
      | 'platform.support.user_searched'
      | 'platform.support.user_viewed'
      | 'platform.support.audit_viewed',
    metadata: Readonly<Record<string, unknown>> = {},
  ): Promise<void> {
    assertKnownAuditAction(action);
    if (!isSafeAuditMetadata(metadata)) {
      throw new Error('Refusing to write audit metadata containing a credential-shaped key.');
    }
    await this.audit.recordIdentity({ actorUserId, action, outcome: 'SUCCESS', metadata });
  }
}
