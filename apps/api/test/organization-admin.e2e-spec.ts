/**
 * Organization Admin allow/deny matrix over the real HTTP stack.
 *
 * The unit suite (`authorization.guard.spec.ts`, `auth.service.spec.ts`) decides
 * every cell of the ADMIN matrix against fakes. This suite proves the same
 * decisions survive the trip through the real Express stack, the real
 * `OrganizationGuard`, the real append-only audit table and real PostgreSQL
 * constraints - and, for the rows that allow, that the write really happens.
 *
 * It exists because RBAC-002 changed `OrganizationsService.removeMember`: an
 * organization admin could remove nobody, and must now be able to remove a
 * strictly-below member while still being refused for a peer admin, the owner
 * and a billing member. Those cases, the two escalation paths (a role change to
 * `OWNER` and an `OWNER` invitation) and cross-tenant access are asserted here
 * end to end.
 *
 * Requires:
 *   npm run infra:up
 *   npm run test:e2e
 *
 * Nothing here reads or writes data it did not create, and every identifier is
 * unique per run: `security_audit_events` is append-only, so the fixtures cannot
 * be deleted and must not collide with a previous run.
 *
 * The database is checked twice before the first write: the connection string
 * must pass the allowlist in `disposable-database.ts`, and the live connection
 * must then report the same database name. See that file for why loopback and a
 * fixed port are not sufficient on their own.
 */

import { randomUUID } from 'node:crypto';

import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { hashPassword } from '@truevine/auth/passwords';
import { createDatabaseClient, type PrismaClient } from '@truevine/database';
import { loadEnvFiles, requireEnv } from '@truevine/shared';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { AppModule } from '../src/app.module.js';
import { APP_CONFIG } from '../src/config/app-config.module.js';
import type { ApiConfig } from '../src/config/api.config.js';
import { DATABASE_CLIENT, REDIS_CLIENT } from '../src/tokens.js';
import { RATE_LIMITER } from '../src/auth/tokens.js';
import { CSRF_COOKIE, CSRF_HEADER, SESSION_COOKIE } from '../src/auth/cookies.js';
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

const PASSWORD = 'an-admin-matrix-passphrase';

const RUN = randomUUID().replace(/-/g, '').slice(0, 8);

/** The admin's own tenant, a neighbour to probe, and a sandbox for a transfer. */
const ORG_ADMIN = randomUUID();
const ORG_NEIGHBOUR = randomUUID();
const ORG_TRANSFER = randomUUID();

const SLUG_ADMIN = `admin-e2e-${RUN}`;
const SLUG_NEIGHBOUR = `admin-e2e-n-${RUN}`;
const SLUG_TRANSFER = `admin-e2e-t-${RUN}`;

/** Members of the admin's organization. Every mutating test gets its own target. */
const USER_OWNER = randomUUID();
const USER_ADMIN = randomUUID();
const USER_PEER_ADMIN = randomUUID();
const USER_BILLING = randomUUID();
const USER_VIEWER_REMOVED = randomUUID();
const USER_MANAGER_REMOVED = randomUUID();
const USER_VIEWER_ESCALATION = randomUUID();
const USER_ADMIN_VICTIM = randomUUID();
const USER_BILLING_VICTIM = randomUUID();

/** A second tenant, so a cross-tenant admin attempt has something real to reach for. */
const USER_NEIGHBOUR_OWNER = randomUUID();
const USER_NEIGHBOUR_MEMBER = randomUUID();

/** A tenant used only by the ownership-transfer cases. */
const USER_TRANSFER_OWNER = randomUUID();
const USER_TRANSFER_TARGET = randomUUID();

const ALL_USERS = [
  USER_OWNER,
  USER_ADMIN,
  USER_PEER_ADMIN,
  USER_BILLING,
  USER_VIEWER_REMOVED,
  USER_MANAGER_REMOVED,
  USER_VIEWER_ESCALATION,
  USER_ADMIN_VICTIM,
  USER_BILLING_VICTIM,
  USER_NEIGHBOUR_OWNER,
  USER_NEIGHBOUR_MEMBER,
  USER_TRANSFER_OWNER,
  USER_TRANSFER_TARGET,
] as const;

/**
 * The address a fixture user signs in with.
 *
 * `users_email_key` is a global, case-insensitive unique index with no tenant
 * scope, so it is derived from the (unique) id rather than hand-written: a fixed
 * address would collide with the previous run's users even though every id is
 * fresh.
 */
const emailOf = (userId: string): string => `${userId}@example.invalid`;

