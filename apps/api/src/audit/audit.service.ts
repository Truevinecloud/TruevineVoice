import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import {
  assertKnownAuditAction,
  isKnownAuditAction,
  isSafeAuditMetadata,
  type PlatformRole,
} from '@truevine/auth';

import type { AuditStore } from '../auth/auth.store.js';
import { AUDIT_STORE } from '../auth/tokens.js';
import { AUDITOR_STORE } from './tokens.js';
import type { AuditorAuditTrail, AuditorStore } from './audit.store.js';

/**
 * Read-only Admin / Auditor views (RBAC-011).
 *
 * The role exists to answer "what did operators do to the platform?" and
 * nothing else. Three properties hold for every method here:
 *
 * 1. **Read-only by construction.** The only write this service performs is an
 *    audit row recording that a read happened. There is no method that mutates
 *    tenant, billing, or platform state, and the store it depends on has no
 *    write method to call.
 * 2. **Explicit allowlists.** Each response is assembled field by field. A
 *    record is never spread into a response, so a field added to the database
 *    later cannot leak by default; it must be named here first.
 * 3. **Audit-before-return, fail-closed.** The event is recorded before data is
 *    returned, and a failed write fails the request - "we could not record that
 *    this happened" must never mean "it happened invisibly" (AGENTS.md 7, 9).
 */

/** Page size for the merged platform audit trail. Fixed; no caller-supplied limit. */
const PAGE_SIZE = 50;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function invalid(code: string, message: string): never {
  throw new BadRequestException({ error: { code, message } });
}

export interface AuditorAuditQuery {
  readonly action?: string;
  readonly cursor?: string;
}

export interface AuditorOrganizationQuery {
  readonly after?: string;
}

@Injectable()
export class AuditService {
  constructor(
    @Inject(AUDITOR_STORE) private readonly store: AuditorStore,
    @Inject(AUDIT_STORE) private readonly audit: AuditStore,
  ) {}

  operatorContext(platformRole: PlatformRole | null) {
    return { platformRole };
  }

  /**
   * The auditor's landing view: how much of the platform there is to account
   * for, and what this role can and cannot reach.
   *
   * Counts and role names only. Role aggregation is a fact about the platform's
   * operator population; it is deliberately not per-person and carries no email
   * or user id, because "who are the operators" is a support/identity question
   * the auditor does not hold authority over.
   */
  async overview(actorUserId: string) {
    const [organizationCount, roleCounts] = await Promise.all([
      this.store.countOrganizations(),
      this.store.platformRoleCounts(),
    ]);

    await this.recordIdentityEvent(actorUserId, 'platform.audit.overview_viewed');

    return {
      organizations: { total: organizationCount },
      platformRoles: roleCounts
        .map((row) => ({ role: row.role, count: row.count }))
        .sort((a, b) => a.role.localeCompare(b.role)),
      scope: {
        // Stated in the response so a reader of the API knows the intended
        // boundary without reading this file. Writes are listed because their
        // refusal is the point of the role.
        readable: ['platform:tenant:read', 'platform:operations:read', 'platform:support:read', 'platform:audit:read'],
        writable: [] as const,
      },
    };
  }

  /**
   * Organization metadata, newest slug order, keyset-paginated.
   *
   * Identity and status only. Campaign content, wallet balances, billing
   * profiles and member lists are support-diagnostics material; an auditor must
   * not reach them through this route.
   */
  async organizations(actorUserId: string, query: AuditorOrganizationQuery) {
    const afterSlug = this.optionalSlug(query.after);

    const rows = await this.store.organizationSummaries({
      afterSlug,
      limit: PAGE_SIZE + 1,
    });
    const page = rows.slice(0, PAGE_SIZE);

    await this.recordIdentityEvent(actorUserId, 'platform.audit.organizations_viewed');

    return {
      organizations: page.map((organization) => ({
        id: organization.id,
        name: organization.name,
        slug: organization.slug,
        status: organization.status,
        createdAt: organization.createdAt.toISOString(),
        memberCount: organization.memberCount,
      })),
      nextCursor: rows.length > PAGE_SIZE ? page.at(-1)!.slug : null,
    };
  }

  /**
   * The platform audit trail: operator actions, newest first.
   *
   * Organization-scoped rows are excluded by the store, not filtered here, so
   * the tenant-isolation guarantee lives with the query that could break it.
   * `metadata` is projected through a key allowlist before it leaves the
   * service so that a field written by a future writer - `token`, `password`,
   * `secret` - is dropped even though `isSafeAuditMetadata` already rejects the
   * known credential-shaped keys at write time. Belt and braces: the write-time
   * check stops the value entering the trail, the read-time projection stops it
   * leaving.
   */
  async auditTrail(actorUserId: string, query: AuditorAuditQuery) {
    const action = this.optionalAuditAction(query.action);
    const after = query.cursor === undefined ? undefined : this.requireEventCursor(query.cursor);

    const events = await this.store.platformAuditEvents({ action, after, limit: PAGE_SIZE + 1 });
    const page = events.slice(0, PAGE_SIZE);

    await this.recordIdentityEvent(actorUserId, 'platform.audit.audit_viewed', {
      ...(action === undefined ? {} : { action }),
    });

    return {
      events: page.map((event) => ({
        id: event.id,
        trail: event.trail,
        action: event.action,
        outcome: event.outcome,
        scope: event.scope,
        targetType: event.targetType,
        targetId: event.targetId,
        occurredAt: event.occurredAt.toISOString(),
        actor: { userId: event.actorUserId, email: event.actorEmail },
        metadata: projectSafeMetadata(event.metadata),
      })),
      nextCursor: events.length > PAGE_SIZE ? this.encodeCursor(page.at(-1)!) : null,
    };
  }

