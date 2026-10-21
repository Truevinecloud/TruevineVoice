import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { hashToken } from '@truevine/auth';
import { hashPassword } from '@truevine/auth/passwords';
import { createDatabaseClient, type PrismaClient } from '@truevine/database';
import { NullEmailSender } from '@truevine/messaging';
import { loadEnvFiles, requireEnv } from '@truevine/shared';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { APP_CONFIG } from '../src/config/app-config.module.js';
import { DATABASE_CLIENT, REDIS_CLIENT } from '../src/tokens.js';
import { RATE_LIMITER, TERMS_VERSION } from '../src/auth/tokens.js';
import {
  PrismaAuthStore,
  PrismaAuditStore,
  PrismaOrganizationStore,
  PrismaSecurityTransaction,
  PrismaProvisioningStore,
} from '../src/auth/prisma-stores.js';
import { OrganizationsService } from '../src/organizations/organizations.service.js';
import { AuthService } from '../src/auth/auth.service.js';
import { PrismaCampaignStore } from '../src/campaigns/prisma-campaign.store.js';
import { PrismaBillingStore } from '../src/billing/prisma-billing.store.js';
import { PrismaOperationsStore } from '../src/operations/prisma-operations.store.js';
import { withAuditRequest } from '../src/auth/audit-context.js';
import {
  assertDisposableDatabase,
  assertConnectedToDisposableDatabase,
} from './disposable-database.js';

