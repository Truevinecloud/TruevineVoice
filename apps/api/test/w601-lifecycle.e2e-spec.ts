/**
 * W6-01 HTTP acceptance for customer dispatch controls and Platform Admin stop.
 * Uses the dedicated truevine_w601_qa allowlist and the real Nest HTTP stack.
 */

import { randomUUID } from 'node:crypto';

import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { loadEnvFiles } from '@truevine/shared';
import { hashPassword } from '@truevine/auth/passwords';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { BillingService } from '../src/billing/billing.service.js';
import { APP_CONFIG } from '../src/config/app-config.module.js';
import { PaymentIntentsService } from '../src/payments/payment-intents.service.js';
import { TopUpIntegrationService } from '../src/payments/top-up-integration.service.js';
import type { ApiConfig } from '../src/config/api.config.js';
import { CSRF_COOKIE, CSRF_HEADER, SESSION_COOKIE } from '../src/auth/cookies.js';
import { AppModule } from '../src/app.module.js';
import { DATABASE_CLIENT, REDIS_CLIENT } from '../src/tokens.js';
import { RATE_LIMITER } from '../src/auth/tokens.js';
import { createW601ApiDatabaseClient } from './helpers/w601-database.js';

const TEST_CONFIG: ApiConfig = Object.freeze({
  host: '127.0.0.1',
  port: 0,
  environment: 'test',
  version: '0.1.0-w601-test',
  databaseUrl: 'postgresql://stub/stub',
  redisUrl: 'redis://stub:6379',
  healthTimeoutMs: 50,
  serviceName: 'truevine-voice-api',
});
const PASSWORD = 'a-long-enough-passphrase';
const RUN = randomUUID().replace(/-/g, '').slice(0, 8);

const ORG_A = randomUUID();
const ORG_B = randomUUID();
const OWNER_A = randomUUID();
const OWNER_A_2 = randomUUID();
const OWNER_A_3 = randomUUID();
const OWNER_B = randomUUID();
const OPERATIONS_ADMIN = randomUUID();
const CAMPAIGN_A = randomUUID();
const CAMPAIGN_B = randomUUID();
const CAMPAIGN_STOP = randomUUID();

const EMAILS = {
  ownerA: `w601-owner-a-${RUN}@example.invalid`,
  ownerA2: `w601-owner-a2-${RUN}@example.invalid`,
  ownerA3: `w601-owner-a3-${RUN}@example.invalid`,
  ownerB: `w601-owner-b-${RUN}@example.invalid`,
  operations: `w601-ops-${RUN}@example.invalid`,
} as const;

let app: INestApplication;
let database: Awaited<ReturnType<typeof createW601ApiDatabaseClient>>['prisma'];
let server: ReturnType<INestApplication['getHttpServer']>;

function extractCookie(header: unknown, name: string): string {
  const values = Array.isArray(header) ? header.map(String) : [String(header ?? '')];
  const match = values.find((value) => value.startsWith(`${name}=`));
  if (!match) throw new Error(`No ${name} cookie in response.`);
  return match.slice(name.length + 1).split(';')[0] ?? '';
}

async function signIn(email: string) {
  const agent = request(server);
  const probe = await agent.get('/auth/terms');
  const csrf = decodeURIComponent(extractCookie(probe.headers['set-cookie'], CSRF_COOKIE));
  const response = await agent
    .post('/auth/sign-in')
    .set(CSRF_HEADER, csrf)
    .set('cookie', `${CSRF_COOKIE}=${encodeURIComponent(csrf)}`)
    .send({ email, password: PASSWORD });
  expect(response.status).toBe(200);
  const session = extractCookie(response.headers['set-cookie'], SESSION_COOKIE);
  const cookie = `${SESSION_COOKIE}=${session}`;
  const accepted = await agent
    .post('/auth/terms/accept')
    .set(CSRF_HEADER, csrf)
    .set('cookie', `${cookie}; ${CSRF_COOKIE}=${encodeURIComponent(csrf)}`);
  expect(accepted.status).toBe(204);
  return {
    post: (path: string) =>
      request(server)
        .post(path)
        .set('cookie', `${cookie}; ${CSRF_COOKIE}=${encodeURIComponent(csrf)}`)
        .set(CSRF_HEADER, csrf),
  };
}