const FIXTURES: readonly (readonly [
  string,
  string,
  'OWNER' | 'ADMIN' | 'BILLING' | 'VIEWER' | 'CAMPAIGN_MANAGER',
])[] = [
  [ORG_ADMIN, USER_OWNER, 'OWNER'],
  [ORG_ADMIN, USER_ADMIN, 'ADMIN'],
  [ORG_ADMIN, USER_PEER_ADMIN, 'ADMIN'],
  [ORG_ADMIN, USER_BILLING, 'BILLING'],
  [ORG_ADMIN, USER_VIEWER_REMOVED, 'VIEWER'],
  [ORG_ADMIN, USER_MANAGER_REMOVED, 'CAMPAIGN_MANAGER'],
  [ORG_ADMIN, USER_VIEWER_ESCALATION, 'VIEWER'],
  [ORG_ADMIN, USER_ADMIN_VICTIM, 'ADMIN'],
  [ORG_ADMIN, USER_BILLING_VICTIM, 'BILLING'],
  [ORG_NEIGHBOUR, USER_NEIGHBOUR_OWNER, 'OWNER'],
  [ORG_NEIGHBOUR, USER_NEIGHBOUR_MEMBER, 'VIEWER'],
  [ORG_TRANSFER, USER_TRANSFER_OWNER, 'OWNER'],
  [ORG_TRANSFER, USER_TRANSFER_TARGET, 'VIEWER'],
];

let app: INestApplication;
let database: PrismaClient;
let server: ReturnType<INestApplication['getHttpServer']>;

beforeAll(async () => {
  loadEnvFiles();
  const databaseUrl = requireEnv('DATABASE_URL');
  const disposable = assertDisposableDatabase(databaseUrl, process.env['NODE_ENV']);

  database = createDatabaseClient(databaseUrl);
  // The URL is a claim; the server is the authority. If a pooler or a stale
  // connection string routed this somewhere else, refuse before writing a row.
  await assertConnectedToDisposableDatabase(async () => {
    const rows = await database.$queryRaw<{ name: string }[]>`SELECT current_database() AS name`;
    return rows[0]?.name;
  }, disposable);

  const passwordHash = await hashPassword(PASSWORD);

  await database.$transaction(async (tx) => {
    await tx.organization.create({
      data: { id: ORG_ADMIN, slug: SLUG_ADMIN, name: 'Admin matrix A' },
    });
    await tx.organization.create({
      data: { id: ORG_NEIGHBOUR, slug: SLUG_NEIGHBOUR, name: 'Admin matrix B' },
    });
    await tx.organization.create({
      data: { id: ORG_TRANSFER, slug: SLUG_TRANSFER, name: 'Admin matrix C' },
    });

    for (const [organizationId, userId, role] of FIXTURES) {
      await tx.user.create({ data: { id: userId, email: emailOf(userId), passwordHash } });
      await tx.membership.create({ data: { organizationId, userId, role } });
    }
  });

  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(APP_CONFIG)
    .useValue(TEST_CONFIG)
    .overrideProvider(DATABASE_CLIENT)
    .useValue(database)
    .overrideProvider(REDIS_CLIENT)
    .useValue({ ping: async () => 'PONG', disconnect: async () => {} })
    // Every request here comes from 127.0.0.1, so the real per-IP limiter would
    // start refusing this suite's own traffic. Rate limiting has unit coverage of
    // its own; what is under test here is authorization across the real stack.
    .overrideProvider(RATE_LIMITER)
    .useValue({ consume: async () => ({ allowed: true, retryAfterMs: 0, remaining: 1000 }) })
    .compile();

  app = moduleRef.createNestApplication();
  await app.init();
  server = app.getHttpServer();
});

/**
 * Deletes the rows this suite is allowed to delete.
 *
 * Sessions, terms acceptances and invitations carry no audit reference. Users,
 * organizations and memberships are deliberately left behind: `security_audit_
 * events` cascades from organizations and restricts on users, so a fixture that
 * has been acted on can no longer be deleted at all. Unique ids per run are what
 * make that safe - there is nothing for the next run to collide with.
 */
async function removeFixtures(client: PrismaClient): Promise<void> {
  await client.session.deleteMany({ where: { userId: { in: [...ALL_USERS] } } });
  await client.termsAcceptance.deleteMany({ where: { userId: { in: [...ALL_USERS] } } });
  await client.invitation.deleteMany({
    where: { organizationId: { in: [ORG_ADMIN, ORG_NEIGHBOUR, ORG_TRANSFER] } },
  });
}

afterAll(async () => {
  // The app first: if a cleanup query were to throw, leaving the HTTP server open
  // would hang the whole run on an unclosed handle instead of failing loudly.
  await app?.close();
  if (database) {
    await removeFixtures(database);
    await database.$disconnect();
  }
});

