import { randomUUID } from 'node:crypto';
import { hashToken } from '@truevine/auth';
import { createDatabaseClient, type PrismaClient } from '@truevine/database';
import { loadEnvFiles, requireEnv } from '@truevine/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaSupportAccessStore } from '../src/support/prisma-support-access.store.js';
import type {
  NewSupportAccessSession,
  SupportAccessStore,
} from '../src/support/support-access.store.js';
import {
  assertConnectedToDisposableDatabase,
  assertDisposableDatabase,
} from './disposable-database.js';

describe('RBAC-014 support access persistence on disposable PostgreSQL', () => {
  let db: PrismaClient;
  let store: SupportAccessStore;
  let operatorId: string;
  let authSessionId: string;
  let organizationId: string;

  beforeAll(async () => {
    loadEnvFiles();
    const url = requireEnv('DATABASE_URL');
    const expected = assertDisposableDatabase(url, process.env['NODE_ENV']);
    if (process.env['CI'] !== 'true' && process.env['SUPPORT_ACCESS_DISPOSABLE'] !== '1')
      throw new Error('Set SUPPORT_ACCESS_DISPOSABLE=1 only for a disposable local database.');
    db = createDatabaseClient(url, { log: [] });
    await assertConnectedToDisposableDatabase(
      async () =>
        (await db.$queryRaw<{ name: string }[]>`SELECT current_database() AS name`)[0]?.name,
      expected,
    );
    store = new PrismaSupportAccessStore(db as never);
  });

  afterAll(async () => db?.$disconnect());

  async function fixture(expiresAt = new Date(Date.now() + 15 * 60_000)) {
    operatorId = randomUUID();
    authSessionId = randomUUID();
    organizationId = randomUUID();
    const ownerId = randomUUID();
    const secret = randomUUID() + randomUUID();
    const now = new Date();
    await db.$transaction(async (tx) => {
      await tx.user.create({
        data: {
          id: operatorId,
          email: `${operatorId}@example.invalid`,
          passwordHash: 'unusable-synthetic',
        },
      });
      await tx.user.create({
        data: {
          id: ownerId,
          email: `${ownerId}@example.invalid`,
          passwordHash: 'unusable-synthetic',
        },
      });
      await tx.organization.create({
        data: { id: organizationId, slug: organizationId, name: 'Synthetic support tenant' },
      });
      await tx.membership.create({
        data: { organizationId, userId: ownerId, role: 'OWNER' },
      });
      await tx.platformRoleAssignment.create({
        data: { userId: operatorId, role: 'SUPPORT_ADMIN' },
      });
      await tx.session.create({
        data: {
          id: authSessionId,
          userId: operatorId,
          tokenHash: hashToken(randomUUID()),
          expiresAt: new Date(now.getTime() + 60 * 60_000),
        },
      });
    });
    const input: NewSupportAccessSession = {
      id: randomUUID(),
      organizationId,
      actorUserId: operatorId,
      authSessionId,
      tokenHash: hashToken(secret),
      reasonCode: 'SERVICE_DIAGNOSTIC',
      createdAt: now,
      expiresAt,
    };
    return { input, secret };
  }

  it('atomically persists one-organization context and its real-actor audit event', async () => {
    const { input } = await fixture();
    await expect(store.create(input)).resolves.toBe('created');
    const row = await db.supportAccessSession.findUnique({
      where: { organizationId_id: { organizationId, id: input.id } },
    });
    expect(row?.actorUserId).toBe(operatorId);
    expect(row?.authSessionId).toBe(authSessionId);
    expect(row?.tokenHash).toBe(input.tokenHash);
    expect(row?.tokenHash).not.toContain('raw');
    const audit = await db.identityAuditEvent.findFirst({
      where: { actorUserId: operatorId, action: 'platform.support.access_started' },
      orderBy: { occurredAt: 'desc' },
    });
    expect(audit?.outcome).toBe('SUCCESS');
    expect(audit?.metadata).toMatchObject({
      supportSessionId: input.id,
      organizationId,
      reasonCode: 'SERVICE_DIAGNOSTIC',
    });
  });

  it('enforces the reason allowlist and 15-minute maximum in PostgreSQL', async () => {
    const { input } = await fixture();
    await expect(
      db.supportAccessSession.create({ data: { ...input, id: randomUUID(), reasonCode: 'UNAPPROVED' } }),
    ).rejects.toThrow();
    await expect(
      db.supportAccessSession.create({
        data: {
          ...input,
          id: randomUUID(),
          tokenHash: hashToken(randomUUID() + randomUUID()),
          expiresAt: new Date(input.createdAt.getTime() + 16 * 60_000),
        },
      }),
    ).rejects.toThrow();
  });

  it('binds lookup to operator and login session, then immediately denies after revocation', async () => {
    const { input } = await fixture();
    expect(await store.create(input)).toBe('created');
    const lookup = {
      tokenHash: input.tokenHash,
      actorUserId: operatorId,
      authSessionId,
      now: new Date(),
    };
    await expect(store.resolve(lookup)).resolves.toMatchObject({
      kind: 'active',
      context: { organizationId },
    });
    await expect(store.resolve({ ...lookup, actorUserId: randomUUID() })).resolves.toEqual({
      kind: 'invalid',
    });
    const concurrent = await Promise.all([store.resolve(lookup), store.revoke(lookup)]);
    expect(
      concurrent.some(
        (result) =>
          result === 'revoked' || (typeof result !== 'string' && result.kind === 'active'),
      ),
    ).toBe(true);
    await expect(store.resolve(lookup)).resolves.toEqual({ kind: 'invalid' });
    expect(
      await db.identityAuditEvent.count({
        where: { actorUserId: operatorId, action: 'platform.support.access_ended' },
      }),
    ).toBe(1);
  });

  it('records observed expiry and fences removed platform permission', async () => {
    const expired = await fixture(new Date(Date.now() - 1_000));
    expect(await store.create(expired.input)).toBe('created');
    const lookup = {
      tokenHash: expired.input.tokenHash,
      actorUserId: operatorId,
      authSessionId,
      now: new Date(),
    };
    await expect(store.resolve(lookup)).resolves.toEqual({ kind: 'expired' });
    const expiredRow = await db.supportAccessSession.findUnique({
      where: { organizationId_id: { organizationId, id: expired.input.id } },
    });
    expect(expiredRow?.revokedAt).not.toBeNull();

    const active = await fixture();
    expect(await store.create(active.input)).toBe('created');
    await db.platformRoleAssignment.update({
      where: { userId: operatorId },
      data: { revokedAt: new Date() },
    });
    await expect(
      store.resolve({
        tokenHash: active.input.tokenHash,
        actorUserId: operatorId,
        authSessionId,
        now: new Date(),
      }),
    ).resolves.toEqual({ kind: 'invalid' });
  });

  it('rolls back capability creation when the audit insert fails', async () => {
    const { input } = await fixture();
    const failingClient = new Proxy(db, {
      get(target, property) {
        if (property === '$transaction')
          return (body: (tx: unknown) => Promise<unknown>) =>
            target.$transaction((tx) => {
              const wrapped = new Proxy(tx, {
                get(inner, key) {
                  if (key === 'identityAuditEvent')
                    return new Proxy(inner.identityAuditEvent, {
                      get(delegate, method) {
                        if (method === 'create')
                          return async () => {
                            throw new Error('audit unavailable');
                          };
                        return Reflect.get(delegate, method);
                      },
                    });
                  return Reflect.get(inner, key);
                },
              });
              return body(wrapped);
            });
        return Reflect.get(target, property);
      },
    });
    const failingStore = new PrismaSupportAccessStore(failingClient as never);
    await expect(failingStore.create(input)).rejects.toThrow('audit unavailable');
    expect(await db.supportAccessSession.count({ where: { organizationId, id: input.id } })).toBe(
      0,
    );
  });
});