beforeAll(async () => {
  loadEnvFiles();
  const connection = await createW601ApiDatabaseClient();
  database = connection.prisma;
  const passwordHash = await hashPassword(PASSWORD);
  await database.$transaction(async (tx) => {
    await tx.$executeRaw`
      INSERT INTO organizations (id, slug, name, updated_at) VALUES
        (${ORG_A}::uuid, ${`w601-a-${RUN}`}, 'W601 Tenant A', now()),
        (${ORG_B}::uuid, ${`w601-b-${RUN}`}, 'W601 Tenant B', now())`;
    await tx.$executeRaw`
      INSERT INTO users (id, email, password_hash, updated_at) VALUES
        (${OWNER_A}::uuid, ${EMAILS.ownerA}, ${passwordHash}, now()),
        (${OWNER_A_2}::uuid, ${EMAILS.ownerA2}, ${passwordHash}, now()),
        (${OWNER_A_3}::uuid, ${EMAILS.ownerA3}, ${passwordHash}, now()),
        (${OWNER_B}::uuid, ${EMAILS.ownerB}, ${passwordHash}, now()),
        (${OPERATIONS_ADMIN}::uuid, ${EMAILS.operations}, ${passwordHash}, now())`;
    await tx.$executeRaw`
      INSERT INTO memberships (organization_id, user_id, role, updated_at) VALUES
        (${ORG_A}::uuid, ${OWNER_A}::uuid, 'OWNER', now()),
        (${ORG_A}::uuid, ${OWNER_A_3}::uuid, 'ADMIN', now()),
        (${ORG_B}::uuid, ${OWNER_B}::uuid, 'OWNER', now())`;
    await tx.$executeRaw`
      INSERT INTO platform_role_assignments (user_id, role) VALUES
        (${OPERATIONS_ADMIN}::uuid, 'OPERATIONS_ADMIN')`;
    await tx.$executeRaw`
      INSERT INTO campaigns (organization_id, id, name, status, created_by_user_id, updated_at)
      VALUES
        (${ORG_A}::uuid, ${CAMPAIGN_A}::uuid, 'W601 lifecycle target', 'ACTIVE', ${OWNER_A}::uuid, now()),
        (${ORG_B}::uuid, ${CAMPAIGN_B}::uuid, 'W601 cross-tenant target', 'ACTIVE', ${OWNER_B}::uuid, now()),
        (${ORG_A}::uuid, ${CAMPAIGN_STOP}::uuid, 'W601 stop target', 'ACTIVE', ${OWNER_A_2}::uuid, now())`;
  });

  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(APP_CONFIG)
    .useValue(TEST_CONFIG)
    .overrideProvider(DATABASE_CLIENT)
    .useValue(database)
    .overrideProvider(REDIS_CLIENT)
    .useValue({ ping: async () => 'PONG', disconnect: () => undefined })
    .overrideProvider(RATE_LIMITER)
    .useValue({ consume: async () => ({ allowed: true, retryAfterMs: 0, remaining: 1000 }) })
    // This suite exercises dispatch controls only. Stub the unrelated payment
    // providers so the W5-02 modules cannot block module compilation.
    .overrideProvider(BillingService)
    .useValue({})
    .overrideProvider(PaymentIntentsService)
    .useValue({})
    .overrideProvider(TopUpIntegrationService)
    .useValue({})
    .compile();
  app = moduleRef.createNestApplication();
  await app.init();
  server = app.getHttpServer();
}, 60_000);

