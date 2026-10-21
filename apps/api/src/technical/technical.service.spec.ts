/**
 * Unit tests for the technical service (RBAC-010).
 *
 * Backed by in-memory fakes, not PostgreSQL, as AGENTS.md 13 requires. The
 * fake store records every input it was handed, so "did the audit trail filter
 * reach the store?" is an assertion rather than a comment. The E2E suite
 * repeats the same behaviour against real PostgreSQL.
 */

import { BadRequestException, NotFoundException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';

import type { HealthReport } from '@truevine/shared';

import { FakeAuditStore } from '../../test/fakes/auth.fakes.js';
import { HealthService } from '../health/health.service.js';

import type {
  TechnicalAuditEventRecord,
  TechnicalAuditTrailInput,
  TechnicalStore,
} from './technical.store.js';
import { TechnicalService } from './technical.service.js';

const ACTOR = '00000000-0000-4000-8000-000000000003';
const NOW = new Date('2026-10-20T00:00:00Z');

class FakeTechnicalStore implements TechnicalStore {
  lastAudit?: TechnicalAuditTrailInput;
  events: TechnicalAuditEventRecord[] = [];

  async platformAuditEvents(
    input: TechnicalAuditTrailInput,
  ): Promise<readonly TechnicalAuditEventRecord[]> {
    this.lastAudit = input;
    return this.events;
  }
}

/** A health service whose probe outcome the test controls. */
function aHealthService(status: 'ok' | 'degraded' = 'ok'): HealthService {
  const report: HealthReport = {
    status,
    service: 'truevine-voice-api',
    version: '0.1.0-test',
    environment: 'test',
    uptimeSeconds: 42,
    timestamp: NOW.toISOString(),
    dependencies: {
      postgres: { status: 'up', latencyMs: 1 },
      redis: { status: 'up', latencyMs: 2 },
    },
  };

  return { check: async () => report } as unknown as HealthService;
}

function anAuditEvent(
  overrides: Partial<TechnicalAuditEventRecord> = {},
): TechnicalAuditEventRecord {
  return {
    id: '10000000-0000-4000-8000-000000000001',
    trail: 'identity',
    action: 'auth.sign_in.succeeded',
    outcome: 'SUCCESS',
    scope: null,
    targetType: null,
    targetId: null,
    occurredAt: NOW,
    actorUserId: ACTOR,
    actorEmail: 'operator@example.invalid',
    metadata: {},
    ...overrides,
  };
}

function buildService(): {
  service: TechnicalService;
  store: FakeTechnicalStore;
  audit: FakeAuditStore;
} {
  const store = new FakeTechnicalStore();
  const audit = new FakeAuditStore();
  return { service: new TechnicalService(aHealthService(), store, audit), store, audit };
}

async function expectError(
  promise: Promise<unknown>,
  type: abstract new (...args: never[]) => Error,
  code?: string,
): Promise<void> {
  const error = await promise.then(
    () => undefined,
    (caught: unknown) => caught,
  );

  expect(error).toBeInstanceOf(type);
  if (code !== undefined) {
    expect((error as { getResponse(): unknown }).getResponse()).toMatchObject({ error: { code } });
  }
}

describe('TechnicalService overview', () => {
  it('composes the health report with honestly-unavailable subsystems', async () => {
    const { service, audit } = buildService();

    const result = await service.overview(ACTOR);

    expect(result.application.status).toBe('ok');
    expect(result.application.dependencies.postgres?.status).toBe('up');
    expect(result.subsystems.voiceProvider.status).toBe('not_integrated');
    expect(result.subsystems.queues.status).toBe('not_integrated');
    expect(result.subsystems.logStorage.status).toBe('not_configured');
    expect(result.notAvailable).toContain('log_storage');
    expect(audit.identityEvents.map((event) => event.action)).toEqual([
      'platform.technical.overview_viewed',
    ]);
  });

  it('does not claim an empty subsystem means "none exist"', async () => {
    const { service } = buildService();

    const result = await service.overview(ACTOR);

    // The detail string is the difference between "there are no providers" and
    // "no provider integration is configured yet".
    expect(result.subsystems.voiceProvider.detail).toMatch(/no voice provider integration/i);
    expect(result.notAvailable).toContain('log_storage');
  });

  it('surfaces a degraded application without failing the request', async () => {
    const store = new FakeTechnicalStore();
    const audit = new FakeAuditStore();
    const service = new TechnicalService(aHealthService('degraded'), store, audit);

    const result = await service.overview(ACTOR);

    expect(result.application.status).toBe('degraded');
    expect(audit.identityEvents.map((event) => event.action)).toEqual([
      'platform.technical.overview_viewed',
    ]);
  });
});

describe('TechnicalService providers and queues', () => {
  it('names Africa\u2019s Talking as declared but not integrated', async () => {
    const { service, audit } = buildService();

    const result = await service.providers(ACTOR);

    expect(result.providers).toEqual([
      expect.objectContaining({ name: 'africas_talking_voice', status: 'not_integrated' }),
    ]);
    expect(audit.identityEvents.map((event) => event.action)).toEqual([
      'platform.technical.providers_viewed',
    ]);
  });

  it('reports no queues rather than inventing queued work', async () => {
    const { service, audit } = buildService();

    const result = await service.queues(ACTOR);

    expect(result.status).toBe('not_integrated');
    expect(result.queues).toEqual([]);
    expect(result.failedJobs).toEqual([]);
    expect(audit.identityEvents.map((event) => event.action)).toEqual([
      'platform.technical.queues_viewed',
    ]);
  });

  it('reports no log store rather than an empty one', async () => {
    const { service, audit } = buildService();

    const result = await service.logs(ACTOR);

    expect(result.status).toBe('not_configured');
    expect(result.entries).toEqual([]);
    expect(audit.identityEvents.map((event) => event.action)).toEqual([
      'platform.technical.logs_viewed',
    ]);
  });
});

describe('TechnicalService audit trail', () => {
  it('pages at 50 and returns a trail-qualified cursor', async () => {
    const { service, store } = buildService();
    store.events = Array.from({ length: 51 }, (_, index) =>
      anAuditEvent({
        id: `${index + 1}`.padStart(36, '0'),
        trail: 'identity',
        occurredAt: new Date(NOW.getTime() + index),
      }),
    );

    const result = await service.auditTrail(ACTOR, {});

    expect(store.lastAudit).toEqual({ action: undefined, after: undefined, limit: 51 });
    expect(result.events).toHaveLength(50);
    expect(result.nextCursor).toBe(`identity:${'50'.padStart(36, '0')}`);
  });

  it('returns a null cursor when nothing more exists', async () => {
    const { service, store } = buildService();
    store.events = [anAuditEvent()];

    const result = await service.auditTrail(ACTOR, {});

    expect(result.nextCursor).toBeNull();
  });

  it('decodes a trail-qualified cursor back into a position', async () => {
    const { service, store } = buildService();
    const id = '10000000-0000-4000-8000-0000000000aa';

    await service.auditTrail(ACTOR, { cursor: `security:${id}` });

    expect(store.lastAudit?.after).toEqual({ trail: 'security', eventId: id });
  });

  it('passes a known action filter through and records only the fact of the read', async () => {
    const { service, store, audit } = buildService();

    await service.auditTrail(ACTOR, { action: 'platform.support.organization_viewed' });

    expect(store.lastAudit?.action).toBe('platform.support.organization_viewed');
    expect(audit.identityEvents[0]).toMatchObject({
      action: 'platform.technical.audit_viewed',
      metadata: { action: 'platform.support.organization_viewed' },
    });
  });

  it('does not record the filter key when no action was supplied', async () => {
    const { service, audit } = buildService();

    await service.auditTrail(ACTOR, {});

    expect(audit.identityEvents[0]?.metadata).toEqual({});
  });

  it('rejects an unknown action filter', async () => {
    const { service } = buildService();

    await expectError(
      service.auditTrail(ACTOR, { action: 'made.up.action' }),
      BadRequestException,
      'invalid_action',
    );
  });

  it('rejects a cursor without a valid trail prefix', async () => {
    const { service } = buildService();

    await expectError(
      service.auditTrail(ACTOR, { cursor: '10000000-0000-4000-8000-000000000001' }),
      BadRequestException,
      'invalid_cursor',
    );
    await expectError(
      service.auditTrail(ACTOR, { cursor: 'organization:10000000-0000-4000-8000-000000000001' }),
      BadRequestException,
      'invalid_cursor',
    );
    await expectError(
      service.auditTrail(ACTOR, { cursor: 'identity:not-a-uuid' }),
      BadRequestException,
      'invalid_cursor',
    );
  });

  it('propagates a cursor-not-found from the store', async () => {
    const store = new FakeTechnicalStore();
    store.platformAuditEvents = async () => {
      throw new NotFoundException({
        error: { code: 'audit_cursor_not_found', message: 'gone' },
      });
    };
    const service = new TechnicalService(aHealthService(), store, new FakeAuditStore());

    await expectError(
      service.auditTrail(ACTOR, { cursor: 'identity:10000000-0000-4000-8000-000000000001' }),
      NotFoundException,
      'audit_cursor_not_found',
    );
  });
});

describe('TechnicalService audit is fail-closed', () => {
  it('propagates an audit-store failure instead of returning the data', async () => {
    const store = new FakeTechnicalStore();
    store.events = [anAuditEvent()];
    const audit = new FakeAuditStore();
    audit.recordIdentity = async () => {
      throw new Error('audit unavailable');
    };
    const service = new TechnicalService(aHealthService(), store, audit);

    await expect(service.auditTrail(ACTOR, {})).rejects.toThrow('audit unavailable');
  });

  it('refuses to write credential-shaped metadata', async () => {
    const store = new FakeTechnicalStore();
    const audit = new FakeAuditStore();
    const service = new TechnicalService(aHealthService(), store, audit);
    // The service only ever builds its own metadata, so this asserts the guard
    // is wired rather than reachable from a caller - by driving the private
    // path through a subclass that overrides the action metadata.
    await expect(
      (
        service as unknown as {
          recordIdentityEvent(
            actor: string,
            action: string,
            metadata: Record<string, unknown>,
          ): Promise<void>;
        }
      ).recordIdentityEvent(ACTOR, 'platform.technical.logs_viewed', { token: 'secret' }),
    ).rejects.toThrow(/credential-shaped/);
  });
});
