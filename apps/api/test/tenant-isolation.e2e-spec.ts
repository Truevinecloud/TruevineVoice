import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { hashToken } from '@truevine/auth';
import { createDatabaseClient, type PrismaClient } from '@truevine/database';
import { loadEnvFiles, requireEnv } from '@truevine/shared';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { APP_CONFIG } from '../src/config/app-config.module.js';
import { RATE_LIMITER, TERMS_VERSION } from '../src/auth/tokens.js';
import { DATABASE_CLIENT, REDIS_CLIENT } from '../src/tokens.js';
import { CallPersistence } from '../src/calls/call-persistence.js';
import { PrismaCampaignStore } from '../src/campaigns/prisma-campaign.store.js';
import { PrismaBillingStore } from '../src/billing/prisma-billing.store.js';
import {
  assertConnectedToDisposableDatabase,
  assertDisposableDatabase,
} from './disposable-database.js';

describe('RBAC-012 cross-tenant release blocker', () => {
  let db: PrismaClient;
  let app: INestApplication;
  let calls: CallPersistence;
  const a = randomUUID(),
    b = randomUUID(),
    ua = randomUUID(),
    ub = randomUUID();
  const multi = randomUUID(),
    outsider = randomUUID(),
    platform = randomUUID();
  const ca = randomUUID(),
    cb = randomUUID(),
    entryA = randomUUID(),
    entryB = randomUUID();
  const invitationB = randomUUID();
  const tokens = new Map<string, string>();
  const csrf = 'tenant-isolation-synthetic-csrf';
  type Method = 'get' | 'post' | 'patch' | 'delete';
  function http(user: string | null, method: Method, path: string, body?: unknown) {
    const req = request(app.getHttpServer())[method](path);
    if (user)
      req
        .set('cookie', `tv_session=${tokens.get(user)}; tv_csrf=${csrf}`)
        .set('x-truevine-csrf', csrf);
    return body === undefined ? req : req.send(body as object);
  }
  const root = (org: string) => '/organizations/' + org;
  const profile = {
    name: 'Synthetic billing',
    email: 'synthetic@example.invalid',
    address: 'Synthetic address',
  };

  beforeAll(async () => {
    loadEnvFiles();
    const url = requireEnv('DATABASE_URL');
    const expected = assertDisposableDatabase(url, process.env['NODE_ENV']);
    if (process.env['CI'] !== 'true' && process.env['TENANT_ISOLATION_DISPOSABLE'] !== '1')
      throw new Error(
        'Set TENANT_ISOLATION_DISPOSABLE=1 only for disposable local infrastructure.',
      );
    db = createDatabaseClient(url, { log: [] });
    await assertConnectedToDisposableDatabase(
      async () =>
        (await db.$queryRaw<{ name: string }[]>`SELECT current_database() AS name`)[0]?.name,
      expected,
    );
    await db.$transaction(async (tx) => {
      for (const id of [ua, ub, multi, outsider, platform])
        await tx.user.create({
          data: { id, email: id + '@example.invalid', passwordHash: 'unusable-synthetic' },
        });
      await tx.organization.createMany({
        data: [
          { id: a, slug: a, name: 'Private tenant A' },
          { id: b, slug: b, name: 'Private tenant B' },
        ],
      });
      await tx.membership.createMany({
        data: [
          { organizationId: a, userId: ua, role: 'OWNER' },
          { organizationId: b, userId: ub, role: 'OWNER' },
          { organizationId: a, userId: multi, role: 'ADMIN' },
          { organizationId: b, userId: multi, role: 'VIEWER' },
        ],
      });
      await tx.platformRoleAssignment.create({
        data: { userId: platform, role: 'PLATFORM_OWNER' },
      });
      await tx.campaign.createMany({
        data: [
          { organizationId: a, id: ca, name: 'Private campaign A', createdById: ua },
          { organizationId: b, id: cb, name: 'Private campaign B', createdById: ub },
        ],
      });
      await tx.walletEntry.createMany({
        data: [
          {
            organizationId: a,
            id: entryA,
            amountMinor: 10n,
            currency: 'UGX',
            reference: 'A',
            description: 'Private A',
          },
          {
            organizationId: b,
            id: entryB,
            amountMinor: 20n,
            currency: 'UGX',
            reference: 'B',
            description: 'Private B',
          },
        ],
      });
      await tx.billingProfile.createMany({
        data: [
          { organizationId: a, ...profile },
          { organizationId: b, ...profile },
        ],
      });
      await tx.invitation.create({
        data: {
          organizationId: b,
          id: invitationB,
          email: 'invite@example.invalid',
          role: 'VIEWER',
          tokenHash: hashToken(randomUUID()),
          invitedByUserId: ub,
          expiresAt: new Date(Date.now() + 60000),
        },
      });
    });
    const module = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(APP_CONFIG)
      .useValue({
        host: '127.0.0.1',
        port: 0,
        environment: 'test',
        version: 'rbac012',
        databaseUrl: url,
        redisUrl: 'redis://127.0.0.1:56379',
        healthTimeoutMs: 50,
        serviceName: 'truevine-voice-api',
      })
      .overrideProvider(DATABASE_CLIENT)
      .useValue(db)
      .overrideProvider(REDIS_CLIENT)
      .useValue({ ping: async () => 'PONG', disconnect: () => undefined })
      .overrideProvider(RATE_LIMITER)
      .useValue({ consume: async () => ({ allowed: true, retryAfterMs: 0, remaining: 10000 }) })
      .compile();
    const terms = module.get<string>(TERMS_VERSION);
    for (const userId of [ua, ub, multi, outsider, platform]) {
      const token = randomUUID();
      tokens.set(userId, token);
      await db.session.create({
        data: { userId, tokenHash: hashToken(token), expiresAt: new Date(Date.now() + 3600000) },
      });
      await db.termsAcceptance.create({ data: { userId, termsVersion: terms } });
    }
    app = module.createNestApplication();
    await app.init();
    calls = new CallPersistence(db);
  });
  afterAll(async () => {
    await app?.close();
    await db?.$disconnect();
  });

  /** Business snapshots exclude session touches and intentional append-only denial audits. */
  async function snapshot(org: string) {
    const where = { organizationId: org };
    const rows = await Promise.all([
      db.organization.findUnique({ where: { id: org } }),
      db.membership.findMany({ where, orderBy: { userId: 'asc' } }),
      db.invitation.findMany({ where, orderBy: { id: 'asc' } }),
      db.campaign.findMany({ where, orderBy: { id: 'asc' } }),
      db.billingProfile.findUnique({ where: { organizationId: org } }),
      db.walletEntry.findMany({ where, orderBy: { id: 'asc' } }),
      db.topUpRequest.findMany({ where, orderBy: { id: 'asc' } }),
      db.contact.findMany({ where, orderBy: { id: 'asc' } }),
      db.campaignRecipient.findMany({ where, orderBy: { id: 'asc' } }),
      db.campaignExecution.findMany({ where, orderBy: { id: 'asc' } }),
      db.callAttempt.findMany({ where, orderBy: { id: 'asc' } }),
      db.callOperation.findMany({ where, orderBy: { key: 'asc' } }),
      db.callEvent.findMany({ where, orderBy: { id: 'asc' } }),
    ]);
    return JSON.stringify(rows, (_key, value: unknown) =>
      typeof value === 'bigint' ? value.toString() : value,
    );
  }
  const probes: [Method, string, unknown?][] = [
    ['get', ''],
    ['patch', '', { name: 'Attack' }],
    ['get', '/members'],
    ['patch', '/members/' + ub, { role: 'ADMIN' }],
    ['delete', '/members/' + ub],
    ['get', '/invitations'],
    ['post', '/invitations', { email: 'attack@example.invalid', role: 'VIEWER' }],
    ['delete', '/invitations/' + invitationB],
    ['post', '/ownership/transfer', { newOwnerId: ua }],
    ['get', '/campaigns'],
    ['post', '/campaigns', { name: 'Attack' }],
    ['get', '/campaigns/' + cb],
    ['patch', '/campaigns/' + cb, { name: 'Attack' }],
    ['delete', '/campaigns/' + cb],
    ['get', '/reports/campaign-status'],
    ['get', '/wallet'],
    ['get', '/wallet/transactions?cursor=' + entryB],
    ['get', '/billing'],
    ['patch', '/billing', profile],
    [
      'post',
      '/wallet/top-ups',
      { currency: 'UGX', amountMinor: '1', idempotencyKey: randomUUID() },
    ],
  ];
  it.each(probes)(
    'denies foreign organization %s %s without business mutation or disclosure',
    async (method, path, body) => {
      const before = await snapshot(b);
      const response = await http(ua, method, root(b) + path, body);
      expect(response.status).toBe(403);
      expect(response.body).toEqual({
        error: {
          code: 'permission_denied',
          message: 'You do not have permission to perform this action.',
        },
      });
      expect(await snapshot(b)).toBe(before);
    },
  );
  it('refuses unauthenticated and nonmember callers, and conceals tenant existence', async () => {
    for (const actor of [null, outsider, ua]) {
      const real = await http(actor, 'get', root(b));
      const absent = await http(actor, 'get', root(randomUUID()));
      expect(real.status).toBe(actor === null ? 401 : 403);
      expect(absent.status).toBe(real.status);
      expect(absent.body).toEqual(real.body);
    }
    expect((await http(ub, 'get', root(a))).status).toBe(403);
  });
  it('keeps multi-organization roles independent and grants no implicit platform bypass', async () => {
    for (const org of [a, b])
      expect((await http(multi, 'get', root(org) + '/campaigns')).status).toBe(200);
    expect((await http(multi, 'post', root(a) + '/campaigns', { name: 'Allowed A' })).status).toBe(
      201,
    );
    const before = await snapshot(b);
    expect((await http(multi, 'post', root(b) + '/campaigns', { name: 'Denied B' })).status).toBe(
      403,
    );
    expect((await http(platform, 'get', root(b) + '/campaigns')).status).toBe(403);
    expect(await snapshot(b)).toBe(before);
    const me = await http(ua, 'get', '/me');
    expect(me.body.memberships.map((m: { organizationId: string }) => m.organizationId)).toEqual([
      a,
    ]);
  });
  it('conceals guessed resource IDs for reads, writes, nested membership and pagination', async () => {
    const before = await snapshot(b);
    for (const id of [cb, randomUUID()]) {
      for (const method of ['get', 'patch', 'delete'] as const)
        expect(
          (await http(ua, method, root(a) + '/campaigns/' + id, { name: 'Attack' })).status,
        ).toBe(404);
    }
    expect((await http(ua, 'patch', root(a) + '/members/' + ub, { role: 'VIEWER' })).status).toBe(
      404,
    );
    expect((await http(ua, 'delete', root(a) + '/invitations/' + invitationB)).status).toBe(404);
    const foreign = await http(ua, 'get', root(a) + '/wallet/transactions?cursor=' + entryB);
    const absent = await http(ua, 'get', root(a) + '/wallet/transactions?cursor=' + randomUUID());
    expect(foreign.status).toBe(404);
    expect(foreign.body).toEqual(absent.body);
    expect(await snapshot(b)).toBe(before);
  });
  it('cannot broaden scope with forged body/query identifiers, search, arrays or bulk targets', async () => {
    const before = await snapshot(b);
    const list = await http(
      ua,
      'get',
      root(a) + '/campaigns?organizationId=' + b + '&org_id=' + b + '&search=Private&limit=10000',
    );
    expect(list.status).toBe(200);
    expect(JSON.stringify(list.body)).not.toContain('Private campaign B');
    const result = await http(ua, 'post', root(a) + '/campaigns', {
      organizationId: b,
      org_id: b,
      name: 'Scoped A',
      createdById: ub,
    });
    expect(result.status).toBe(201);
    expect(
      await db.campaign.count({
        where: { organizationId: a, id: result.body.id, createdById: ua },
      }),
    ).toBe(1);
    expect(
      (await http(ua, 'patch', root(a) + '/billing', { ...profile, organizationId: b, org_id: b }))
        .status,
    ).toBe(200);
    expect(
      (await http(ua, 'post', root(a) + '/campaigns', [{ name: 'Bulk', organizationId: b }]))
        .status,
    ).toBe(400);
    expect(
      (await http(ua, 'post', root(a) + '/campaigns/bulk', { ids: [ca, cb], organizationId: b }))
        .status,
    ).toBe(404);
    expect(await snapshot(b)).toBe(before);
  });
  it('scopes concurrent top-up idempotency collisions per tenant, including replay and mismatch', async () => {
    const key = randomUUID(),
      payload = { currency: 'UGX', amountMinor: '123', idempotencyKey: key };
    const responses = await Promise.all(
      [ua, ua, ub, ub].map((actor) =>
        http(actor, 'post', root(actor === ua ? a : b) + '/wallet/top-ups', payload),
      ),
    );
    expect(responses.map((r) => r.status)).toEqual([202, 202, 202, 202]);
    expect(responses[0]!.body.id).toBe(responses[1]!.body.id);
    expect(responses[2]!.body.id).toBe(responses[3]!.body.id);
    expect(responses[0]!.body.id).not.toBe(responses[2]!.body.id);
    const before = await snapshot(b);
    expect(
      (await http(ua, 'post', root(a) + '/wallet/top-ups', { ...payload, amountMinor: '124' }))
        .status,
    ).toBe(409);
    expect(await snapshot(b)).toBe(before);
  });
  async function recipient(org: string, campaign: string) {
    const contact = await calls.createContact(org, '+256700000001', 'Synthetic');
    return { contact, recipient: await calls.addRecipient(org, campaign, contact.id) };
  }
  it('enforces contact/recipient/call/event/redial scope and immutable nested relations', async () => {
    const fa = await recipient(a, ca),
      fb = await recipient(b, cb);
    const idempotencyKey = randomUUID();
    const [aa, ab] = await Promise.all([
      calls.accept({
        organizationId: a,
        campaignId: ca,
        recipientId: fa.recipient.id,
        idempotencyKey,
      }),
      calls.accept({
        organizationId: b,
        campaignId: cb,
        recipientId: fb.recipient.id,
        idempotencyKey,
      }),
    ]);
    expect(aa.attemptId).not.toBe(ab.attemptId);
    const before = await snapshot(b);
    await expect(calls.updateContact(a, fb.contact.id, '+256700000002')).rejects.toMatchObject({
      code: 'not_found',
    });
    await expect(calls.addRecipient(a, ca, fb.contact.id)).rejects.toMatchObject({
      code: 'not_found',
    });
    await expect(
      calls.accept({
        organizationId: a,
        campaignId: cb,
        recipientId: fb.recipient.id,
        idempotencyKey: randomUUID(),
      }),
    ).rejects.toMatchObject({ code: 'not_found' });
    await expect(
      calls.accept({
        organizationId: a,
        campaignId: ca,
        recipientId: fa.recipient.id,
        previousAttemptId: ab.attemptId,
        redialReason: 'test',
        idempotencyKey: randomUUID(),
      }),
    ).rejects.toMatchObject({ code: 'invalid_redial' });
    await expect(
      calls.recordEvent({
        organizationId: a,
        attemptId: ab.attemptId,
        eventKey: 'forged',
        state: 'FAILED',
        occurredAt: new Date(),
      }),
    ).rejects.toMatchObject({ code: 'not_found' });
    await expect(
      db.campaignRecipient.create({
        data: {
          organizationId: a,
          campaignId: ca,
          contactId: fb.contact.id,
          destination: fb.contact.destination,
        },
      }),
    ).rejects.toThrow();
    const nested = await db.campaign.findUnique({
      where: { organizationId_id: { organizationId: a, id: ca } },
      include: {
        recipients: { include: { contact: true } },
        executions: { include: { attempts: true } },
      },
    });
    expect(
      nested?.recipients.every((r) => r.organizationId === a && r.contact.organizationId === a),
    ).toBe(true);
    expect(
      nested?.executions.every(
        (e) => e.organizationId === a && e.attempts.every((x) => x.organizationId === a),
      ),
    ).toBe(true);
    await calls.updateContact(a, fa.contact.id, '+256700000003');
    expect(
      (
        await db.callAttempt.findUnique({
          where: { organizationId_id: { organizationId: a, id: aa.attemptId } },
        })
      )?.destination,
    ).toBe('+256700000001');
    expect(await snapshot(b)).toBe(before);
  });
  it('rejects revoked actors at persistence boundaries, including no-op replay', async () => {
    const campaign = new PrismaCampaignStore(db),
      billing = new PrismaBillingStore(db);
    const before = await snapshot(b);
    await expect(
      campaign.createCampaign({
        organizationId: b,
        id: randomUUID(),
        createdById: ua,
        name: 'Attack',
        status: 'DRAFT',
      }),
    ).rejects.toMatchObject({ status: 403 });
    await expect(campaign.updateCampaign(b, cb, { name: 'Attack' }, ua)).rejects.toMatchObject({
      status: 403,
    });
    await expect(campaign.deleteCampaign(b, cb, ua)).rejects.toMatchObject({ status: 403 });
    await expect(billing.saveProfile(b, profile, ua)).rejects.toMatchObject({ status: 403 });
    await expect(
      billing.requestTopUp({
        organizationId: b,
        createdById: ua,
        amountMinor: 1n,
        idempotencyKey: randomUUID(),
      }),
    ).rejects.toMatchObject({ status: 403 });
    expect(await snapshot(b)).toBe(before);
  });
  it('serializes revocation before a waiting campaign mutation, with no partial write', async () => {
    const actor = randomUUID();
    await db.user.create({
      data: { id: actor, email: actor + '@example.invalid', passwordHash: 'unusable' },
    });
    await db.membership.create({
      data: { organizationId: a, userId: actor, role: 'CAMPAIGN_MANAGER' },
    });
    let unlock!: () => void, locked!: () => void;
    const ready = new Promise<void>((resolve) => {
      locked = resolve;
    });
    const release = new Promise<void>((resolve) => {
      unlock = resolve;
    });
    const revoke = db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM organizations WHERE id=${a}::uuid FOR UPDATE`;
      await tx.membership.delete({
        where: { organizationId_userId: { organizationId: a, userId: actor } },
      });
      locked();
      await release;
    });
    await ready;
    const before = await snapshot(a);
    const operation = new PrismaCampaignStore(db).updateCampaign(
      a,
      ca,
      { name: 'Unauthorized after revoke' },
      actor,
    );
    // Attach rejection handler before releasing the competing transaction.
    const outcome = operation.then(
      () => ({ status: 0 }),
      (error: unknown) => error,
    );
    unlock();
    await revoke;
    expect(await outcome).toMatchObject({ status: 403 });
    const after = JSON.parse(await snapshot(a)) as unknown[];
    const prior = JSON.parse(before) as unknown[];
    // Revocation itself is expected; every other business record stays identical.
    after[1] = prior[1];
    expect(after).toEqual(prior);
  });
  it('preserves explicit platform-owner access while refusing tenant roles on platform search/audit', async () => {
    for (const path of [
      '/platform/operations/organizations',
      '/platform/operations/campaigns',
      '/platform/support/organizations?query=' + b,
      '/platform/support/organizations/' + b,
      '/platform/support/organizations/' + b + '/diagnostics',
      '/platform/audit/organizations',
      '/platform/technical/audit',
    ]) {
      expect((await http(ua, 'get', path)).status, path).toBe(403);
      expect((await http(platform, 'get', path)).status, path).toBe(200);
    }
    const response = await http(platform, 'get', '/platform/support/organizations/' + b);
    expect(JSON.stringify(response.body)).toContain(b);
  });
  it('preserves a second membership and session when the first organization removes access', async () => {
    const before = await snapshot(b);
    expect((await http(ua, 'delete', root(a) + '/members/' + multi)).status).toBe(204);
    expect((await http(multi, 'get', root(a) + '/campaigns')).status).toBe(403);
    expect((await http(multi, 'get', root(b) + '/campaigns')).status).toBe(200);
    expect(await snapshot(b)).toBe(before);
  });
  it('denies durable top-up replay after a role downgrade and keeps the accepted record intact', async () => {
    const actor = randomUUID(),
      key = randomUUID();
    await db.user.create({
      data: { id: actor, email: actor + '@example.invalid', passwordHash: 'unusable' },
    });
    await db.membership.create({ data: { organizationId: a, userId: actor, role: 'BILLING' } });
    const billing = new PrismaBillingStore(db);
    const input = { organizationId: a, createdById: actor, amountMinor: 77n, idempotencyKey: key };
    const accepted = await billing.requestTopUp(input);
    await db.membership.update({
      where: { organizationId_userId: { organizationId: a, userId: actor } },
      data: { role: 'VIEWER' },
    });
    const before = await snapshot(a);
    await expect(billing.requestTopUp(input)).rejects.toMatchObject({ status: 403 });
    expect(await snapshot(a)).toBe(before);
    expect(await db.topUpRequest.count({ where: { organizationId: a, id: accepted.id } })).toBe(1);
  });
  it('permits an explicit platform emergency stop but rejects mismatched tenant/resource pairs', async () => {
    const id = randomUUID();
    await db.campaign.create({
      data: { organizationId: b, id, name: 'Synthetic active', status: 'ACTIVE', createdById: ub },
    });
    const path = '/platform/operations/organizations/';
    const body = { reasonCode: 'abuse_suspected' };
    const before = await snapshot(b);
    expect(
      (await http(ua, 'post', path + b + '/campaigns/' + id + '/emergency-stop', body)).status,
    ).toBe(403);
    expect(
      (await http(platform, 'post', path + a + '/campaigns/' + id + '/emergency-stop', body))
        .status,
    ).toBe(404);
    expect(await snapshot(b)).toBe(before);
    expect(
      (await http(platform, 'post', path + b + '/campaigns/' + id + '/emergency-stop', body))
        .status,
    ).toBe(200);
    expect(
      (await db.campaign.findUnique({ where: { organizationId_id: { organizationId: b, id } } }))
        ?.emergencyStoppedAt,
    ).not.toBeNull();
  });
  it('rejects forged worker/webhook payloads because execution ingress is absent', async () => {
    const before = await snapshot(b);
    for (const path of [
      '/webhooks/voice',
      '/webhooks/africastalking',
      '/calls',
      '/jobs/calls',
      '/organizations/' + b + '/calls',
    ])
      expect(
        (
          await http(null, 'post', path, {
            organizationId: b,
            attemptId: randomUUID(),
            state: 'COMPLETED',
          })
        ).status,
      ).toBe(404);
    expect(await snapshot(b)).toBe(before);
  });
});