interface Session {
  readonly cookie: string;
  readonly csrf: string;
}

function extractCookie(header: unknown, name: string): string {
  // Node exposes repeated `Set-Cookie` headers as an array; coercing that to a
  // string joins the values with bare commas and corrupts the cookie value.
  const values = Array.isArray(header) ? header.map(String) : [String(header ?? '')];
  const match = values.find((value) => value.startsWith(`${name}=`));

  if (!match) throw new Error(`No ${name} cookie in the response.`);

  return match.slice(name.length + 1).split(';')[0] ?? '';
}

/** Signs in over HTTP, accepts the terms the guarded routes require, and returns the cookies. */
async function signIn(userId: string): Promise<Session> {
  const probe = await request(server).get('/auth/terms');
  const csrf = decodeURIComponent(extractCookie(probe.headers['set-cookie'], CSRF_COOKIE));

  const signedIn = await request(server)
    .post('/auth/sign-in')
    .set(CSRF_HEADER, csrf)
    .set('cookie', `${CSRF_COOKIE}=${encodeURIComponent(csrf)}`)
    .send({ email: emailOf(userId), password: PASSWORD });

  expect(signedIn.status, `sign-in for ${userId}`).toBe(200);

  const session = extractCookie(signedIn.headers['set-cookie'], SESSION_COOKIE);

  const accepted = await request(server)
    .post('/auth/terms/accept')
    .set('cookie', `${SESSION_COOKIE}=${session}; ${CSRF_COOKIE}=${csrf}`)
    .set(CSRF_HEADER, csrf);
  expect(accepted.status, `terms acceptance for ${userId}`).toBe(204);

  return { cookie: `${SESSION_COOKIE}=${session}`, csrf };
}

const sessions = new Map<string, Session>();

/** Signs a user in once and reuses the session, like an open browser tab would. */
async function sessionFor(userId: string): Promise<Session> {
  const cached = sessions.get(userId);
  if (cached) return cached;

  const created = await signIn(userId);
  sessions.set(userId, created);

  return created;
}

/** The cookie pair plus CSRF header a cookie-authenticated mutation needs. */
function mutationHeaders({ cookie, csrf }: Session): Record<string, string> {
  return { cookie: `${cookie}; ${CSRF_COOKIE}=${csrf}`, [CSRF_HEADER]: csrf };
}

async function roleOf(organizationId: string, userId: string): Promise<string | undefined> {
  const membership = await database.membership.findUnique({
    where: { organizationId_userId: { organizationId, userId } },
  });

  return membership?.role;
}

async function memberCount(organizationId: string): Promise<number> {
  return database.membership.count({ where: { organizationId } });
}

const memberPath = (organizationId: string, userId: string): string =>
  `/organizations/${organizationId}/members/${userId}`;

/** Reads an audit row's `metadata` Json column as a plain object, for assertions. */
function metadataOf(row: { readonly metadata: unknown }): Record<string, unknown> {
  return typeof row.metadata === 'object' && row.metadata !== null
    ? (row.metadata as Record<string, unknown>)
    : {};
}

