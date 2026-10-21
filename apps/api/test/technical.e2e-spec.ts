import { randomUUID } from 'node:crypto';

import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { hashPassword } from '@truevine/auth/passwords';
import { loadEnvFiles, requireEnv } from '@truevine/shared';
import { createDatabaseClient, type PrismaClient } from '@truevine/database';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { APP_CONFIG } from '../src/config/app-config.module.js';
import type { ApiConfig } from '../src/config/api.config.js';
import { CSRF_COOKIE, CSRF_HEADER, SESSION_COOKIE } from '../src/auth/cookies.js';
import { AppModule } from '../src/app.module.js';
import { DATABASE_CLIENT, REDIS_CLIENT } from '../src/tokens.js';
import { RATE_LIMITER } from '../src/auth/tokens.js';
import {
  assertConnectedToDisposableDatabase,
  assertDisposableDatabase,
} from './disposable-database.js';

const TEST_CONFIG: ApiConfig = Object.freeze({
  host: '127.0.0.1',
  port: 0,
  environment: 'test',
  version: '0.1.0-test',
  databaseUrl: 'postgresql://stub/stub',
  redisUrl: 'redis://stub:6379',
  healthTimeoutMs: 50,
  serviceName: 'truevine-voice-api',
});
const PASSWORD = 'a-long-enough-passphrase';
const RUN = randomUUID().replace(/-/g, '').slice(0, 8);
const ORG_A = randomUUID();
const OWNER_A = randomUUID();
const TECHNICAL_ADMIN = randomUUID();
const SUPPORT_ADMIN = randomUUID();
const AUDITOR = randomUUID();
const EMAIL_OWNER_A = `technical-owner-${RUN}@example.invalid`;
const EMAIL_TECHNICAL = `technical-admin-${RUN}@example.invalid`;
const EMAIL_SUPPORT = `technical-support-${RUN}@example.invalid`;
const EMAIL_AUDITOR = `technical-auditor-${RUN}@example.invalid`;

let app: INestApplication;
let database: PrismaClient;
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
    get: (path: string) => request(server).get(path).set('cookie', cookie),
  };
}

