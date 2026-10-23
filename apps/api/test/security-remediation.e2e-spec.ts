import { randomUUID } from 'node:crypto';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { resolve } from 'node:path';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { hashToken } from '@truevine/auth';
import { hashPassword } from '@truevine/auth/passwords';
import { createDatabaseClient, type PrismaClient } from '@truevine/database';
import { loadEnvFiles, requireEnv } from '@truevine/shared';
import { NullEmailSender } from '@truevine/messaging';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { DATABASE_CLIENT, REDIS_CLIENT } from '../src/tokens.js';
import { RATE_LIMITER } from '../src/auth/tokens.js';
import {
  PrismaAuditStore,
  PrismaAuthStore,
  PrismaOrganizationStore,
  PrismaSecurityTransaction,
} from '../src/auth/prisma-stores.js';
import { AuthService } from '../src/auth/auth.service.js';
import { OrganizationsService } from '../src/organizations/organizations.service.js';

const terms = '2026-10-01';
const password = 'security-regression-passphrase';
const allow = { consume: async () => ({ allowed: true, retryAfterMs: 0, remaining: 1000 }) };
const context = { ipPrefix: '127.0.0.0/24', userAgentHash: null };
let db: PrismaClient, second: PrismaClient, app: INestApplication, hash: string;
let server: ReturnType<INestApplication['getHttpServer']>;
function services(database: PrismaClient) {
  const auth = new PrismaAuthStore(database),
    audit = new PrismaAuditStore(database);
  const organizations = new PrismaOrganizationStore(database),
    transaction = new PrismaSecurityTransaction(database);
  return {
    auth: new AuthService(
      auth,
      audit,
      allow,
      new NullEmailSender(),
      'http://localhost:3000',
      5,
      60000,
      60000,
      transaction,
    ),
    organizations: new OrganizationsService(
      organizations,
      auth,
      audit,
      new NullEmailSender(),
      'http://localhost:3000',
      terms,
      transaction,
      allow,
    ),
  };
}
beforeAll(async () => {
  loadEnvFiles();
  const url = requireEnv('DATABASE_URL');
  if (
    !new URL(url).pathname.startsWith('/rbac_security_') &&
    !(process.env['CI'] === 'true' && new URL(url).pathname === '/truevine_voice')
  )
    throw new Error('Run npm run test:security against its disposable database.');
  db = createDatabaseClient(url);
  second = createDatabaseClient(url);
  hash = await hashPassword(password);
  // Fail loudly if the migration is missing, rather than testing without it.
  const indexes = await db.$queryRaw<
    Array<{ indexname: string }>
  >`SELECT indexname FROM pg_indexes WHERE indexname = 'memberships_single_owner'`;
  expect(indexes).toHaveLength(1);
  const module = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(DATABASE_CLIENT)
    .useValue(db)
    .overrideProvider(REDIS_CLIENT)
    .useValue({ ping: async () => 'PONG', disconnect: () => undefined })
    // The HTTP IP limiter is covered separately. These tests isolate the real
    // persistent per-account protection and repeated DB concurrency contracts.
    .overrideProvider(RATE_LIMITER)
    .useValue(allow)
    .compile();
  app = module.createNestApplication();
  await app.init();
  server = app.getHttpServer();
}, 30000);
afterAll(async () => {
  await app?.close();
  await second?.$disconnect();
  await db?.$disconnect();
});