describe('organization admin removing members over HTTP', () => {
  it('lets an admin remove a viewer', async () => {
    const admin = await sessionFor(USER_ADMIN);

    const response = await request(server)
      .delete(memberPath(ORG_ADMIN, USER_VIEWER_REMOVED))
      .set(mutationHeaders(admin));

    // 204: removal returns no body, so absence is asserted rather than read.
    expect(response.status, JSON.stringify(response.body)).toBe(204);

    const membership = await database.membership.findUnique({
      where: {
        organizationId_userId: { organizationId: ORG_ADMIN, userId: USER_VIEWER_REMOVED },
      },
    });
    expect(membership).toBeNull();

    // The successful write is on the audit trail, attributed to the admin.
    const auditRows = await database.securityAuditEvent.findMany({
      where: { organizationId: ORG_ADMIN, action: 'organization.member.removed' },
    });
    expect(auditRows.some((row) => row.actorUserId === USER_ADMIN)).toBe(true);
  });

  it('lets an admin remove a campaign manager', async () => {
    const admin = await sessionFor(USER_ADMIN);

    const response = await request(server)
      .delete(memberPath(ORG_ADMIN, USER_MANAGER_REMOVED))
      .set(mutationHeaders(admin));

    expect(response.status, JSON.stringify(response.body)).toBe(204);
    expect(await roleOf(ORG_ADMIN, USER_MANAGER_REMOVED)).toBeUndefined();
  });

  it('refuses an admin removing a peer admin', async () => {
    const admin = await sessionFor(USER_ADMIN);

    const response = await request(server)
      .delete(memberPath(ORG_ADMIN, USER_PEER_ADMIN))
      .set(mutationHeaders(admin));

    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe('cannot_delegate_beyond_own_authority');
    expect(await roleOf(ORG_ADMIN, USER_PEER_ADMIN)).toBe('ADMIN');
  });

  it('refuses an admin removing the organization owner', async () => {
    const admin = await sessionFor(USER_ADMIN);

    const response = await request(server)
      .delete(memberPath(ORG_ADMIN, USER_OWNER))
      .set(mutationHeaders(admin));

    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe('cannot_delegate_beyond_own_authority');
    expect(await roleOf(ORG_ADMIN, USER_OWNER)).toBe('OWNER');
  });

  it('refuses an admin removing a billing member', async () => {
    const admin = await sessionFor(USER_ADMIN);

    const response = await request(server)
      .delete(memberPath(ORG_ADMIN, USER_BILLING))
      .set(mutationHeaders(admin));

    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe('cannot_delegate_beyond_own_authority');
    expect(await roleOf(ORG_ADMIN, USER_BILLING)).toBe('BILLING');
  });

  it('refuses an admin removing themselves', async () => {
    const admin = await sessionFor(USER_ADMIN);

    const response = await request(server)
      .delete(memberPath(ORG_ADMIN, USER_ADMIN))
      .set(mutationHeaders(admin));

    expect(response.status).toBe(403);
    expect(await roleOf(ORG_ADMIN, USER_ADMIN)).toBe('ADMIN');
  });

  it('answers 404 for a user who is not a member of the organization', async () => {
    const admin = await sessionFor(USER_ADMIN);

    // A leaked or guessed id from another tenant, used against the admin's own
    // path: the guard authorizes the *organization*, and the target lookup is
    // then scoped to it, so the id is worth nothing.
    const response = await request(server)
      .delete(memberPath(ORG_ADMIN, USER_NEIGHBOUR_MEMBER))
      .set(mutationHeaders(admin));

    expect(response.status).toBe(404);
    expect(response.body.error.code).toBe('organization_membership_required');
    expect(await roleOf(ORG_NEIGHBOUR, USER_NEIGHBOUR_MEMBER)).toBe('VIEWER');
  });
});

describe('organization admin escalation refusals over HTTP', () => {
  it('refuses an admin transferring ownership, and audits the attempt', async () => {
    const admin = await sessionFor(USER_ADMIN);

    const response = await request(server)
      .post(`/organizations/${ORG_ADMIN}/ownership/transfer`)
      .set(mutationHeaders(admin))
      .send({ newOwnerId: USER_ADMIN });

    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe('permission_denied');
    expect(await roleOf(ORG_ADMIN, USER_ADMIN)).toBe('ADMIN');
    expect(await roleOf(ORG_ADMIN, USER_OWNER)).toBe('OWNER');

    // The guard records the refusal against the permission, so the attempt is
    // visible rather than merely rejected.
    const denials = await database.securityAuditEvent.findMany({
      where: { organizationId: ORG_ADMIN, action: 'authorization.denied' },
    });
    expect(
      denials.some(
        (row) =>
          row.actorUserId === USER_ADMIN && metadataOf(row)['permission'] === 'ownership:transfer',
      ),
    ).toBe(true);
  });

  it('refuses an admin promoting a member to owner', async () => {
    const admin = await sessionFor(USER_ADMIN);

    const response = await request(server)
      .patch(memberPath(ORG_ADMIN, USER_VIEWER_ESCALATION))
      .set(mutationHeaders(admin))
      .send({ role: 'OWNER' });

    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe('cannot_delegate_beyond_own_authority');
    expect(await roleOf(ORG_ADMIN, USER_VIEWER_ESCALATION)).toBe('VIEWER');
  });

  it('refuses an admin issuing an owner invitation', async () => {
    const admin = await sessionFor(USER_ADMIN);
    const email = `${randomUUID()}@example.invalid`;

    const response = await request(server)
      .post(`/organizations/${ORG_ADMIN}/invitations`)
      .set(mutationHeaders(admin))
      .send({ email, role: 'OWNER' });

    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe('cannot_delegate_beyond_own_authority');
    // Refused before a token is generated, so nothing was recorded.
    expect(await database.invitation.count({ where: { organizationId: ORG_ADMIN, email } })).toBe(
      0,
    );
  });

  it('refuses an admin issuing a billing invitation', async () => {
    const admin = await sessionFor(USER_ADMIN);
    const email = `${randomUUID()}@example.invalid`;

    const response = await request(server)
      .post(`/organizations/${ORG_ADMIN}/invitations`)
      .set(mutationHeaders(admin))
      .send({ email, role: 'BILLING' });

    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe('cannot_delegate_beyond_own_authority');
    expect(await database.invitation.count({ where: { organizationId: ORG_ADMIN, email } })).toBe(
      0,
    );
  });

  it('lets an admin invite a viewer, so the rows above are not passing by accident', async () => {
    const admin = await sessionFor(USER_ADMIN);
    const email = `${randomUUID()}@example.invalid`;

    const response = await request(server)
      .post(`/organizations/${ORG_ADMIN}/invitations`)
      .set(mutationHeaders(admin))
      .send({ email, role: 'VIEWER' });

    expect(response.status, JSON.stringify(response.body)).toBe(201);
    expect(response.body.role).toBe('VIEWER');

    const stored = await database.invitation.findFirst({
      where: { organizationId: ORG_ADMIN, email },
    });
    expect(stored?.role).toBe('VIEWER');
  });
});

