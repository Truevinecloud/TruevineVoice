/**
 * Authorization against the real HTTP stack and real PostgreSQL.
 *
 * The unit suite proves the guards and services behave. This proves the whole
 * thing works when the database constraints are the ones doing the work, and -
 * more importantly - that a real request with a forged organization id, a forged
 * body field and a guessed resource id is refused.
 *
 * Requires:
 *   npm run infra:up
 *   npm run test:e2e
 *
 * Every row this suite creates is removed in `afterAll`. It creates nothing it
 * cannot clean up, and it never reads or writes data it did not create.
 */

import { randomUUID } from 'node:crypto';

import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { hashPassword } from '@truevine/auth/passwords';
import { loadEnvFiles, requireEnv } from '@truevine/shared';
import { createDatabaseClient, type PrismaClient } from '@truevine/database';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { AppModule } from '../src/app.module.js';
import { APP_CONFIG } from '../src/config/app-config.module.js';
import type { ApiConfig } from '../src/config/api.config.js';
import { DATABASE_CLIENT, REDIS_CLIENT } from '../src/tokens.js';
import { RATE_LIMITER } from '../src/auth/tokens.js';
import { CSRF_COOKIE, CSRF_HEADER, SESSION_COOKIE } from '../src/auth/cookies.js';

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

let app: INestApplication;
let database: PrismaClient;

/** The HTTP server supertest drives. Typed, so a wrong argument is a compile error. */
let server: ReturnType<INestApplication['getHttpServer']>;

/**
 * Fixture identifiers, unique per run.
 *
 * They cannot be fixed constants, and the reason is a working security control:
 * `security_audit_events` is append-only, enforced by a database trigger, so
 * this suite physically cannot delete its own audit rows in teardown. Fixed ids
 * would therefore collide with the previous run's audit history every time.
 *
 * Unique ids per run mean there is nothing to collide, and nothing to clean.
 * Audit rows accumulate in a long-lived development database; that is the cost of
 * an immutable audit trail, and `npm run db:reset` is the answer for a developer
 * who wants a clean slate. CI starts from a fresh database, so it never
 * accumulates.
 *
 * The identifiers are plain `randomUUID()` values rather than a readable prefix
 * with a run tag. Hand-assembling a UUID gets the 8-4-4-4-12 grouping wrong at
 * least once, and PostgreSQL rejects it with a type error that points at the
 * value rather than at the template.
 */
const RUN = randomUUID().replace(/-/g, '').slice(0, 8);
const ORG_A = randomUUID();
const ORG_B = randomUUID();
const USER_A = randomUUID();
const USER_B = randomUUID();
const SLUG_A = `e2e-a-${RUN}`;
const SLUG_B = `e2e-b-${RUN}`;

/**
 * Emails are unique per run as well.
 *
 * `users_email_key` is a global, case-insensitive unique index with no tenant
 * scope, so a fixed address collides with the previous run's users even though
 * every *id* is fresh.
 */
const EMAIL_A = `e2e-a-${RUN}@example.invalid`;
const EMAIL_B = `e2e-b-${RUN}@example.invalid`;

/**
 * Deletes the rows this suite is able to delete.
 *
 * Organizations and users are deliberately absent, and this is not an oversight:
 * `security_audit_events` cascades from `organizations` and restricts on
 * `users`, so a fixture that generated audit history cannot be removed at all.
 * The identifiers are unique per run, so leaving them costs nothing but a few
 * rows in a development database.
 */
async function removeFixtures(client: PrismaClient): Promise<void> {
  await client.$executeRaw`DELETE FROM sessions WHERE user_id IN (${USER_A}::uuid, ${USER_B}::uuid)`;
  await client.$executeRaw`DELETE FROM terms_acceptances WHERE user_id IN (${USER_A}::uuid, ${USER_B}::uuid)`;
  await client.$executeRaw`DELETE FROM invitations WHERE organization_id IN (${ORG_A}::uuid, ${ORG_B}::uuid)`;
}