beforeAll(async () => {
  loadEnvFiles();
  const databaseUrl = requireEnv('DATABASE_URL');
  const disposable = assertDisposableDatabase(databaseUrl, process.env['NODE_ENV']);
  database = createDatabaseClient(databaseUrl);
  await assertConnectedToDisposableDatabase(async () => {
    const rows = await database.$queryRaw<{ name: string }[]>`SELECT current_database() AS name`;
    return rows[0]?.name;
  }, disposable);
  const passwordHash = await hashPassword(PASSWORD);
  await database.$transaction(async (tx) => {
    await tx.$executeRaw`
      INSERT INTO organizations (id, slug, name, updated_at) VALUES
        (${ORG_A}::uuid, ${`technical-a-${RUN}`}, 'Technical Tenant Alpha', now())`;
    await tx.$executeRaw`
      INSERT INTO users (id, email, password_hash, updated_at) VALUES
        (${OWNER_A}::uuid, ${EMAIL_OWNER_A}, ${passwordHash}, now()),
        (${TECHNICAL_ADMIN}::uuid, ${EMAIL_TECHNICAL}, ${passwordHash}, now()),
        (${SUPPORT_ADMIN}::uuid, ${EMAIL_SUPPORT}, ${passwordHash}, now()),
        (${AUDITOR}::uuid, ${EMAIL_AUDITOR}, ${passwordHash}, now())`;
    await tx.$executeRaw`
      INSERT INTO memberships (organization_id, user_id, role, updated_at) VALUES
        (${ORG_A}::uuid, ${OWNER_A}::uuid, 'OWNER', now())`;
    await tx.$executeRaw`
      INSERT INTO platform_role_assignments (user_id, role) VALUES
        (${TECHNICAL_ADMIN}::uuid, 'TECHNICAL_ADMIN'),
        (${SUPPORT_ADMIN}::uuid, 'SUPPORT_ADMIN'),
        (${AUDITOR}::uuid, 'AUDITOR')`;
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
    .compile();
  app = moduleRef.createNestApplication();
  await app.init();
  server = app.getHttpServer();
});

afterAll(async () => {
  if (!database) return;
  await database.session.deleteMany({
    where: { userId: { in: [OWNER_A, TECHNICAL_ADMIN, SUPPORT_ADMIN, AUDITOR] } },
  });
  await database.termsAcceptance.deleteMany({
    where: { userId: { in: [OWNER_A, TECHNICAL_ADMIN, SUPPORT_ADMIN, AUDITOR] } },
  });
  await app?.close();
  await database.$disconnect();
});

describe('RBAC-010 technical diagnostics over real PostgreSQL and HTTP', () => {
  it('lets the technical admin discover its own context', async () => {
    const technical = await signIn(EMAIL_TECHNICAL);

    const me = await technical.get('/platform/technical/me');
    expect(me.status).toBe(200);
    expect(me.body).toEqual({ platformRole: 'TECHNICAL_ADMIN' });
  });

  it('reports application health with honestly-unavailable subsystems', async () => {
    const technical = await signIn(EMAIL_TECHNICAL);

    const overview = await technical.get('/platform/technical/overview');
    expect(overview.status).toBe(200);
    expect(overview.body.application).toMatchObject({ service: 'truevine-voice-api' });
    expect(overview.body.application.dependencies).toHaveProperty('postgres');
    expect(overview.body.subsystems.voiceProvider.status).toBe('not_integrated');
    expect(overview.body.subsystems.queues.status).toBe('not_integrated');
    expect(overview.body.subsystems.logStorage.status).toBe('not_configured');
    expect(overview.body.notAvailable).toContain('log_storage');

    const audit = await database.identityAuditEvent.findFirst({
      where: { actorUserId: TECHNICAL_ADMIN, action: 'platform.technical.overview_viewed' },
    });
    expect(audit).toMatchObject({ outcome: 'SUCCESS' });
  });

  it('names the voice provider as declared but not integrated', async () => {
    const technical = await signIn(EMAIL_TECHNICAL);

    const providers = await technical.get('/platform/technical/providers');
    expect(providers.status).toBe(200);
    expect(providers.body.providers).toEqual([
      expect.objectContaining({ name: 'africas_talking_voice', status: 'not_integrated' }),
    ]);
  });

  it('reports no queues and no failed jobs rather than inventing work', async () => {
    const technical = await signIn(EMAIL_TECHNICAL);

    const queues = await technical.get('/platform/technical/queues');
    expect(queues.status).toBe(200);
    expect(queues.body).toMatchObject({ status: 'not_integrated', queues: [], failedJobs: [] });
  });

  it('reports no log store rather than an empty one', async () => {
    const technical = await signIn(EMAIL_TECHNICAL);

    const logs = await technical.get('/platform/technical/logs');
    expect(logs.status).toBe(200);
    expect(logs.body).toMatchObject({ status: 'not_configured', entries: [] });
  });

  it('reads the platform audit trail and never leaks organization-scoped rows', async () => {
    // A tenant owner signs in and updates their own organization: that writes
    // an ORGANIZATION-scoped security row, which the technical trail must not
    // contain.
    await signIn(EMAIL_OWNER_A);
    await database.securityAuditEvent.create({
      data: {
        organizationId: ORG_A,
        actorUserId: OWNER_A,
        action: 'organization.profile_updated',
        scope: 'ORGANIZATION',
        outcome: 'SUCCESS',
        metadata: {},
      },
    });

    const technical = await signIn(EMAIL_TECHNICAL);
    const trail = await technical.get('/platform/technical/audit');
    expect(trail.status).toBe(200);
    expect(trail.body.events.length).toBeGreaterThan(0);

    expect(trail.body.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          action: 'platform.technical.overview_viewed',
          actor: { userId: TECHNICAL_ADMIN, email: EMAIL_TECHNICAL },
        }),
      ]),
    );
    expect(trail.body.events.some((event: { action: string }) => event.action === 'organization.profile_updated')).toBe(false);
    for (const event of trail.body.events) {
      expect(event.scope === null || event.scope === 'PLATFORM').toBe(true);
    }
  });

  it('refuses customer owners, support admins without the permission, auditors, and anonymous callers', async () => {
    const owner = await signIn(EMAIL_OWNER_A);
    expect((await owner.get('/platform/technical/me')).status).toBe(403);
    expect((await owner.get('/platform/technical/overview')).status).toBe(403);

    // A Support Admin holds `platform:audit:read` but not `platform:technical:read`.
    const support = await signIn(EMAIL_SUPPORT);
    expect((await support.get('/platform/technical/overview')).status).toBe(403);
    expect((await support.get('/platform/technical/audit')).status).toBe(200);

    // An Auditor likewise reaches the audit trail only.
    const auditor = await signIn(EMAIL_AUDITOR);
    expect((await auditor.get('/platform/technical/logs')).status).toBe(403);
    expect((await auditor.get('/platform/technical/audit')).status).toBe(200);

    const anonymous = await request(server).get('/platform/technical/overview');
    expect(anonymous.status).toBe(401);
  });

  it('validates the audit action filter rather than passing it to the database', async () => {
    const technical = await signIn(EMAIL_TECHNICAL);

    expect((await technical.get('/platform/technical/audit?action=nope')).status).toBe(400);
    expect((await technical.get('/platform/technical/audit?cursor=identity:not-a-uuid')).status).toBe(
      400,
    );
    expect((await technical.get('/platform/technical/audit?cursor=organization:abc')).status).toBe(
      400,
    );
  });
});