async function tenant(accepted = true) {
  const organizationId = randomUUID(),
    ids = [randomUUID(), randomUUID(), randomUUID()];
  await db.$transaction(async (tx) => {
    await tx.organization.create({
      data: { id: organizationId, slug: 'security-' + organizationId, name: 'Security fixture' },
    });
    for (const [index, id] of ids.entries()) {
      await tx.user.create({ data: { id, email: `${id}@example.invalid`, passwordHash: hash } });
      await tx.membership.create({
        data: { organizationId, userId: id, role: index === 0 ? 'OWNER' : 'VIEWER' },
      });
      if (accepted) await tx.termsAcceptance.create({ data: { userId: id, termsVersion: terms } });
    }
  });
  return { organizationId, ids };
}
async function cookie(userId: string) {
  const raw = randomUUID(),
    csrf = randomUUID();
  await db.session.create({
    data: { userId, tokenHash: hashToken(raw), expiresAt: new Date(Date.now() + 600000) },
  });
  return { cookie: `tv_session=${raw}; tv_csrf=${csrf}`, csrf };
}
async function invite(organizationId: string, invitedByUserId: string, userId: string) {
  const token = randomUUID();
  await db.invitation.create({
    data: {
      organizationId,
      email: `${userId}@example.invalid`,
      role: 'VIEWER',
      tokenHash: hashToken(token),
      invitedByUserId,
      expiresAt: new Date(Date.now() + 600000),
    },
  });
  return token;
}
async function inviteEmail(
  organizationId: string,
  invitedByUserId: string,
  email: string,
  role: 'ADMIN' | 'CAMPAIGN_MANAGER' | 'BILLING' | 'VIEWER' = 'VIEWER',
) {
  const token = randomUUID();
  await db.invitation.create({
    data: {
      organizationId,
      email,
      role,
      tokenHash: hashToken(token),
      invitedByUserId,
      expiresAt: new Date(Date.now() + 600000),
    },
  });
  return token;
}
async function rejectAudit(
  userId: string,
  table: 'identity_audit_events' | 'security_audit_events',
  body: () => Promise<void>,
) {
  const name = 'reject_' + randomUUID().replaceAll('-', '');
  await db.$executeRawUnsafe(
    `CREATE FUNCTION ${name}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.actor_user_id = '${userId}'::uuid THEN RAISE EXCEPTION 'injected audit storage failure'; END IF; RETURN NEW; END $$`,
  );
  await db.$executeRawUnsafe(
    `CREATE TRIGGER ${name} BEFORE INSERT ON ${table} FOR EACH ROW EXECUTE FUNCTION ${name}()`,
  );
  try {
    await body();
  } finally {
    await db.$executeRawUnsafe(`DROP TRIGGER ${name} ON ${table}`);
    await db.$executeRawUnsafe(`DROP FUNCTION ${name}()`);
  }
}