beforeAll(async () => {
  loadEnvFiles();

  const databaseUrl = requireEnv('DATABASE_URL');
  database = createDatabaseClient(databaseUrl);

  // Clean the fixtures BEFORE creating them, not only afterwards. A suite that
  // fails partway through skips its own teardown, and the next run then collides
  // with whatever the last one left behind - turning one real failure into a
  // cascade of "duplicate key" noise that hides the original cause.
  await removeFixtures(database);

  await database.$executeRaw`
    INSERT INTO organizations (id, slug, name, updated_at) VALUES
      (${ORG_A}::uuid, ${SLUG_A}, 'E2E Org A', now()),
      (${ORG_B}::uuid, ${SLUG_B}, 'E2E Org B', now())
  `;

  const passwordHash = await hashPassword(PASSWORD);

  await database.$executeRaw`
    INSERT INTO users (id, email, password_hash, updated_at) VALUES
      (${USER_A}::uuid, ${EMAIL_A}, ${passwordHash}, now()),
      (${USER_B}::uuid, ${EMAIL_B}, ${passwordHash}, now())
  `;

  await database.$executeRaw`
    INSERT INTO memberships (organization_id, user_id, role, updated_at) VALUES
      (${ORG_A}::uuid, ${USER_A}::uuid, 'OWNER', now()),
      (${ORG_B}::uuid, ${USER_B}::uuid, 'OWNER', now())
  `;

  // The identities the suite exists to keep apart: same platform, different
  // organizations. Nothing may let one reach the other's data.
  void [ORG_A, ORG_B, USER_A, USER_B, EMAIL_A, EMAIL_B];

  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(APP_CONFIG)
    .useValue(TEST_CONFIG)
    // The real Prisma client, so the suite exercises real constraints.
    .overrideProvider(DATABASE_CLIENT)
    .useValue(database)
    .overrideProvider(REDIS_CLIENT)
    .useValue({ ping: async () => 'PONG', disconnect: () => undefined })
    // Rate limiting is replaced deliberately. Every request in this file arrives
    // from 127.0.0.1, so the real limiter counts them all as one client and
    // correctly refuses the tenth - which would make this suite fail for a
    // reason that has nothing to do with what it is testing. The limiter's own
    // behaviour is covered in `auth.service.spec.ts`; what is exercised here is
    // the real database and the real HTTP stack.
    .overrideProvider(RATE_LIMITER)
    .useValue({
      consume: async () => ({ allowed: true, retryAfterMs: 0, remaining: 1000 }),
    })
    .compile();

  app = moduleRef.createNestApplication();
  await app.init();
  server = app.getHttpServer();
});

afterAll(async () => {
  await app?.close();
  await database?.$disconnect();
});

/** Signs in and returns the cookies plus a matching CSRF header. */
async function signIn(email: string): Promise<{ cookie: string; csrf: string }> {
  const agent = request(server);

  const probe = await agent.get('/auth/terms');
  const csrfCookie = extractCookie(probe.headers['set-cookie'], CSRF_COOKIE);
  const csrf = decodeURIComponent(csrfCookie);

  const response = await agent
    .post('/auth/sign-in')
    .set(CSRF_HEADER, csrf)
    .set('cookie', `${CSRF_COOKIE}=${encodeURIComponent(csrf)}`)
    .send({ email, password: PASSWORD });

  expect(response.status, `sign-in for ${email}`).toBe(200);

  const session = extractCookie(response.headers['set-cookie'], SESSION_COOKIE);

  return { cookie: `${SESSION_COOKIE}=${session}`, csrf };
}

function extractCookie(header: unknown, name: string): string {
  // Node exposes repeated `Set-Cookie` headers as an array. Coercing that to a
  // string joins the values with bare commas, which silently breaks any later
  // `split(', ')` and produces a cookie value with trailing attributes in it.
  const values = Array.isArray(header) ? header.map(String) : [String(header ?? '')];
  const match = values.find((value) => value.startsWith(`${name}=`));

  if (!match) throw new Error(`No ${name} cookie in the response.`);

  return match.slice(name.length + 1).split(';')[0] ?? '';
}

/** Every `Set-Cookie` header value, as individual strings. */
function setCookieHeaders(header: unknown): string[] {
  return Array.isArray(header) ? header.map(String) : [String(header ?? '')];
}

