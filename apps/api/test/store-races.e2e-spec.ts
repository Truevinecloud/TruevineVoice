import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createDatabaseClient, type PrismaClient } from '@truevine/database';
import { loadEnvFiles, requireEnv } from '@truevine/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaOrganizationStore } from '../src/auth/prisma-stores.js';

let db: PrismaClient;
let store: PrismaOrganizationStore;
beforeAll(async () => {
  loadEnvFiles();
  db = createDatabaseClient(requireEnv('DATABASE_URL'));
  store =
    process.env['SECURITY_BASELINE'] === '1'
      ? (new (
          await import(pathToFileURL(resolve('dist/auth/prisma-stores-baseline.js')).href)
        ).PrismaOrganizationStore(db) as PrismaOrganizationStore)
      : new PrismaOrganizationStore(db);
});
afterAll(async () => {
  await db?.$disconnect();
});

async function fixture() {
  const organizationId = randomUUID(),
    ids = [randomUUID(), randomUUID(), randomUUID()];
  await db.$transaction(async (tx) => {
    await tx.organization.create({
      data: { id: organizationId, slug: 'race-' + organizationId, name: 'Race fixture' },
    });
    for (const [i, id] of ids.entries()) {
      await tx.user.create({
        data: { id, email: id + '@example.invalid', passwordHash: 'unusable-fixture' },
      });
      await tx.membership.create({
        data: { organizationId, userId: id, role: i === 0 ? 'OWNER' : 'VIEWER' },
      });
    }
  });
  return { organizationId, ids };
}

describe('same baseline and repaired PostgreSQL race contracts', () => {
  it('one token permits only the intended account and creates one membership', async () => {
    for (let round = 0; round < 10; round++) {
      const { organizationId, ids } = await fixture();
      await db.membership.deleteMany({ where: { organizationId, userId: { in: ids.slice(1) } } });
      const tokenHash = randomUUID();
      await db.invitation.create({
        data: {
          organizationId,
          email: ids[1] + '@example.invalid',
          role: 'VIEWER',
          tokenHash,
          invitedByUserId: ids[0]!,
          expiresAt: new Date(Date.now() + 60000),
        },
      });
      const results = await Promise.all(
        [ids[1]!, ids[2]!, ids[1]!, ids[2]!].map((id) =>
          store.acceptInvitation(tokenHash, id, new Date()),
        ),
      );
      expect(results.filter((r) => r.ok)).toHaveLength(1);
      const memberships = await db.membership.findMany({
        where: { organizationId, userId: { in: ids.slice(1) } },
      });
      expect(memberships.map((m) => m.userId)).toEqual([ids[1]]);
    }
  });

  it('concurrent transfers have exactly one winner and retain exactly one Owner', async () => {
    for (let round = 0; round < 10; round++) {
      const { organizationId, ids } = await fixture();
      const results = await Promise.all(
        ids.slice(1).map((id) => store.transferOwnership(organizationId, ids[0]!, id)),
      );
      expect(results.filter((r) => r.ok)).toHaveLength(1);
      expect(await db.membership.count({ where: { organizationId, role: 'OWNER' } })).toBe(1);
    }
  });
});