async function startIndependentApi(
  redisUrl: string,
): Promise<{ child: ChildProcess; port: number }> {
  const reservation = createServer();
  await new Promise<void>((done, reject) => {
    reservation.once('error', reject);
    reservation.listen(0, '127.0.0.1', done);
  });
  const address = reservation.address();
  if (!address || typeof address === 'string') throw new Error('Port reservation failed');
  const port = address.port;
  await new Promise<void>((done, reject) =>
    reservation.close((error) => (error ? reject(error) : done())),
  );
  const child = spawn(process.execPath, [resolve('dist/main.js')], {
    env: {
      ...process.env,
      API_HOST: '127.0.0.1',
      API_PORT: String(port),
      EMAIL_TRANSPORT: 'none',
      WEB_PUBLIC_URL: 'http://localhost:3000',
      REDIS_URL: redisUrl,
    },
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  try {
    await new Promise<void>((done, reject) => {
      const timer = setTimeout(
        () => reject(new Error('Independent API failed to start within 15 seconds')),
        15000,
      );
      child.once('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.once('exit', (code) => {
        clearTimeout(timer);
        reject(new Error(`Independent API exited during startup: ${code}`));
      });
      child.stderr?.on('data', () => {});
      child.stdout?.on('data', (data) => {
        if (String(data).includes('listening on http://')) {
          clearTimeout(timer);
          done();
        }
      });
    });
    return { child, port };
  } catch (error) {
    child.kill();
    throw error;
  }
}
async function stopIndependentApi(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((done) => {
    child.once('exit', () => done());
    child.kill();
  });
}

describe('real PostgreSQL security regressions', () => {
  it('concurrent sign-out commits one revocation audit, without a false duplicate success', async () => {
    const { ids } = await tenant();
    const session = await cookie(ids[0]!);
    const results = await Promise.all(
      Array.from({ length: 6 }, () =>
        request(server)
          .post('/auth/sign-out')
          .set('cookie', session.cookie)
          .set('x-truevine-csrf', session.csrf),
      ),
    );
    expect(results.every((result) => [204, 401].includes(result.status))).toBe(true);
    expect(await db.session.count({ where: { userId: ids[0], revokedAt: null } })).toBe(0);
    expect(
      await db.identityAuditEvent.count({
        where: { actorUserId: ids[0], action: 'auth.session_revoked', outcome: 'SUCCESS' },
      }),
    ).toBe(1);
  });

  it('persists lockout across a real API process restart and two live API processes', async () => {
    const { ids } = await tenant();
    const email = `${ids[0]}@example.invalid`;
    const processes: ChildProcess[] = [];
    // A real disposable Redis avoids inheriting another developer/test run's
    // IP limiter counters. No limiter is reset, bypassed or disabled.
    const redisContainer = execFileSync(
      'docker',
      ['run', '--rm', '-d', '-p', '127.0.0.1::6379', 'redis:8-alpine'],
      { encoding: 'utf8' },
    ).trim();
    if (!/^[a-f0-9]{64}$/.test(redisContainer))
      throw new Error('Invalid disposable Redis container identifier');
    async function attempt(port: number, candidate: string) {
      const csrf = randomUUID();
      const response = await fetch(`http://127.0.0.1:${port}/auth/sign-in`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          cookie: `tv_csrf=${csrf}`,
          'x-truevine-csrf': csrf,
        },
        body: JSON.stringify({ email, password: candidate }),
      });
      expect(response.status).toBe(401);
      expect(await response.json()).toMatchObject({ error: { code: 'invalid_credentials' } });
    }
    try {
      const published = execFileSync('docker', ['port', redisContainer, '6379/tcp'], {
        encoding: 'utf8',
      }).trim();
      if (!/^127\.0\.0\.1:\d+$/.test(published))
        throw new Error('Redis must be published only on loopback');
      const redisUrl = `redis://${published}`;
      const first = await startIndependentApi(redisUrl);
      processes.push(first.child);
      // Production's configured limit is five; counters must outlive this process.
      for (let i = 0; i < 3; i++) await attempt(first.port, 'wrong-password');
      await stopIndependentApi(first.child);
      const restarted = await startIndependentApi(redisUrl);
      processes.push(restarted.child);
      for (let i = 0; i < 2; i++) await attempt(restarted.port, 'wrong-password');
      const locked = await db.user.findUniqueOrThrow({ where: { id: ids[0] } });
      expect(locked.failedLoginCount).toBe(5);
      expect(locked.lockedUntil).not.toBeNull();
      const parallel = await startIndependentApi(redisUrl);
      processes.push(parallel.child);
      await Promise.all([attempt(restarted.port, password), attempt(parallel.port, password)]);
      expect((await db.user.findUniqueOrThrow({ where: { id: ids[0] } })).lockedUntil).toEqual(
        locked.lockedUntil,
      );
    } finally {
      await Promise.all(processes.map(stopIndependentApi));
      execFileSync('docker', ['rm', '-f', redisContainer], { stdio: 'pipe' });
    }
  }, 60000);

  it('acceptance races revocation without partial membership, and expiry is enforced', async () => {
    for (let round = 0; round < 10; round++) {
      const { organizationId, ids } = await tenant();
      await db.membership.delete({
        where: { organizationId_userId: { organizationId, userId: ids[1]! } },
      });
      const token = await invite(organizationId, ids[0]!, ids[1]!);
      const invitation = await db.invitation.findUniqueOrThrow({
        where: { tokenHash: hashToken(token) },
      });
      const results = await Promise.allSettled([
        services(db).organizations.acceptInvitation(ids[1]!, token),
        services(second).organizations.revokeInvitation(organizationId, ids[0]!, invitation.id),
      ]);
      expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
      const final = await db.invitation.findUniqueOrThrow({
        where: { tokenHash: hashToken(token) },
      });
      expect(await db.membership.count({ where: { organizationId, userId: ids[1] } })).toBe(
        final.acceptedAt ? 1 : 0,
      );
      expect(Boolean(final.acceptedAt)).not.toBe(Boolean(final.revokedAt));
      const expired = await invite(organizationId, ids[0]!, ids[2]!);
      await db.invitation.updateMany({
        where: { organizationId, tokenHash: hashToken(expired) },
        data: { expiresAt: new Date(0) },
      });
      await expect(
        services(db).organizations.acceptInvitation(ids[2]!, expired),
      ).rejects.toMatchObject({ code: 'invalid_or_expired_token' });
    }
  }, 30000);

  it('transfer races with demotion or removal never leave zero or multiple Owners', async () => {
    for (let round = 0; round < 10; round++) {
      const { organizationId, ids } = await tenant();
      const owner = await cookie(ids[0]!);
      const transfer = () =>
        request(server)
          .post(`/organizations/${organizationId}/ownership/transfer`)
          .set('cookie', owner.cookie)
          .set('x-truevine-csrf', owner.csrf)
          .send({ newOwnerId: ids[1] });
      const mutation = () =>
        round % 2
          ? request(server)
              .delete(`/organizations/${organizationId}/members/${ids[1]}`)
              .set('cookie', owner.cookie)
              .set('x-truevine-csrf', owner.csrf)
          : request(server)
              .patch(`/organizations/${organizationId}/members/${ids[1]}`)
              .set('cookie', owner.cookie)
              .set('x-truevine-csrf', owner.csrf)
              .send({ role: 'VIEWER' });
      const results = await Promise.all(
        round % 2 ? [mutation(), transfer()] : [transfer(), mutation()],
      );
      expect(results.every((result) => [200, 204, 403, 404, 409].includes(result.status))).toBe(
        true,
      );
      expect(await db.membership.count({ where: { organizationId, role: 'OWNER' } })).toBe(1);
    }
  }, 30000);

  it('replaying a used reset token cannot revoke a newly issued session', async () => {
    const { ids } = await tenant();
    const token = randomUUID();
    await db.passwordResetToken.create({
      data: {
        userId: ids[0]!,
        tokenHash: hashToken(token),
        expiresAt: new Date(Date.now() + 60000),
      },
    });
    await services(db).auth.completePasswordReset(token, 'new-security-passphrase');
    const fresh = await cookie(ids[0]!);
    await expect(
      services(second).auth.completePasswordReset(token, 'another-security-passphrase'),
    ).rejects.toMatchObject({ code: 'token_already_used' });
    expect((await request(server).get('/me').set('cookie', fresh.cookie)).status).toBe(200);
  });

  it('repeats HTTP invitation races: exactly one success and intended membership', async () => {
    for (let iteration = 0; iteration < 10; iteration++) {
      const { organizationId, ids } = await tenant();
      // The intended recipient starts outside this tenant.
      await db.membership.delete({
        where: { organizationId_userId: { organizationId, userId: ids[1]! } },
      });
      const token = await invite(organizationId, ids[0]!, ids[1]!);
      const intended = await cookie(ids[1]!),
        wrong = await cookie(ids[2]!);
      const denied = await request(server)
        .post('/invitations/accept')
        .set('cookie', wrong.cookie)
        .set('x-truevine-csrf', wrong.csrf)
        .send({ token });
      expect(denied.status).toBe(400);
      const results = await Promise.all(
        Array.from({ length: 8 }, () =>
          request(server)
            .post('/invitations/accept')
            .set('cookie', intended.cookie)
            .set('x-truevine-csrf', intended.csrf)
            .send({ token }),
        ),
      );
      expect(results.filter((r) => r.status === 200)).toHaveLength(1);
      expect(results.filter((r) => r.status === 400)).toHaveLength(7);
      expect(await db.membership.count({ where: { organizationId, userId: ids[1] } })).toBe(1);
      const invitation = await db.invitation.findUniqueOrThrow({
        where: { tokenHash: hashToken(token) },
      });
      expect(invitation.acceptedByUserId).toBe(ids[1]);
      expect(
        await db.securityAuditEvent.count({
          where: { organizationId, action: 'organization.invitation.accepted', outcome: 'SUCCESS' },
        }),
      ).toBe(1);
      expect(
        await db.securityAuditEvent.count({ where: { organizationId, outcome: 'DENIED' } }),
      ).toBe(8);
    }
  }, 30000);

  it('activates a new invited identity, signs in and receives only the invited tenant role', async () => {
    const { organizationId, ids } = await tenant();
    const email = `invite-activation-${randomUUID()}@example.invalid`;
    const token = await inviteEmail(organizationId, ids[0]!, email, 'VIEWER');
    const csrf = randomUUID();
    const activated = await request(server)
      .post('/invitations/activate')
      .set('cookie', `tv_csrf=${csrf}`)
      .set('x-truevine-csrf', csrf)
      .send({ token, password: 'new-invitee-long-passphrase' });
    expect(activated.status).toBe(200);
    expect(activated.body).toEqual({ organizationId });

    const user = await db.user.findUniqueOrThrow({ where: { email } });
    const membership = await db.membership.findUniqueOrThrow({
      where: { organizationId_userId: { organizationId, userId: user.id } },
    });
    expect(membership.role).toBe('VIEWER');
    expect(await db.membership.count({ where: { userId: user.id } })).toBe(1);
    const invitation = await db.invitation.findUniqueOrThrow({
      where: { tokenHash: hashToken(token) },
    });
    expect(invitation.acceptedByUserId).toBe(user.id);

    const signedIn = await request(server)
      .post('/auth/sign-in')
      .set('cookie', `tv_csrf=${csrf}`)
      .set('x-truevine-csrf', csrf)
      .send({ email, password: 'new-invitee-long-passphrase' });
    expect(signedIn.status).toBe(200);
    const sessionCookie = signedIn.headers['set-cookie']
      ?.split(',')
      .find((value: string) => value.trim().startsWith('tv_session='));
    expect(sessionCookie).toBeDefined();
    const me = await request(server).get('/me').set('cookie', sessionCookie!);
    expect(me.status).toBe(200);
    expect(me.body.memberships).toEqual([
      expect.objectContaining({ organizationId, role: 'VIEWER' }),
    ]);
    expect(
      await db.securityAuditEvent.count({
        where: {
          organizationId,
          actorUserId: user.id,
          action: 'organization.invitation.accepted',
          outcome: 'SUCCESS',
        },
      }),
    ).toBe(1);
  }, 30000);

  it('rejects invalid, expired, revoked, duplicate-account and cross-tenant activation attempts', async () => {
    const { organizationId, ids } = await tenant();
    const csrf = randomUUID();
    const activate = (token: string) =>
      request(server)
        .post('/invitations/activate')
        .set('cookie', `tv_csrf=${csrf}`)
        .set('x-truevine-csrf', csrf)
        .send({ token, password: 'new-invitee-long-passphrase' });

    expect(
      (
        await request(server)
          .post('/invitations/activate')
          .send({ token: randomUUID(), password: 'new-invitee-long-passphrase' })
      ).status,
    ).toBe(403);
    expect((await activate(randomUUID())).status).toBe(400);
    const expired = await inviteEmail(
      organizationId,
      ids[0]!,
      `expired-${randomUUID()}@example.invalid`,
    );
    await db.invitation.updateMany({
      where: { tokenHash: hashToken(expired) },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    expect((await activate(expired)).status).toBe(400);
    const revoked = await inviteEmail(
      organizationId,
      ids[0]!,
      `revoked-${randomUUID()}@example.invalid`,
    );
    await db.invitation.updateMany({
      where: { tokenHash: hashToken(revoked) },
      data: { revokedAt: new Date() },
    });
    expect((await activate(revoked)).status).toBe(400);

    const secondTenant = await tenant();
    const existingEmail = `${secondTenant.ids[1]}@example.invalid`;
    const duplicate = await inviteEmail(organizationId, ids[0]!, existingEmail);
    expect((await activate(duplicate)).status).toBe(409);
    expect(
      await db.membership.count({ where: { organizationId, userId: secondTenant.ids[1] } }),
    ).toBe(0);
    expect(
      (await db.invitation.findUniqueOrThrow({ where: { tokenHash: hashToken(duplicate) } }))
        .acceptedAt,
    ).toBeNull();
  }, 30000);

  it('allows exactly one of concurrent account activations to consume a single-use token', async () => {
    const { organizationId, ids } = await tenant();
    const email = `concurrent-activation-${randomUUID()}@example.invalid`;
    const token = await inviteEmail(organizationId, ids[0]!, email, 'CAMPAIGN_MANAGER');
    const csrf = randomUUID();
    const activate = () =>
      request(server)
        .post('/invitations/activate')
        .set('cookie', `tv_csrf=${csrf}`)
        .set('x-truevine-csrf', csrf)
        .send({ token, password: 'new-invitee-long-passphrase' });
    const results = await Promise.all(Array.from({ length: 8 }, activate));
    expect(results.filter((response) => response.status === 200)).toHaveLength(1);
    expect(results.filter((response) => response.status === 400)).toHaveLength(7);
    const user = await db.user.findUniqueOrThrow({ where: { email } });
    expect(await db.membership.count({ where: { userId: user.id, organizationId } })).toBe(1);
    expect(await db.membership.count({ where: { userId: user.id } })).toBe(1);
  }, 30000);

  it('serializes separate tenant invitations for the same globally unique email', async () => {
    const first = await tenant();
    const secondTenant = await tenant();
    const email = `cross-tenant-activation-${randomUUID()}@example.invalid`;
    const [firstToken, secondToken] = await Promise.all([
      inviteEmail(first.organizationId, first.ids[0]!, email),
      inviteEmail(secondTenant.organizationId, secondTenant.ids[0]!, email),
    ]);
    const csrf = randomUUID();
    const activate = (token: string) =>
      request(server)
        .post('/invitations/activate')
        .set('cookie', `tv_csrf=${csrf}`)
        .set('x-truevine-csrf', csrf)
        .send({ token, password: 'new-invitee-long-passphrase' });
    const results = await Promise.all([activate(firstToken), activate(secondToken)]);
    expect(results.map((response) => response.status).sort()).toEqual([200, 409]);

    const user = await db.user.findUniqueOrThrow({ where: { email } });
    expect(await db.membership.count({ where: { userId: user.id } })).toBe(1);
    const invitations = await db.invitation.findMany({ where: { email } });
    expect(invitations.filter((invitation) => invitation.acceptedAt !== null)).toHaveLength(1);
  }, 30000);

  it('repeats concurrent HTTP transfers: one winner, one Owner, one success audit', async () => {
    for (let iteration = 0; iteration < 10; iteration++) {
      const { organizationId, ids } = await tenant();
      const owner = await cookie(ids[0]!);
      const results = await Promise.all(
        ids
          .slice(1)
          .map((newOwnerId) =>
            request(server)
              .post(`/organizations/${organizationId}/ownership/transfer`)
              .set('cookie', owner.cookie)
              .set('x-truevine-csrf', owner.csrf)
              .send({ newOwnerId }),
          ),
      );
      expect(results.filter((r) => r.status === 200)).toHaveLength(1);
      expect(results.filter((r) => r.status === 403 || r.status === 404)).toHaveLength(1);
      expect(await db.membership.count({ where: { organizationId, role: 'OWNER' } })).toBe(1);
      expect(
        await db.securityAuditEvent.count({
          where: {
            organizationId,
            action: 'organization.ownership.transferred',
            outcome: 'SUCCESS',
          },
        }),
      ).toBe(1);
    }
  }, 30000);

  it('the database rejects two Owners, zero Owners, OWNER invitations and wrong invitation identity', async () => {
    const { organizationId, ids } = await tenant();
    const foreign = await tenant();
    await expect(
      db.invitation.create({
        data: {
          organizationId,
          email: `${ids[1]}@example.invalid`,
          role: 'VIEWER',
          tokenHash: hashToken(randomUUID()),
          invitedByUserId: foreign.ids[0]!,
          expiresAt: new Date(Date.now() + 60000),
        },
      }),
    ).rejects.toThrow(/author must belong/);
    await expect(
      db.membership.update({
        where: { organizationId_userId: { organizationId, userId: ids[1]! } },
        data: { role: 'OWNER' },
      }),
    ).rejects.toThrow();
    await expect(
      db.membership.delete({
        where: { organizationId_userId: { organizationId, userId: ids[0]! } },
      }),
    ).rejects.toThrow(/exactly one OWNER/i);
    await expect(
      db.invitation.create({
        data: {
          organizationId,
          email: `${ids[1]}@example.invalid`,
          role: 'OWNER',
          tokenHash: hashToken(randomUUID()),
          invitedByUserId: ids[0]!,
          expiresAt: new Date(Date.now() + 60000),
        },
      }),
    ).rejects.toThrow();
    const token = await invite(organizationId, ids[0]!, ids[1]!);
    await expect(
      db.invitation.updateMany({
        where: { organizationId, tokenHash: hashToken(token) },
        data: { acceptedAt: new Date(), acceptedByUserId: ids[2] },
      }),
    ).rejects.toThrow(/intended active email identity/);
  });

  it('reset is single-use across instances and revokes all old sessions', async () => {
    const { ids } = await tenant();
    const token = randomUUID();
    const session = await cookie(ids[0]!);
    await db.passwordResetToken.create({
      data: {
        userId: ids[0]!,
        tokenHash: hashToken(token),
        expiresAt: new Date(Date.now() + 60000),
      },
    });
    const results = await Promise.allSettled([
      services(db).auth.completePasswordReset(token, 'new-security-passphrase'),
      services(second).auth.completePasswordReset(token, 'new-security-passphrase'),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1);
    expect(await db.session.count({ where: { userId: ids[0], revokedAt: null } })).toBe(0);
    expect((await request(server).get('/me').set('cookie', session.cookie)).status).toBe(401);
    expect(
      await db.identityAuditEvent.count({
        where: { actorUserId: ids[0], action: 'auth.password_reset_completed' },
      }),
    ).toBe(1);
  });

  it('real DB audit failure rolls back password, token consumption and revocation', async () => {
    const { ids } = await tenant();
    const token = randomUUID();
    await cookie(ids[0]!);
    await db.passwordResetToken.create({
      data: {
        userId: ids[0]!,
        tokenHash: hashToken(token),
        expiresAt: new Date(Date.now() + 60000),
      },
    });
    await rejectAudit(ids[0]!, 'identity_audit_events', async () => {
      await expect(
        services(db).auth.completePasswordReset(token, 'new-security-passphrase'),
      ).rejects.toThrow(/injected audit storage failure/);
    });
    expect((await db.user.findUniqueOrThrow({ where: { id: ids[0] } })).passwordHash).toBe(hash);
    expect(
      (await db.passwordResetToken.findUniqueOrThrow({ where: { tokenHash: hashToken(token) } }))
        .usedAt,
    ).toBeNull();
    expect(await db.session.count({ where: { userId: ids[0], revokedAt: null } })).toBe(1);
    await services(db).auth.completePasswordReset(token, 'new-security-passphrase');
  });

  it('real DB audit failure rolls back transfer, profile and invitation acceptance', async () => {
    const { organizationId, ids } = await tenant();
    const token = await invite(organizationId, ids[0]!, ids[1]!);
    await db.membership.delete({
      where: { organizationId_userId: { organizationId, userId: ids[1]! } },
    });
    await rejectAudit(ids[0]!, 'security_audit_events', async () => {
      await expect(
        services(db).organizations.updateProfile(organizationId, ids[0]!, 'Uncommitted'),
      ).rejects.toThrow(/injected audit/);
      await expect(
        services(db).organizations.transferOwnership(organizationId, ids[0]!, ids[2]!),
      ).rejects.toThrow(/injected audit/);
    });
    await rejectAudit(ids[1]!, 'security_audit_events', async () => {
      await expect(services(db).organizations.acceptInvitation(ids[1]!, token)).rejects.toThrow(
        /injected audit/,
      );
    });
    expect((await db.organization.findUniqueOrThrow({ where: { id: organizationId } })).name).toBe(
      'Security fixture',
    );
    expect(
      (
        await db.membership.findUniqueOrThrow({
          where: { organizationId_userId: { organizationId, userId: ids[0]! } },
        })
      ).role,
    ).toBe('OWNER');
    expect(await db.membership.count({ where: { organizationId, userId: ids[1] } })).toBe(0);
    expect(
      (await db.invitation.findUniqueOrThrow({ where: { tokenHash: hashToken(token) } }))
        .acceptedAt,
    ).toBeNull();
    expect(
      await db.securityAuditEvent.count({ where: { organizationId, outcome: 'SUCCESS' } }),
    ).toBe(0);
  });

  it('login failures and bounded lockout persist across independent instances', async () => {
    const { ids } = await tenant();
    const email = `${ids[0]}@example.invalid`;
    const one = services(db).auth,
      two = services(second).auth;
    await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        (i % 2 ? one : two).signIn(email, 'wrong-password', context).catch((error) => {
          expect(error).toMatchObject({ code: 'invalid_credentials', status: 401 });
        }),
      ),
    );
    const locked = await db.user.findUniqueOrThrow({ where: { id: ids[0] } });
    expect(locked.failedLoginCount).toBe(5);
    expect(locked.lockedUntil!.getTime()).toBeGreaterThan(Date.now());
    await expect(services(second).auth.signIn(email, password, context)).rejects.toMatchObject({
      code: 'invalid_credentials',
      status: 401,
    });
    expect((await db.user.findUniqueOrThrow({ where: { id: ids[0] } })).lockedUntil).toEqual(
      locked.lockedUntil,
    );
    await expect(
      one.signIn('not-registered@example.invalid', password, context),
    ).rejects.toMatchObject({ code: 'invalid_credentials', status: 401 });
    await db.user.update({
      where: { id: ids[0] },
      data: { lockedUntil: new Date(Date.now() - 1) },
    });
    await expect(two.signIn(email, password, context)).resolves.toHaveProperty('sessionToken');
    expect((await db.user.findUniqueOrThrow({ where: { id: ids[0] } })).failedLoginCount).toBe(0);
  });

  it('HTTP terms gate protects customer routes but permits terms, recovery and sign-out', async () => {
    const { organizationId, ids } = await tenant(false);
    const owner = await cookie(ids[0]!);
    await db.termsAcceptance.create({
      data: { userId: ids[0]!, termsVersion: 'obsolete-version' },
    });
    for (const [method, path, body] of [
      ['patch', `/organizations/${organizationId}`, { name: 'Must not change' }],
      [
        'post',
        `/organizations/${organizationId}/invitations`,
        { email: 'test@example.invalid', role: 'VIEWER' },
      ],
      ['post', `/organizations/${organizationId}/ownership/transfer`, { newOwnerId: ids[1] }],
      ['patch', `/organizations/${organizationId}/members/${ids[1]}`, { role: 'ADMIN' }],
      ['delete', `/organizations/${organizationId}/members/${ids[1]}`, {}],
      ['delete', `/organizations/${organizationId}/invitations/${randomUUID()}`, {}],
      ['post', '/invitations/accept', { token: 'not-a-token' }],
    ] as const) {
      const agent = request(server);
      const result = await agent[method](path)
        .set('cookie', owner.cookie)
        .set('x-truevine-csrf', owner.csrf)
        .send(body);
      expect(result.status).toBe(403);
      expect(result.body.error.code).toBe('terms_acceptance_required');
    }
    expect(
      (
        await request(server)
          .post('/auth/password-reset/request')
          .set('cookie', owner.cookie)
          .set('x-truevine-csrf', owner.csrf)
          .send({ email: 'unknown@example.invalid' })
      ).status,
    ).toBe(202);
    expect(
      (
        await request(server)
          .post('/auth/password-reset/complete')
          .set('cookie', owner.cookie)
          .set('x-truevine-csrf', owner.csrf)
          .send({ token: 'unknown', newPassword: password })
      ).status,
    ).toBe(400);
    expect(
      (
        await request(server)
          .post('/auth/sign-in')
          .set('cookie', owner.cookie)
          .set('x-truevine-csrf', owner.csrf)
          .send({ email: `${ids[0]}@example.invalid`, password })
      ).status,
    ).toBe(200);
    for (const path of [
      `/organizations/${organizationId}`,
      `/organizations/${organizationId}/members`,
      `/organizations/${organizationId}/invitations`,
    ]) {
      const result = await request(server).get(path).set('cookie', owner.cookie);
      expect(result.status).toBe(403);
      expect(result.body.error.code).toBe('terms_acceptance_required');
    }
    expect((await request(server).get('/me').set('cookie', owner.cookie)).status).toBe(200);
    expect((await request(server).get('/auth/terms')).status).toBe(200);
    expect(
      (
        await request(server)
          .post('/auth/terms/accept')
          .set('cookie', owner.cookie)
          .set('x-truevine-csrf', owner.csrf)
      ).status,
    ).toBe(204);
    expect(
      (await request(server).get(`/organizations/${organizationId}`).set('cookie', owner.cookie))
        .status,
    ).toBe(200);
    const other = await tenant();
    expect(
      (
        await request(server)
          .get(`/organizations/${other.organizationId}`)
          .set('cookie', owner.cookie)
      ).status,
    ).toBe(403);
    expect(
      (
        await request(server)
          .post('/auth/sign-out')
          .set('cookie', owner.cookie)
          .set('x-truevine-csrf', owner.csrf)
      ).status,
    ).toBe(204);
    expect(
      await db.identityAuditEvent.count({
        where: { actorUserId: ids[0], action: 'auth.session_revoked', outcome: 'SUCCESS' },
      }),
    ).toBe(1);
  });
});