afterAll(async () => {
  if (!database) return;
  const userIds = [OWNER_A, OWNER_A_2, OWNER_A_3, OWNER_B, OPERATIONS_ADMIN];
  await database.session.deleteMany({ where: { userId: { in: userIds } } });
  await database.termsAcceptance.deleteMany({ where: { userId: { in: userIds } } });
  await app?.close();
  await database.$disconnect();
}, 30_000);

async function auditEvents(organizationId: string, action: string) {
  return database.securityAuditEvent.findMany({
    where: { organizationId, actorUserId: OWNER_A, action },
    orderBy: { occurredAt: 'asc' },
  });
}

async function findCampaign(organizationId: string, campaignId: string) {
  const campaign = await database.campaign.findUnique({
    where: { organizationId_id: { organizationId, id: campaignId } },
    select: {
      status: true,
      dispatchState: true,
      dispatchEpoch: true,
      dispatchStopReason: true,
      emergencyStoppedAt: true,
    },
  });
  if (!campaign) throw new Error('W6-01 campaign fixture is missing.');
  return campaign;
}

function evidence(name: string, payload: unknown): void {
  process.stdout.write(`W601_HTTP_EVIDENCE ${JSON.stringify({ scenario: name, ...(payload as object) })}\n`);
}

describe('W6-01 lifecycle controls over real HTTP and PostgreSQL', () => {
  it('pauses, resumes and cancels without editing persisted campaign status', async () => {
    const owner = await signIn(EMAILS.ownerA);
    const base = `/organizations/${ORG_A}/campaigns/${CAMPAIGN_A}`;

    const paused = await owner.post(`${base}/pause`);
    expect(paused.status).toBe(200);
    expect(paused.body).toMatchObject({
      id: CAMPAIGN_A,
      status: 'PAUSED',
      dispatchState: 'PAUSED',
      dispatchStopReason: 'customer_pause',
    });
    expect(await findCampaign(ORG_A, CAMPAIGN_A)).toMatchObject({
      status: 'ACTIVE',
      dispatchState: 'PAUSED',
      dispatchStopReason: 'customer_pause',
    });

    const resumed = await owner.post(`${base}/resume`);
    expect(resumed.status).toBe(200);
    expect(resumed.body).toMatchObject({ status: 'ACTIVE', dispatchState: 'RUNNING' });
    expect(await findCampaign(ORG_A, CAMPAIGN_A)).toMatchObject({
      status: 'ACTIVE',
      dispatchState: 'RUNNING',
    });

    const duplicateResume = await owner.post(`${base}/resume`);
    expect(duplicateResume.status).toBe(409);
    expect(duplicateResume.body.error.code).toBe('campaign_already_running');

    await owner.post(`${base}/pause`);
    const cancelled = await owner.post(`${base}/cancel`);
    expect(cancelled.status).toBe(200);
    expect(cancelled.body).toMatchObject({
      status: 'CANCELLED',
      dispatchState: 'CANCELLED',
      dispatchStopReason: 'customer_cancel',
    });
    expect(await findCampaign(ORG_A, CAMPAIGN_A)).toMatchObject({
      status: 'ACTIVE',
      dispatchState: 'CANCELLED',
    });

    const restart = await owner.post(`${base}/resume`);
    expect(restart.status).toBe(409);
    expect(restart.body.error.code).toBe('campaign_cancelled');

    const [pauseAudits, resumeAudits, cancelAudits] = await Promise.all([
      auditEvents(ORG_A, 'campaign.paused'),
      auditEvents(ORG_A, 'campaign.resumed'),
      auditEvents(ORG_A, 'campaign.cancelled'),
    ]);
    expect(pauseAudits).toHaveLength(2);
    expect(resumeAudits).toHaveLength(1);
    expect(cancelAudits).toHaveLength(1);
    expect(pauseAudits[0]?.metadata).toMatchObject({
      reasonCode: 'campaign_pause',
      before: { dispatchState: 'RUNNING' },
      after: { dispatchState: 'PAUSED' },
    });
    expect(cancelAudits[0]?.metadata).toMatchObject({
      reasonCode: 'campaign_cancel',
      after: { dispatchState: 'CANCELLED' },
    });

    evidence('customer-lifecycle', {
      pauseAudits: pauseAudits.length,
      resumeAudits: resumeAudits.length,
      cancelAudits: cancelAudits.length,
      persistedStatus: (await findCampaign(ORG_A, CAMPAIGN_A)).status,
    });
  });

  it('denies cross-tenant dispatch controls and records the attempted tenant', async () => {
    const attacker = await signIn(EMAILS.ownerA2);
    const target = `/organizations/${ORG_B}/campaigns/${CAMPAIGN_B}`;
    for (const action of ['pause', 'resume', 'cancel']) {
      const response = await attacker.post(`${target}/${action}`);
      expect(response.status).toBe(403);
    }
    expect(await findCampaign(ORG_B, CAMPAIGN_B)).toMatchObject({
      status: 'ACTIVE',
      dispatchState: 'RUNNING',
    });

    const denial = await database.securityAuditEvent.findFirst({
      where: {
        organizationId: ORG_B,
        actorUserId: OWNER_A_2,
        action: 'authorization.denied',
        outcome: 'DENIED',
      },
    });
    expect(denial).toMatchObject({
      scope: 'ORGANIZATION',
      targetType: 'organization',
      targetId: ORG_B,
    });
    expect(denial?.metadata).toMatchObject({ reason: 'no_membership' });
    evidence('cross-tenant-denial', {
      attempts: 3,
      auditOutcome: denial?.outcome,
      dispatchState: (await findCampaign(ORG_B, CAMPAIGN_B)).dispatchState,
    });
  });

  it('emergency-stops dispatch terminally and audits the platform operator', async () => {
    const operator = await signIn(EMAILS.operations);
    const stopped = await operator
      .post(`/platform/operations/organizations/${ORG_A}/campaigns/${CAMPAIGN_STOP}/emergency-stop`)
      .send({ reasonCode: 'provider_incident' });
    expect(stopped.status).toBe(200);
    expect(stopped.body).toMatchObject({
      dispatchState: 'CANCELLED',
      dispatchStopReason: 'emergency_stop',
      stopResult: 'stopped',
      voiceDispatchStopped: true,
    });
    expect(await findCampaign(ORG_A, CAMPAIGN_STOP)).toMatchObject({
      status: 'COMPLETED',
      dispatchState: 'CANCELLED',
      dispatchStopReason: 'emergency_stop',
    });

    const owner = await signIn(EMAILS.ownerA3);
    const resume = await owner.post(
      `/organizations/${ORG_A}/campaigns/${CAMPAIGN_STOP}/resume`,
    );
    expect(resume.status).toBe(409);
    expect(resume.body.error.code).toBe('campaign_cancelled');

    const audit = await database.securityAuditEvent.findFirst({
      where: {
        organizationId: ORG_A,
        actorUserId: OPERATIONS_ADMIN,
        action: 'platform.campaign.emergency_stopped',
      },
    });
    expect(audit).toMatchObject({
      scope: 'PLATFORM',
      outcome: 'SUCCESS',
      targetType: 'campaign',
      targetId: CAMPAIGN_STOP,
    });
    expect(audit?.metadata).toMatchObject({
      reasonCode: 'provider_incident',
      before: { dispatchState: 'RUNNING' },
      after: { dispatchState: 'CANCELLED', dispatchStopReason: 'emergency_stop' },
    });

    evidence('platform-emergency-stop', {
      voiceDispatchStopped: stopped.body.voiceDispatchStopped,
      customerResumeStatus: resume.status,
      auditOutcome: audit?.outcome,
    });
  });
});
