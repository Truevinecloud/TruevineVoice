import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import {
  assertKnownAuditAction,
  isKnownAuditAction,
  isSafeAuditMetadata,
  type PlatformRole,
} from '@truevine/auth';
import type { HealthReport } from '@truevine/shared';

import type { AuditStore } from '../auth/auth.store.js';
import { AUDIT_STORE } from '../auth/tokens.js';
import { HealthService } from '../health/health.service.js';
import { TECHNICAL_STORE } from './tokens.js';
import type { TechnicalAuditTrail, TechnicalStore } from './technical.store.js';

/**
 * Read-only technical diagnostics for platform operators (RBAC-010).
 *
 * The design constraint is honesty about what this system can actually report.
 * Voice providers, queues and log storage do not exist yet, and a view that
 * simply omitted them would read as "there are none" - a false statement. Each
 * unavailable domain is therefore named, with the reason, rather than rendered
 * as an empty section.
 *
 * Every method records an audit event before returning data, and an audit
 * failure fails the request rather than the read: "we could not record that
 * this happened" must never mean "it happened invisibly" (AGENTS.md 7, 9).
 */

/** Page size for the platform audit trail. Fixed; no caller-supplied limit. */
const PAGE_SIZE = 50;

/**
 * Integration status of every provider technical views could report on.
 *
 * `not_integrated` is a fact about the deployment, not an error: Africa's
 * Talking is the intended first Voice adapter and is deliberately not built
 * yet (AGENTS.md 8). Copying `OperationsService.healthReport`'s vocabulary
 * keeps the two views from drifting into different words for the same state.
 */
export interface ProviderStatus {
  readonly name: string;
  readonly status: 'not_integrated';
  readonly detail: string;
}

const PROVIDERS: readonly ProviderStatus[] = [
  {
    name: 'africas_talking_voice',
    status: 'not_integrated',
    detail: 'The first Voice adapter. Declared as an interface only; no SDK is linked.',
  },
];

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Domains with no data model or storage yet.
 *
 * Named in the response rather than silently omitted, exactly as RBAC-009
 * diagnostics names its unmodelled domains.
 */
const NOT_AVAILABLE_DOMAINS = [
  'voice_calls',
  'messages',
  'log_storage',
  'job_history',
  'provider_webhooks',
] as const;

function invalid(code: string, message: string): never {
  throw new BadRequestException({ error: { code, message } });
}

export interface TechnicalAuditQuery {
  readonly action?: string;
  readonly cursor?: string;
}

@Injectable()
export class TechnicalService {
  constructor(
    @Inject(HealthService) private readonly health: HealthService,
    @Inject(TECHNICAL_STORE) private readonly store: TechnicalStore,
    @Inject(AUDIT_STORE) private readonly audit: AuditStore,
  ) {}

  operatorContext(platformRole: PlatformRole | null) {
    return { platformRole };
  }

  /**
   * Composes the application health report with the subsystem availability the
   * platform can honestly state.
   *
   * Process facts (uptime, version, environment, dependency probes) come from
   * `HealthService` rather than being re-read from the environment here, so
   * health has exactly one definition.
   */
  async overview(actorUserId: string) {
    const health = await this.health.check();

    await this.recordIdentityEvent(actorUserId, 'platform.technical.overview_viewed', {
      status: health.status,
      environment: health.environment,
    });

    return {
      application: this.applicationView(health),
      subsystems: {
        // Each subsystem reports the same three-field shape so a reader does
        // not have to learn a different vocabulary per domain: what it is,
        // whether it is integrated, and why not when it is not.
        voiceProvider: { status: 'not_integrated' as const, activeCalls: null, detail: 'No voice provider integration is configured.' },
        queues: { status: 'not_integrated' as const, workers: null, detail: 'No business queues are registered yet.' },
        logStorage: { status: 'not_configured' as const, detail: 'Application logs are written to stdout only; nothing is queryable.' },
      },
      notAvailable: NOT_AVAILABLE_DOMAINS,
    };
  }

  async providers(actorUserId: string) {
    await this.recordIdentityEvent(actorUserId, 'platform.technical.providers_viewed');

    return {
      providers: PROVIDERS,
      notAvailable: ['provider_webhooks', 'voice_calls', 'messages'] as const,
    };
  }

  async queues(actorUserId: string) {
    await this.recordIdentityEvent(actorUserId, 'platform.technical.queues_viewed');

    return {
      // No queue system is registered, so this is an empty list and not a
      // claim about which queues exist. `not_integrated` says so explicitly.
      status: 'not_integrated' as const,
      queues: [] as const,
      failedJobs: [] as const,
      detail: 'BullMQ is wired for connections only; no business queues or processors are registered yet.',
    };
  }

  async logs(actorUserId: string) {
    await this.recordIdentityEvent(actorUserId, 'platform.technical.logs_viewed');

    return {
      status: 'not_configured' as const,
      entries: [] as const,
      detail: 'Application logs go to stdout; there is no log store to query.',
    };
  }

  /**
   * The platform audit trail: operator actions, newest first.
   *
   * Organization-scoped rows are excluded by the store, not filtered here, so
   * the guarantee lives with the query that could break it.
   */
  async auditTrail(actorUserId: string, query: TechnicalAuditQuery) {
    const action = this.optionalAuditAction(query.action);
    const after = query.cursor === undefined ? undefined : this.requireEventCursor(query.cursor);

    const events = await this.store.platformAuditEvents({ action, after, limit: PAGE_SIZE + 1 });
    const page = events.slice(0, PAGE_SIZE);

    await this.recordIdentityEvent(actorUserId, 'platform.technical.audit_viewed', {
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
        metadata: event.metadata,
      })),
      nextCursor:
        events.length > PAGE_SIZE
          ? this.encodeCursor(page.at(-1)!)
          : null,
    };
  }

  private applicationView(health: HealthReport) {
    return {
      status: health.status,
      service: health.service,
      version: health.version,
      environment: health.environment,
      uptimeSeconds: health.uptimeSeconds,
      timestamp: health.timestamp,
      dependencies: health.dependencies,
    };
  }

  /** `<trail>:<uuid>` so a page spanning two tables stays navigable. */
  private encodeCursor(event: { readonly trail: TechnicalAuditTrail; readonly id: string }): string {
    return `${event.trail}:${event.id}`;
  }

  private requireEventCursor(value: unknown): { readonly trail: TechnicalAuditTrail; readonly eventId: string } {
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

  private async recordIdentityEvent(
    actorUserId: string,
    action:
      | 'platform.technical.overview_viewed'
      | 'platform.technical.providers_viewed'
      | 'platform.technical.queues_viewed'
      | 'platform.technical.logs_viewed'
      | 'platform.technical.audit_viewed',
    metadata: Readonly<Record<string, unknown>> = {},
  ): Promise<void> {
    assertKnownAuditAction(action);
    if (!isSafeAuditMetadata(metadata)) {
      throw new Error('Refusing to write audit metadata containing a credential-shaped key.');
    }
    await this.audit.recordIdentity({ actorUserId, action, outcome: 'SUCCESS', metadata });
  }
}