describe('RBAC-013 sensitive action audit on disposable PostgreSQL', () => {
  let db: PrismaClient, app: INestApplication, secretHash: string, terms: string;
  const run = randomUUID().replaceAll('-', '');
  const functionName = 'audit_failure_' + run,
    triggerName = 'audit_failure_' + run;
  const ownedTriggerTables: string[] = [];
  let ownedFunction = false;
  const allow = { consume: async () => ({ allowed: true, retryAfterMs: 0, remaining: 10000 }) };
  const password = 'synthetic-audit-test-passphrase';
  const csrf = 'synthetic-audit-csrf';

  beforeAll(async () => {
    loadEnvFiles();
    const url = requireEnv('DATABASE_URL');
    const expected = assertDisposableDatabase(url, process.env['NODE_ENV']);
    if (process.env['CI'] !== 'true' && process.env['SENSITIVE_AUDIT_DISPOSABLE'] !== '1')
      throw new Error('Set SENSITIVE_AUDIT_DISPOSABLE=1 only for disposable local infrastructure.');
    db = createDatabaseClient(url, { log: [] });
    await assertConnectedToDisposableDatabase(
      async () =>
        (await db.$queryRaw<{ name: string }[]>`SELECT current_database() AS name`)[0]?.name,
      expected,
    );
    // The test-only GUC is connection/transaction local; concurrent suites do not fail.
    await db.$executeRawUnsafe(
      'CREATE FUNCTION ' +
        functionName +
        "() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF current_setting('truevine.audit_test_failure',true)='1' THEN RAISE EXCEPTION 'injected database audit failure'; END IF; RETURN NEW; END; $",
    );
    ownedFunction = true;
    for (const table of ['security_audit_events', 'identity_audit_events']) {
      await db.$executeRawUnsafe(
        'CREATE TRIGGER ' +
          triggerName +
          ' BEFORE INSERT ON ' +
          table +
          ' FOR EACH ROW EXECUTE FUNCTION ' +
          functionName +
          '()',
      );
      ownedTriggerTables.push(table);
    }
    secretHash = await hashPassword(password);
    const module = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(APP_CONFIG)
      .useValue({
        host: '127.0.0.1',
        port: 0,
        environment: 'test',
        version: 'rbac013',
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
      .useValue(allow)
      .compile();
    terms = module.get<string>(TERMS_VERSION);
    app = module.createNestApplication();
    await app.init();
  });
  afterAll(async () => {
    if (db) {
      for (const table of ownedTriggerTables)
        await db.$executeRawUnsafe('DROP TRIGGER IF EXISTS ' + triggerName + ' ON ' + table);
      if (ownedFunction)
        await db.$executeRawUnsafe('DROP FUNCTION IF EXISTS ' + functionName + '()');
    }
    await app?.close();
    await db?.$disconnect();
  });

  function services(client = db) {
    const auth = new PrismaAuthStore(client),
      audit = new PrismaAuditStore(client),
      transaction = new PrismaSecurityTransaction(client);
    return {
      organization: new OrganizationsService(
        new PrismaOrganizationStore(client),
        auth,
        audit,
        new NullEmailSender(),
        'http://localhost:3000',
        terms,
        transaction,
      ),
      auth: new AuthService(
        auth,
        audit,
        allow,
        new NullEmailSender(),
        'http://localhost:3000',
        2,
        60000,
        60000,
        transaction,
      ),
    };
  }
  /** Genuine PostgreSQL INSERT rejection inside the real application transaction. */
  function failingDatabase(): PrismaClient {
    return new Proxy(db, {
      get(target, property, receiver) {
        if (property === '$transaction')
          return (work: (tx: unknown) => Promise<unknown>) =>
            target.$transaction(async (tx) => {
              await tx.$queryRaw`SELECT set_config('truevine.audit_test_failure','1',true)`;
              return work(tx);
            });
        const value: unknown = Reflect.get(target, property, receiver);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
  }
  async function fixture() {
    const org = randomUUID(),
      owner = randomUUID(),
      member = randomUUID(),
      admin = randomUUID(),
      campaign = randomUUID();
    const token = randomUUID();
    await db.$transaction(async (tx) => {
      await tx.user.createMany({
        data: [owner, member, admin].map((id) => ({
          id,
          email: id + '@example.invalid',
          passwordHash: secretHash,
        })),
      });
      await tx.organization.create({
        data: { id: org, slug: org, name: 'Synthetic private organization' },
      });
      await tx.membership.createMany({
        data: [
          { organizationId: org, userId: owner, role: 'OWNER' },
          { organizationId: org, userId: member, role: 'VIEWER' },
          { organizationId: org, userId: admin, role: 'ADMIN' },
        ],
      });
      await tx.campaign.create({
        data: {
          organizationId: org,
          id: campaign,
          name: 'Synthetic private campaign',
          status: 'ACTIVE',
          createdById: owner,
        },
      });
      await tx.termsAcceptance.createMany({
        data: [owner, member, admin].map((userId) => ({ userId, termsVersion: terms })),
      });
    });
    const session = await db.session.create({
      data: {
        userId: owner,
        tokenHash: hashToken(token),
        expiresAt: new Date(Date.now() + 3600000),
      },
    });
    return { org, owner, member, admin, campaign, token, session: session.id };
  }
  async function tenantEvent(org: string, action: string) {
    const event = await db.securityAuditEvent.findFirst({
      where: { organizationId: org, action, outcome: 'SUCCESS' },
      orderBy: { occurredAt: 'desc' },
    });
    expect(event).not.toBeNull();
    return event!;
  }
  function metadata(event: { metadata: unknown }): Record<string, unknown> {
    return event.metadata as Record<string, unknown>;
  }
  function contract(
    event: { id: string; actorUserId: string; metadata: unknown; occurredAt: Date },
    actor: string,
    type: string,
    id: string,
  ) {
    expect(event.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(event.actorUserId).toBe(actor);
    expect(event.occurredAt.getTime()).toBeGreaterThan(Date.now() - 60000);
    expect(metadata(event)).toMatchObject({
      auditVersion: 1,
      target: { type, id },
      reasonCode: expect.any(String),
      before: expect.anything(),
      change: expect.any(Object),
      after: expect.anything(),
    });
  }
  it('records member-role before/change/after and supplied reason without copying credentials', async () => {
    const f = await fixture(),
      id = randomUUID();
    await withAuditRequest(id, () =>
      services().organization.changeMemberRole(
        f.org,
        { userId: f.owner, role: 'OWNER' },
        f.member,
        'ADMIN',
        {
          reasonCode: 'membership_request',
          justification: 'Approved organizational responsibility',
        },
      ),
    );
    const event = await tenantEvent(f.org, 'organization.member.role_changed');
    contract(event, f.owner, 'membership', f.member);
    expect(metadata(event)).toMatchObject({
      before: { role: 'VIEWER' },
      change: { role: 'ADMIN' },
      after: { role: 'ADMIN' },
      reasonCode: 'membership_request',
      reasonSource: 'caller',
      requestId: id,
      justification: 'Approved organizational responsibility',
    });
    expect(JSON.stringify(event)).not.toContain(secretHash);
    expect(JSON.stringify(event)).not.toContain(password);
  });
  it('records removal and ownership transfer with the actual prior roles', async () => {
    const f = await fixture();
    await services().organization.removeMember(f.org, { userId: f.owner, role: 'OWNER' }, f.admin);
    expect(metadata(await tenantEvent(f.org, 'organization.member.removed'))).toMatchObject({
      target: { type: 'membership', id: f.admin },
      before: { role: 'ADMIN' },
      change: { removed: true },
      after: null,
    });
    await services().organization.transferOwnership(f.org, f.owner, f.member);
    const event = await tenantEvent(f.org, 'organization.ownership.transferred');
    contract(event, f.owner, 'organization', f.org);
    expect(metadata(event)).toMatchObject({
      before: { ownerId: f.owner, newOwnerRole: 'VIEWER' },
      after: { ownerId: f.member, previousOwnerRole: 'ADMIN', newOwnerRole: 'OWNER' },
    });
  });
  it('records invitation creation/revocation/acceptance without retaining the invitation capability', async () => {
    const f = await fixture(),
      email = randomUUID() + '@example.invalid';
    const invitation = await services().organization.invite(
      f.org,
      { userId: f.owner, role: 'OWNER' },
      email,
      'VIEWER',
    );
    const created = await tenantEvent(f.org, 'organization.member.invited');
    expect(metadata(created)).toMatchObject({
      target: { type: 'invitation', id: invitation.id },
      before: null,
      after: { role: 'VIEWER', accepted: false, revoked: false },
    });
    await services().organization.revokeInvitation(f.org, f.owner, invitation.id);
    expect(metadata(await tenantEvent(f.org, 'organization.invitation.revoked'))).toMatchObject({
      before: { revoked: false },
      after: { revoked: true },
    });
    const user = randomUUID(),
      raw = randomUUID();
    await db.user.create({
      data: { id: user, email: user + '@example.invalid', passwordHash: secretHash },
    });
    const pending = await db.invitation.create({
      data: {
        organizationId: f.org,
        email: user + '@example.invalid',
        role: 'VIEWER',
        tokenHash: hashToken(raw),
        invitedByUserId: f.owner,
        expiresAt: new Date(Date.now() + 60000),
      },
    });
    await services().organization.acceptInvitation(user, raw);
    const accepted = await tenantEvent(f.org, 'organization.invitation.accepted');
    expect(metadata(accepted)).toMatchObject({
      target: { type: 'membership', id: user },
      before: null,
      change: { invitationId: pending.id },
      after: { role: 'VIEWER' },
    });
    expect(JSON.stringify(accepted)).not.toContain(raw);
    expect(JSON.stringify(accepted)).not.toContain(hashToken(raw));
  });
  it('uses a server correlation ID and ignores forged actor, organization and timestamp fields', async () => {
    const a = await fixture(),
      b = await fixture();
    const response = await request(app.getHttpServer())
      .patch('/organizations/' + a.org)
      .set('cookie', 'tv_session=' + a.token + '; tv_csrf=' + csrf)
      .set('x-truevine-csrf', csrf)
      .set('x-request-id', 'forged')
      .send({
        name: 'Updated private name',
        organizationId: b.org,
        actorUserId: b.owner,
        occurredAt: '2000-01-01',
        reason: { reasonCode: 'correction' },
      });
    expect(response.status).toBe(200);
    const event = await tenantEvent(a.org, 'organization.profile_updated');
    expect(event.actorUserId).toBe(a.owner);
    expect(event.occurredAt.getFullYear()).not.toBe(2000);
    expect(metadata(event).requestId).toBe(response.headers['x-request-id']);
    expect(metadata(event).requestId).not.toBe('forged');
    expect(metadata(event)).toMatchObject({
      target: { type: 'organization', id: a.org },
      before: { nameDigest: expect.any(String) },
      after: { nameDigest: expect.any(String) },
    });
    expect(JSON.stringify(event)).not.toContain('Updated private name');
    expect((await db.organization.findUnique({ where: { id: b.org } }))?.name).toBe(
      'Synthetic private organization',
    );
  });
  it('rejects invalid supplied reasons, preserves legacy purpose codes, and records safe denials', async () => {
    const f = await fixture();
    await expect(
      services().organization.changeMemberRole(
        f.org,
        { userId: f.owner, role: 'OWNER' },
        f.member,
        'ADMIN',
        { reasonCode: '' },
      ),
    ).rejects.toMatchObject({ status: 400, code: 'invalid_audit_reason' });
    expect(
      (
        await db.membership.findUnique({
          where: { organizationId_userId: { organizationId: f.org, userId: f.member } },
        })
      )?.role,
    ).toBe('VIEWER');
    expect(
      await db.securityAuditEvent.count({
        where: { organizationId: f.org, action: 'organization.member.role_changed' },
      }),
    ).toBe(0);
    await services().organization.changeMemberRole(
      f.org,
      { userId: f.owner, role: 'OWNER' },
      f.member,
      'ADMIN',
    );
    expect(metadata(await tenantEvent(f.org, 'organization.member.role_changed'))).toMatchObject({
      reasonCode: 'membership_role_change',
      reasonSource: 'server',
    });
    await expect(
      services().organization.changeMemberRole(
        f.org,
        { userId: f.admin, role: 'ADMIN' },
        f.member,
        'OWNER',
      ),
    ).rejects.toMatchObject({ status: 403 });
    expect(
      await db.securityAuditEvent.count({ where: { organizationId: f.org, outcome: 'DENIED' } }),
    ).toBeGreaterThan(0);
  });
  it('records cross-tenant and revoked-membership refusals with no foreign state disclosure', async () => {
    const a = await fixture(),
      b = await fixture();
    const denied = await request(app.getHttpServer())
      .patch('/organizations/' + b.org + '/members/' + b.member)
      .set('cookie', 'tv_session=' + a.token + '; tv_csrf=' + csrf)
      .set('x-truevine-csrf', csrf)
      .send({ role: 'ADMIN' });
    expect(denied.status).toBe(403);
    const event = await db.securityAuditEvent.findFirstOrThrow({
      where: { organizationId: b.org, actorUserId: a.owner, outcome: 'DENIED' },
    });
    expect(metadata(event)).toMatchObject({ before: null, after: null });
    await db.membership.update({
      where: { organizationId_userId: { organizationId: a.org, userId: a.admin } },
      data: { role: 'VIEWER' },
    });
    await expect(
      services().organization.changeMemberRole(
        a.org,
        { userId: a.admin, role: 'ADMIN' },
        a.member,
        'CAMPAIGN_MANAGER',
      ),
    ).rejects.toMatchObject({ status: 403 });
    expect(
      (
        await db.membership.findUnique({
          where: { organizationId_userId: { organizationId: b.org, userId: b.member } },
        })
      )?.role,
    ).toBe('VIEWER');
  });
  it.each(['ADMIN', 'BILLING'] as const)(
    'prevents an Admin demoting a protected %s member',
    async (role) => {
      const f = await fixture();
      await db.membership.update({
        where: { organizationId_userId: { organizationId: f.org, userId: f.member } },
        data: { role },
      });
      await expect(
        services().organization.changeMemberRole(
          f.org,
          { userId: f.admin, role: 'ADMIN' },
          f.member,
          'VIEWER',
        ),
      ).rejects.toMatchObject({ status: 403 });
      expect(
        (
          await db.membership.findUnique({
            where: { organizationId_userId: { organizationId: f.org, userId: f.member } },
          })
        )?.role,
      ).toBe(role);
      expect(
        await db.securityAuditEvent.count({
          where: {
            organizationId: f.org,
            action: 'organization.member.role_changed',
            outcome: 'SUCCESS',
          },
        }),
      ).toBe(0);
    },
  );
  it('serializes concurrent permission changes and records the actual committed before/after chain', async () => {
    const f = await fixture(),
      organization = services().organization;
    await Promise.all([
      organization.changeMemberRole(f.org, { userId: f.owner, role: 'OWNER' }, f.member, 'ADMIN'),
      organization.changeMemberRole(f.org, { userId: f.owner, role: 'OWNER' }, f.member, 'BILLING'),
    ]);
    const rows = await db.securityAuditEvent.findMany({
      where: {
        organizationId: f.org,
        action: 'organization.member.role_changed',
        outcome: 'SUCCESS',
      },
    });
    expect(rows).toHaveLength(2);
    const states = rows.map(
      (row) => metadata(row) as { before: { role: string }; after: { role: string } },
    );
    const first = states.find((row) => row.before.role === 'VIEWER')!;
    const second = states.find((row) => row !== first)!;
    expect(second.before.role).toBe(first.after.role);
    expect(
      (
        await db.membership.findUnique({
          where: { organizationId_userId: { organizationId: f.org, userId: f.member } },
        })
      )?.role,
    ).toBe(second.after.role);
  });
  it('records campaign lifecycle atomically with sanitized editable state', async () => {
    const f = await fixture(),
      campaigns = new PrismaCampaignStore(db);
    const created = await campaigns.createCampaign({
      organizationId: f.org,
      id: randomUUID(),
      createdById: f.owner,
      name: 'Private synthetic campaign',
      status: 'DRAFT',
    });
    await campaigns.updateCampaign(f.org, created.id, { status: 'ACTIVE' }, f.owner);
    expect(await campaigns.deleteCampaign(f.org, created.id, f.owner)).toBe(true);
    for (const action of ['campaign.created', 'campaign.updated', 'campaign.deleted']) {
      const event = await tenantEvent(f.org, action);
      expect(event.targetId).toBe(created.id);
      expect(metadata(event).auditVersion).toBe(1);
      expect(JSON.stringify(event)).not.toContain('Private synthetic campaign');
    }
    expect(metadata(await tenantEvent(f.org, 'campaign.updated'))).toMatchObject({
      before: { status: 'DRAFT' },
      after: { status: 'ACTIVE' },
    });
  });
  it('records billing details and only one pending top-up audit for concurrent identical retries', async () => {
    const f = await fixture(),
      billing = new PrismaBillingStore(db);
    await billing.saveProfile(
      f.org,
      { name: 'Private payer', email: 'private@example.invalid', address: 'Private address' },
      f.owner,
    );
    const profile = await tenantEvent(f.org, 'billing.profile_updated');
    expect(metadata(profile)).toMatchObject({
      before: null,
      after: { configured: true, detailsDigest: expect.any(String) },
    });
    expect(JSON.stringify(profile)).not.toContain('private@example.invalid');
    const input = {
      organizationId: f.org,
      createdById: f.owner,
      amountMinor: 25n,
      idempotencyKey: randomUUID(),
    };
    const result = await Promise.all(Array.from({ length: 4 }, () => billing.requestTopUp(input)));
    expect(new Set(result.map((row) => row.id)).size).toBe(1);
    expect(
      await db.securityAuditEvent.count({
        where: { organizationId: f.org, action: 'billing.top_up_requested', outcome: 'SUCCESS' },
      }),
    ).toBe(1);
    expect(metadata(await tenantEvent(f.org, 'billing.top_up_requested'))).toMatchObject({
      before: null,
      change: { requestedMinor: '25', currency: 'UGX' },
      after: { status: 'PENDING' },
    });
    await billing.requestTopUp({ ...input, amountMinor: 26n });
    expect(
      await db.securityAuditEvent.count({ where: { organizationId: f.org, outcome: 'DENIED' } }),
    ).toBe(1);
    expect(await billing.balance(f.org)).toBe(0n);
  });
  it('records account self-suspension and session revocation without retaining credentials', async () => {
    const f = await fixture(),
      auth = services().auth;
    await auth.signOut(f.session, f.owner);
    const session = await db.identityAuditEvent.findFirstOrThrow({
      where: { actorUserId: f.owner, action: 'auth.session_revoked' },
    });
    expect(metadata(session)).toMatchObject({
      target: { type: 'session', id: f.session },
      before: { revoked: false },
      after: { revoked: true },
      reasonCode: 'self_sign_out',
    });
    await auth.deactivateAccount(f.owner);
    const account = await db.identityAuditEvent.findFirstOrThrow({
      where: { actorUserId: f.owner, action: 'auth.account_deactivated' },
    });
    contract(account, f.owner, 'user', f.owner);
    expect(metadata(account)).toMatchObject({
      before: { status: 'ACTIVE' },
      change: { status: 'SUSPENDED', sessionsRevoked: true },
      after: { status: 'SUSPENDED' },
    });
    expect(JSON.stringify(account)).not.toContain(secretHash);
  });
  it('records password recovery without copying the capability or credential', async () => {
    const f = await fixture(),
      raw = randomUUID(),
      newPassword = 'replacement-synthetic-passphrase';
    await db.passwordResetToken.create({
      data: { userId: f.owner, tokenHash: hashToken(raw), expiresAt: new Date(Date.now() + 60000) },
    });
    await services().auth.completePasswordReset(raw, newPassword);
    const event = await db.identityAuditEvent.findFirstOrThrow({
      where: { actorUserId: f.owner, action: 'auth.password_reset_completed' },
    });
    contract(event, f.owner, 'user', f.owner);
    expect(metadata(event)).toMatchObject({
      change: { credentialsReplaced: true, sessionsRevoked: true },
      reasonCode: 'credential_recovery',
      actorKind: 'recovery_capability',
    });
    expect(JSON.stringify(event)).not.toContain(raw);
    expect(JSON.stringify(event)).not.toContain(newPassword);
    expect(JSON.stringify(event)).not.toContain(secretHash);
  });
  it('records automatic lockout as a denied authentication outcome with applied lock state', async () => {
    const f = await fixture();
    for (let i = 0; i < 2; i++)
      await expect(
        services().auth.signIn(f.owner + '@example.invalid', 'incorrect', {
          ipPrefix: null,
          userAgentHash: null,
        }),
      ).rejects.toMatchObject({ status: 401 });
    const event = await db.identityAuditEvent.findFirstOrThrow({
      where: { actorUserId: f.owner, action: 'auth.account_locked', outcome: 'DENIED' },
    });
    expect(metadata(event)).toMatchObject({
      target: { type: 'user', id: f.owner },
      change: { accessLocked: true },
      after: { failedLoginCount: 2, lockedUntil: expect.any(String) },
    });
  });
  it('keeps platform emergency stop and audit atomic, scoped, idempotent and freshly authorized', async () => {
    const f = await fixture();
    await db.platformRoleAssignment.create({ data: { userId: f.owner, role: 'PLATFORM_OWNER' } });
    const operations = new PrismaOperationsStore(db);
    const input = {
      organizationId: f.org,
      campaignId: f.campaign,
      actorUserId: f.owner,
      reasonCode: 'security_incident' as const,
      stoppedAt: new Date(),
    };
    expect((await operations.emergencyStop(input)).kind).toBe('stopped');
    expect((await operations.emergencyStop(input)).kind).toBe('already_stopped');
    const event = await tenantEvent(f.org, 'platform.campaign.emergency_stopped');
    contract(event, f.owner, 'campaign', f.campaign);
    expect(event.scope).toBe('PLATFORM');
    expect(metadata(event)).toMatchObject({
      before: { status: 'ACTIVE', emergencyStoppedAt: null },
      after: { status: 'COMPLETED' },
      reasonCode: 'security_incident',
    });
    expect(
      await db.securityAuditEvent.count({
        where: { organizationId: f.org, action: 'platform.campaign.emergency_stopped' },
      }),
    ).toBe(1);
    await db.platformRoleAssignment.update({
      where: { userId: f.owner },
      data: { revokedAt: new Date() },
    });
    await expect(operations.emergencyStop(input)).rejects.toMatchObject({ status: 403 });
  });
  it('keeps concurrent campaign edits and platform stops in a truthful state chain', async () => {
    const f = await fixture();
    await db.platformRoleAssignment.create({ data: { userId: f.owner, role: 'PLATFORM_OWNER' } });
    await Promise.all([
      new PrismaCampaignStore(db).updateCampaign(
        f.org,
        f.campaign,
        { name: 'Concurrent edit' },
        f.owner,
      ),
      new PrismaOperationsStore(db).emergencyStop({
        organizationId: f.org,
        campaignId: f.campaign,
        actorUserId: f.owner,
        reasonCode: 'security_incident',
        stoppedAt: new Date(),
        justification: 'Reviewed incident',
      }),
    ]);
    const edit = metadata(await tenantEvent(f.org, 'campaign.updated')) as {
      before: { status: string; emergencyStoppedAt: string | null };
      after: { status: string; emergencyStoppedAt: string | null };
    };
    expect(edit.before.status).toBe(edit.after.status);
    expect(edit.before.emergencyStoppedAt).toBe(edit.after.emergencyStoppedAt);
    expect(metadata(await tenantEvent(f.org, 'platform.campaign.emergency_stopped'))).toMatchObject(
      { justification: 'Reviewed incident', reasonSource: 'caller' },
    );
  });
  it.each([
    'membership',
    'ownership',
    'profile',
    'campaign_create',
    'campaign_update',
    'campaign_delete',
    'billing_profile',
    'top_up',
    'account',
    'emergency',
    'provisioning',
  ] as const)('rolls back %s when PostgreSQL rejects its required audit INSERT', async (action) => {
    const f = await fixture(),
      broken = failingDatabase(),
      service = services(broken);
    await db.platformRoleAssignment.create({ data: { userId: f.owner, role: 'PLATFORM_OWNER' } });
    const before = JSON.stringify(await db.organization.findUnique({ where: { id: f.org } }));
    const provisionUser = randomUUID(),
      provisionOrg = randomUUID();
    const actionFn = () => {
      switch (action) {
        case 'membership':
          return service.organization.changeMemberRole(
            f.org,
            { userId: f.owner, role: 'OWNER' },
            f.member,
            'ADMIN',
          );
        case 'ownership':
          return service.organization.transferOwnership(f.org, f.owner, f.member);
        case 'profile':
          return service.organization.updateProfile(f.org, f.owner, 'Should roll back');
        case 'campaign_create':
          return new PrismaCampaignStore(broken).createCampaign({
            organizationId: f.org,
            id: randomUUID(),
            createdById: f.owner,
            name: 'Should roll back',
            status: 'DRAFT',
          });
        case 'campaign_update':
          return new PrismaCampaignStore(broken).updateCampaign(
            f.org,
            f.campaign,
            { status: 'COMPLETED' },
            f.owner,
          );
        case 'campaign_delete':
          return new PrismaCampaignStore(broken).deleteCampaign(f.org, f.campaign, f.owner);
        case 'billing_profile':
          return new PrismaBillingStore(broken).saveProfile(
            f.org,
            { name: 'Synthetic', email: 'synthetic@example.invalid', address: 'Synthetic' },
            f.owner,
          );
        case 'top_up':
          return new PrismaBillingStore(broken).requestTopUp({
            organizationId: f.org,
            createdById: f.owner,
            amountMinor: 20n,
            idempotencyKey: randomUUID(),
          });
        case 'account':
          return service.auth.deactivateAccount(f.owner);
        case 'emergency':
          return new PrismaOperationsStore(broken).emergencyStop({
            organizationId: f.org,
            campaignId: f.campaign,
            actorUserId: f.owner,
            reasonCode: 'security_incident',
            stoppedAt: new Date(),
          });
        case 'provisioning':
          return new PrismaProvisioningStore(broken).createUserWithOrganization(
            {
              id: provisionUser,
              email: provisionUser + '@example.invalid',
              passwordHash: secretHash,
            },
            { id: provisionOrg, slug: provisionOrg, name: 'Should roll back' },
          );
      }
    };

    await expect(actionFn()).rejects.toThrow('injected database audit failure');
    expect(JSON.stringify(await db.organization.findUnique({ where: { id: f.org } }))).toBe(before);
    expect(
      (
        await db.membership.findUnique({
          where: { organizationId_userId: { organizationId: f.org, userId: f.owner } },
        })
      )?.role,
    ).toBe('OWNER');
    expect(
      (
        await db.membership.findUnique({
          where: { organizationId_userId: { organizationId: f.org, userId: f.member } },
        })
      )?.role,
    ).toBe('VIEWER');
    expect(await db.campaign.count({ where: { organizationId: f.org } })).toBe(1);
    expect(
      (
        await db.campaign.findUnique({
          where: { organizationId_id: { organizationId: f.org, id: f.campaign } },
        })
      )?.status,
    ).toBe('ACTIVE');
    expect(await db.billingProfile.count({ where: { organizationId: f.org } })).toBe(0);
    expect(await db.topUpRequest.count({ where: { organizationId: f.org } })).toBe(0);
    expect((await db.user.findUnique({ where: { id: f.owner } }))?.status).toBe('ACTIVE');
    expect((await db.session.findUnique({ where: { id: f.session } }))?.revokedAt).toBeNull();
    expect(
      await db.securityAuditEvent.count({ where: { organizationId: f.org, outcome: 'SUCCESS' } }),
    ).toBe(0);
    expect(await db.walletEntry.count({ where: { organizationId: f.org } })).toBe(0);
    if (action === 'provisioning') {
      expect(await db.user.count({ where: { id: provisionUser } })).toBe(0);
      expect(await db.organization.count({ where: { id: provisionOrg } })).toBe(0);
    }
  });
  it('rejects UPDATE, DELETE and TRUNCATE of both audit trails, retaining historical rows', async () => {
    const f = await fixture();
    await services().organization.updateProfile(f.org, f.owner, 'Audited');
    await services().auth.acceptTerms(f.owner, terms, null);
    const tenant = await tenantEvent(f.org, 'organization.profile_updated');
    const identity = await db.identityAuditEvent.findFirstOrThrow({
      where: { actorUserId: f.owner },
    });
    await expect(
      db.securityAuditEvent.update({
        where: { organizationId_id: { organizationId: f.org, id: tenant.id } },
        data: { metadata: { edited: true } },
      }),
    ).rejects.toThrow();
    await expect(
      db.securityAuditEvent.delete({
        where: { organizationId_id: { organizationId: f.org, id: tenant.id } },
      }),
    ).rejects.toThrow();
    await expect(
      db.identityAuditEvent.update({
        where: { id: identity.id },
        data: { metadata: { edited: true } },
      }),
    ).rejects.toThrow();
    await expect(db.identityAuditEvent.delete({ where: { id: identity.id } })).rejects.toThrow();
    for (const table of ['security_audit_events', 'identity_audit_events']) {
      // Even a regression in the guard cannot destroy other test fixtures:
      // an unexpectedly successful TRUNCATE is always rolled back and fails this assertion.
      await expect(
        db.$transaction(
          async (tx) => {
            await tx.$executeRawUnsafe('TRUNCATE ' + table + ' CASCADE');
            throw new Error('unguarded truncate unexpectedly succeeded');
          },
          { timeout: 15000 },
        ),
      ).rejects.toThrow('append-only');
    }
    expect(
      await db.securityAuditEvent.findUnique({
        where: { organizationId_id: { organizationId: f.org, id: tenant.id } },
      }),
    ).toEqual(tenant);
    expect(await db.identityAuditEvent.findUnique({ where: { id: identity.id } })).toEqual(
      identity,
    );
  });
});