  /** `<trail>:<uuid>` so a page spanning two tables stays navigable. */
  private encodeCursor(event: { readonly trail: AuditorAuditTrail; readonly id: string }): string {
    return `${event.trail}:${event.id}`;
  }

  private requireEventCursor(
    value: unknown,
  ): { readonly trail: AuditorAuditTrail; readonly eventId: string } {
    if (typeof value !== 'string') invalid('invalid_cursor', 'That position is not valid.');

    const separator = value.indexOf(':');
    const trail = separator === -1 ? '' : value.slice(0, separator);
    const eventId = separator === -1 ? '' : value.slice(separator + 1);

    if ((trail !== 'identity' && trail !== 'security') || !UUID.test(eventId)) {
      invalid('invalid_cursor', 'That position is not valid.');
    }

    return { trail, eventId };
  }

  private optionalAuditAction(value: unknown): string | undefined {
    if (value === undefined || value === null || value === '') return undefined;
    if (typeof value === 'string' && isKnownAuditAction(value)) return value;
    invalid('invalid_action', 'Unknown audit action.');
  }

  private optionalSlug(value: unknown): string | undefined {
    if (value === undefined || value === null || value === '') return undefined;
    if (typeof value === 'string' && value.length <= 128) return value;
    invalid('invalid_cursor', 'That position is not valid.');
  }

  private async recordIdentityEvent(
    actorUserId: string,
    action:
      | 'platform.audit.overview_viewed'
      | 'platform.audit.organizations_viewed'
      | 'platform.audit.audit_viewed',
    metadata: Readonly<Record<string, unknown>> = {},
  ): Promise<void> {
    assertKnownAuditAction(action);
    if (!isSafeAuditMetadata(metadata)) {
      throw new Error('Refusing to write audit metadata containing a credential-shaped key.');
    }
    await this.audit.recordIdentity({ actorUserId, action, outcome: 'SUCCESS', metadata });
  }
}

/**
 * Keys an audit metadata object may carry out of the API.
 *
 * A standalone allowlist rather than a denylist: the write-time check already
 * rejects known credential-shaped keys, but a projection built from what is
 * permitted means a reader never has to reason about what a future writer might
 * have stored. Metadata that is not a plain object - a string, an array, null -
 * is dropped entirely rather than passed through unexamined.
 */
const SAFE_METADATA_KEYS: readonly string[] = [
  'status',
  'environment',
  'action',
  'permission',
  'reason',
  'outcome',
  'scope',
  'campaignId',
  'organizationId',
  'organizationSlug',
  'userId',
  'targetUserId',
  'role',
  'reasonCode',
  'count',
  'provider',
  'trail',
];

/**
 * Longest string value allowed out of metadata.
 *
 * Audit metadata is a short fact - an id, an enum, a reason code - never prose
 * and never a payload. A bounded scalar is a scalar that cannot smuggle a
 * document, and an over-long value is dropped rather than truncated so the
 * omission is visible instead of approximate.
 */
const MAX_METADATA_STRING_LENGTH = 256;

/**
 * Projects `metadata` onto {@link SAFE_METADATA_KEYS}, keeping only scalar
 * values of an expected shape.
 *
 * Key-allowlisting alone is insufficient: a permitted key could carry a nested
 * object with a `token` field inside it, or an array of records, and the key
 * denylist never looks inside. So a value is admitted only if it is a
 * primitive - a bounded string, a finite number, a boolean, or null. Objects,
 * arrays and `undefined` are omitted entirely. The result is flat, bounded and
 * carries no structure a credential could hide in.
 */
function projectSafeMetadata(metadata: unknown): Readonly<Record<string, unknown>> {
  if (metadata === null || typeof metadata !== 'object' || Array.isArray(metadata)) {
    return {};
  }

  const source = metadata as Record<string, unknown>;
  const projected: Record<string, unknown> = {};
  for (const key of SAFE_METADATA_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(source, key)) continue;

    const value = source[key];
    if (isSafeMetadataValue(value)) {
      projected[key] = value;
    }
  }
  return projected;
}

/** A primitive small enough to be a fact: never an object, never unbounded. */
function isSafeMetadataValue(value: unknown): value is string | number | boolean | null {
  if (value === null) return true;
  if (typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value === 'string') return value.length <= MAX_METADATA_STRING_LENGTH;
  return false;
}