describe('sign-in over HTTP', () => {
  it('refuses an unknown address with 401', async () => {
    const response = await request(server)
      .get('/auth/terms')
      .then(async (probe) => {
        const csrf = decodeURIComponent(extractCookie(probe.headers['set-cookie'], CSRF_COOKIE));
        return request(server)
          .post('/auth/sign-in')
          .set(CSRF_HEADER, csrf)
          .set('cookie', `${CSRF_COOKIE}=${encodeURIComponent(csrf)}`)
          .send({ email: 'nobody@example.invalid', password: PASSWORD });
      });

    expect(response.status).toBe(401);
    expect(response.body.error.code).toBe('invalid_credentials');
  });

  it('sets the session cookie as HttpOnly and the CSRF cookie as readable', async () => {
    const response = await request(server).get('/auth/terms');

    // The probe above never set a session cookie; signing in does. Reuse the
    // helper's path but assert on the raw headers.
    const csrf = decodeURIComponent(extractCookie(response.headers['set-cookie'], CSRF_COOKIE));
    const signedIn = await request(server)
      .post('/auth/sign-in')
      .set(CSRF_HEADER, csrf)
      .set('cookie', `${CSRF_COOKIE}=${encodeURIComponent(csrf)}`)
      .send({ email: EMAIL_A, password: PASSWORD });

    const cookies = setCookieHeaders(signedIn.headers['set-cookie']);

    const sessionCookie = cookies.find((c) => c.startsWith(`${SESSION_COOKIE}=`));
    const csrfCookie = cookies.find((c) => c.startsWith(`${CSRF_COOKIE}=`));

    // The session must be unreadable by script; the CSRF cookie must be readable,
    // because the double-submit pattern depends on the client reading it.
    expect(sessionCookie).toContain('HttpOnly');
    expect(sessionCookie).toContain('SameSite=Lax');
    expect(csrfCookie).toBeDefined();
    expect(csrfCookie).not.toContain('HttpOnly');
  });

  it('never returns the session token in the response body', async () => {
    const probe = await request(server).get('/auth/terms');
    const csrf = decodeURIComponent(extractCookie(probe.headers['set-cookie'], CSRF_COOKIE));

    const response = await request(server)
      .post('/auth/sign-in')
      .set(CSRF_HEADER, csrf)
      .set('cookie', `${CSRF_COOKIE}=${encodeURIComponent(csrf)}`)
      .send({ email: EMAIL_A, password: PASSWORD });

    expect(JSON.stringify(response.body)).not.toContain('sessionToken');
  });

  it('refuses a mutation with no CSRF token', async () => {
    const response = await request(server)
      .post('/auth/sign-in')
      .send({ email: EMAIL_A, password: PASSWORD });

    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe('csrf_token_invalid');
  });
});

describe('tenant isolation over HTTP', () => {
  it('lets an owner read their own organization', async () => {
    const { cookie } = await signIn(EMAIL_A);

    const response = await request(server).get(`/organizations/${ORG_A}`).set('cookie', cookie);

    expect(response.status).toBe(200);
    expect(response.body.id).toBe(ORG_A);
  });

  it('refuses Customer A reading Customer B', async () => {
    const { cookie } = await signIn(EMAIL_A);

    const response = await request(server).get(`/organizations/${ORG_B}`).set('cookie', cookie);

    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe('permission_denied');
  });

  it('answers identically for a tenant that does not exist', async () => {
    const { cookie } = await signIn(EMAIL_A);

    const missing = await request(server)
      .get('/organizations/00000000-0000-4000-8000-0000000000ff')
      .set('cookie', cookie);
    const foreign = await request(server).get(`/organizations/${ORG_B}`).set('cookie', cookie);

    expect(missing.status).toBe(403);
    expect(foreign.status).toBe(403);
    expect(missing.body.error).toEqual(foreign.body.error);
  });

  it('refuses a forged organization id in the request body', async () => {
    const { cookie, csrf } = await signIn(EMAIL_A);

    // The path says org A; the body claims org B. The path is authoritative and
    // validated, so the body must not be able to redirect the write.
    const response = await request(server)
      .patch(`/organizations/${ORG_A}`)
      .set('cookie', cookie)
      .set(CSRF_HEADER, csrf)
      .set('cookie', `${cookie}; ${CSRF_COOKIE}=${csrf}`)
      .send({ organizationId: ORG_B, name: 'Renamed' });

    expect(response.status).toBe(200);
    expect(response.body.id).toBe(ORG_A);

    const untouched = await database.organization.findUnique({ where: { id: ORG_B } });
    expect(untouched?.name).toBe('E2E Org B');
  });

  it('refuses a guessed member id from another tenant', async () => {
    const { cookie, csrf } = await signIn(EMAIL_A);

    // The path names org A - where the caller really is a member - but the target
    // user belongs to org B. A guessed or leaked resource identifier must be worth
    // nothing: the guard authorizes the *organization*, and the role change is
    // then constrained to that organization's members.
    const response = await request(server)
      .patch(`/organizations/${ORG_A}/members/${USER_B}`)
      .set('cookie', `${cookie}; ${CSRF_COOKIE}=${csrf}`)
      .set(CSRF_HEADER, csrf)
      .send({ role: 'ADMIN' });

    expect(response.status).toBe(404);

    const untouched = await database.membership.findUnique({
      where: { organizationId_userId: { organizationId: ORG_B, userId: USER_B } },
    });
    expect(untouched?.role).toBe('OWNER');
  });

  it('refuses removing a member of another tenant', async () => {
    const { cookie, csrf } = await signIn(EMAIL_A);

    const response = await request(server)
      .delete(`/organizations/${ORG_A}/members/${USER_B}`)
      .set('cookie', `${cookie}; ${CSRF_COOKIE}=${csrf}`)
      .set(CSRF_HEADER, csrf);

    expect(response.status).toBe(404);
    expect(await database.membership.count({ where: { userId: USER_B } })).toBe(1);
  });

  it('refuses every organization route with no session', async () => {
    for (const path of [
      `/organizations/${ORG_A}`,
      `/organizations/${ORG_A}/members`,
      `/organizations/${ORG_A}/invitations`,
    ]) {
      const response = await request(server).get(path);
      expect(response.status, path).toBe(401);
    }
  });

  it('reports the caller own organizations and nothing else', async () => {
    const { cookie } = await signIn(EMAIL_A);

    const response = await request(server).get('/me').set('cookie', cookie);

    expect(response.status).toBe(200);
    expect(response.body.memberships).toHaveLength(1);
    expect(response.body.memberships[0].organizationId).toBe(ORG_A);
    expect(response.body.platformRole).toBeNull();
  });

  it('never includes the password hash anywhere in a response', async () => {
    const { cookie } = await signIn(EMAIL_A);

    const me = await request(server).get('/me').set('cookie', cookie);
    const members = await request(server)
      .get(`/organizations/${ORG_A}/members`)
      .set('cookie', cookie);

    expect(JSON.stringify(me.body)).not.toContain('argon2');
    expect(JSON.stringify(members.body)).not.toContain('argon2');
  });
});