describe('organization admin tenant boundaries over HTTP', () => {
  it('refuses an admin reading another tenant, and files the denial there', async () => {
    const admin = await sessionFor(USER_ADMIN);

    const response = await request(server)
      .get(`/organizations/${ORG_NEIGHBOUR}`)
      .set('cookie', admin.cookie);

    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe('permission_denied');

    // Recorded against the tenant that was probed, which is the party with an
    // interest in knowing its boundary was tested.
    const denials = await database.securityAuditEvent.findMany({
      where: { organizationId: ORG_NEIGHBOUR, action: 'authorization.denied' },
    });
    expect(
      denials.some(
        (row) => row.actorUserId === USER_ADMIN && metadataOf(row)['reason'] === 'no_membership',
      ),
    ).toBe(true);
  });

  it('refuses an admin removing a member of another tenant', async () => {
    const admin = await sessionFor(USER_ADMIN);

    const response = await request(server)
      .delete(memberPath(ORG_NEIGHBOUR, USER_NEIGHBOUR_MEMBER))
      .set(mutationHeaders(admin));

    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe('permission_denied');
    expect(await memberCount(ORG_NEIGHBOUR)).toBe(2);
    expect(await roleOf(ORG_NEIGHBOUR, USER_NEIGHBOUR_MEMBER)).toBe('VIEWER');
  });

  it('refuses an admin changing a role in another tenant', async () => {
    const admin = await sessionFor(USER_ADMIN);

    const response = await request(server)
      .patch(memberPath(ORG_NEIGHBOUR, USER_NEIGHBOUR_MEMBER))
      .set(mutationHeaders(admin))
      .send({ role: 'ADMIN' });

    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe('permission_denied');
    expect(await roleOf(ORG_NEIGHBOUR, USER_NEIGHBOUR_MEMBER)).toBe('VIEWER');
  });
});

describe('owner privileges are unchanged by the admin rules', () => {
  it('still lets an owner remove an admin', async () => {
    const owner = await sessionFor(USER_OWNER);

    const response = await request(server)
      .delete(memberPath(ORG_ADMIN, USER_ADMIN_VICTIM))
      .set(mutationHeaders(owner));

    expect(response.status, JSON.stringify(response.body)).toBe(204);
    expect(await roleOf(ORG_ADMIN, USER_ADMIN_VICTIM)).toBeUndefined();
  });

  it('still lets an owner remove a billing member', async () => {
    const owner = await sessionFor(USER_OWNER);

    const response = await request(server)
      .delete(memberPath(ORG_ADMIN, USER_BILLING_VICTIM))
      .set(mutationHeaders(owner));

    expect(response.status, JSON.stringify(response.body)).toBe(204);
    expect(await roleOf(ORG_ADMIN, USER_BILLING_VICTIM)).toBeUndefined();
  });

  it('still lets an owner transfer ownership', async () => {
    const owner = await sessionFor(USER_TRANSFER_OWNER);

    const response = await request(server)
      .post(`/organizations/${ORG_TRANSFER}/ownership/transfer`)
      .set(mutationHeaders(owner))
      .send({ newOwnerId: USER_TRANSFER_TARGET });

    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(response.body.ok).toBe(true);

    // Ownership moves, and the previous owner is demoted rather than removed, so
    // the organization is never left without an owner.
    expect(await roleOf(ORG_TRANSFER, USER_TRANSFER_TARGET)).toBe('OWNER');
    expect(await roleOf(ORG_TRANSFER, USER_TRANSFER_OWNER)).toBe('ADMIN');
  });
});