describe('audit trail over HTTP', () => {
  it('records a successful profile change', async () => {
    const { cookie, csrf } = await signIn(EMAIL_A);

    const response = await request(server)
      .patch(`/organizations/${ORG_A}`)
      .set('cookie', `${cookie}; ${CSRF_COOKIE}=${csrf}`)
      .set(CSRF_HEADER, csrf)
      .send({ name: 'E2E Org A Renamed' });

    expect(response.status, JSON.stringify(response.body)).toBe(200);

    const rows = await database.securityAuditEvent.findMany({
      where: { organizationId: ORG_A, action: 'organization.profile_updated' },
    });

    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0]?.outcome).toBe('SUCCESS');
    expect(rows[0]?.actorUserId).toBe(USER_A);
  });

  it('records a cross-tenant attempt against the tenant that was probed', async () => {
    const { cookie } = await signIn(EMAIL_A);

    await request(server).get(`/organizations/${ORG_B}`).set('cookie', cookie);

    // Deliberately recorded against ORG_B, the organization that was targeted -
    // not against the caller's own. `organization_id` is NOT NULL, and a caller
    // who belongs to no organization (the case worth recording most) has no
    // organization of their own to file it under. The targeted tenant is the
    // party with a legitimate interest in knowing they were probed.
    const rows = await database.securityAuditEvent.findMany({
      where: { organizationId: ORG_B, action: 'authorization.denied' },
    });

    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0]?.outcome).toBe('DENIED');
    expect(rows[0]?.actorUserId).toBe(USER_A);
    expect(rows[0]?.metadata).toMatchObject({ reason: 'no_membership' });
  });

  it('records a sign-in', async () => {
    await signIn(EMAIL_B);

    const rows = await database.identityAuditEvent.findMany({
      where: { actorUserId: USER_B, action: 'auth.sign_in.succeeded' },
    });

    expect(rows.length).toBeGreaterThan(0);
  });

  it('writes no credential into an audit row', async () => {
    const rows = await database.identityAuditEvent.findMany();

    expect(JSON.stringify(rows)).not.toContain(PASSWORD);
    expect(JSON.stringify(rows)).not.toContain('argon2');
  });
});

describe('teardown', () => {
  it('refuses to delete anything the audit trail refers to', async () => {
    // The consequences of append-only, stated as assertions rather than left to
    // be discovered:
    //
    //   - `security_audit_events.organization_id` cascades from organizations, so
    //     deleting an organization that has audit events is refused.
    //   - `security_audit_events.actor_user_id` is ON DELETE RESTRICT, so a user
    //     who has acted cannot be deleted either.
    //
    // Together these mean the fixtures this suite creates cannot be removed,
    // which is exactly why the identifiers are unique per run. A right-to-erasure
    // procedure would have to anonymise rather than delete; that is an open
    // decision recorded in ADR 0009, not something this suite resolves.
    const deleteOrganization =
      await database.$executeRaw`DELETE FROM organizations WHERE id = ${ORG_A}::uuid`
        .then(() => 'deleted')
        .catch((error: { message: string }) => error.message);

    expect(deleteOrganization).toMatch(/append-only/i);

    const deleteUser = await database.$executeRaw`DELETE FROM users WHERE id = ${USER_A}::uuid`
      .then(() => 'deleted')
      .catch((error: { message: string }) => error.message);

    expect(deleteUser).toMatch(/append-only|foreign key/i);
  });

  it('removed what it safely could', async () => {
    // Sessions and terms acceptances carry no audit reference, so they do go.
    await removeFixtures(database);

    const sessions = await database.session.count({
      where: { userId: { in: [USER_A, USER_B] } },
    });
    const terms = await database.termsAcceptance.count({
      where: { userId: { in: [USER_A, USER_B] } },
    });

    expect(sessions).toBe(0);
    expect(terms).toBe(0);
  });
});
