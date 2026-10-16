/**
 * Tenancy enforcement against live PostgreSQL.
 *
 * The unit suite injects fakes, so it can prove the accessor exists but not that
 * the database refuses a cross-tenant write. These assertions are the reason
 * tenant scope lives in the schema rather than only in application code: a bug
 * in a query builder, a hand-written `$queryRaw`, or a future service that
 * forgets to scope a filter still cannot commit a row that belongs to another
 * organization.
 *
 * Requires PostgreSQL:
 *
 *   npm run infra:up
 *   npm run test:e2e
 *
 * Every test runs inside a transaction that is rolled back, so the suite leaves
 * no rows behind and cannot depend on, or damage, data it did not create.
 */

import { loadEnvFiles, requireEnv } from '@truevine/shared';
import { beforeAll, describe, expect, it } from 'vitest';

import { createDatabaseClient, probeDatabase, type PrismaClient } from '../src/index.js';

/**
 * Fixed UUIDs. Literal rather than generated so a failure message names the row
 * that was rejected instead of a fresh random identifier.
 */
const ORG_A = '11111111-1111-4111-8111-111111111111';
const ORG_B = '33333333-3333-4333-8333-333333333333';
const USER = '44444444-4444-4444-8444-444444444444';

let database: PrismaClient;

beforeAll(() => {
  // `loadEnvFiles` walks up to the repository-root `.env`, so the suite behaves
  // the same locally and in CI. A missing DATABASE_URL throws here, which is
  // the intended loud failure rather than a silent skip.
  loadEnvFiles();

  database = createDatabaseClient(requireEnv('DATABASE_URL'));
});

/**
 * Creates an organization directly, bypassing any application accessor.
 *
 * Takes the transaction handle rather than closing over the module-level client:
 * a write issued on the outer client would commit immediately and defeat the
 * rollback these tests depend on.
 */
/**
 * Creates a user directly, bypassing any application accessor.
 *
 * Needed because `memberships.user_id` now carries a foreign key to `users`.
 * Before 2026-10-16 the column existed with no constraint, so this suite could
 * invent a user id that no row described.
 */
async function insertUser(tx: PrismaClient, id: string, email: string): Promise<void> {
  await tx.$executeRaw`
    INSERT INTO users (id, email, password_hash, updated_at)
    VALUES (${id}::uuid, ${email}, ${'not-a-real-hash'}, now())
  `;
}

async function insertOrganization(tx: PrismaClient, id: string, slug: string): Promise<void> {
  await tx.$executeRaw`
    INSERT INTO organizations (id, slug, name, created_at, updated_at)
    VALUES (${id}::uuid, ${slug}, ${slug}, now(), now())
  `;
}

async function insertMembership(
  tx: PrismaClient,
  organizationId: string,
  userId: string,
  role: 'OWNER' | 'ADMIN' | 'OPERATOR' | 'VIEWER',
): Promise<void> {
  await tx.$executeRaw`
    INSERT INTO memberships (organization_id, user_id, role, created_at, updated_at)
    VALUES (${organizationId}::uuid, ${userId}::uuid, ${role}::"MembershipRole", now(), now())
  `;
}

/**
 * Sentinel thrown inside the transaction to force a rollback after the body has
 * produced its result. A successful `prisma.$transaction` callback COMMITS, so
 * simply returning a value would leave rows behind and make the suite fail on a
 * second run.
 */
class Rollback extends Error {
  constructor(readonly value: unknown) {
    super('rollback');
  }
}

/**
 * Runs `body` in a transaction that is always rolled back, returning whatever
 * the body produced.
 *
 * A body that throws propagates its own error, so the rejection assertions below
 * still match on the real PostgreSQL error rather than the sentinel.
 */
async function withRollback<T>(body: (tx: PrismaClient) => Promise<T>): Promise<T> {
  try {
    return (await database.$transaction(async (tx) => {
      const value = await body(tx);
      throw new Rollback(value);
    })) as T;
  } catch (error) {
    if (error instanceof Rollback) return error.value as T;
    throw error;
  }
}

describe('tenancy schema against live PostgreSQL', () => {
  it('is reachable', async () => {
    const health = await probeDatabase(database, 2_000);

    expect(health.status).toBe('up');
  });

  it('rejects a membership that points at an organization which does not exist', async () => {
    await expect(withRollback((tx) => insertMembership(tx, ORG_B, USER, 'OWNER'))).rejects.toThrow(
      /foreign key constraint/i,
    );
  });

  it('rejects a duplicate organization slug', async () => {
    await expect(
      withRollback(async (tx) => {
        await insertOrganization(tx, ORG_A, 'acme');
        await insertOrganization(tx, ORG_B, 'acme');
      }),
    ).rejects.toThrow(/duplicate key/i);
  });

  it('rejects a second membership for the same user in the same organization', async () => {
    await expect(
      withRollback(async (tx) => {
        await insertUser(tx, USER, `owner-${USER}@example.invalid`);
        await insertOrganization(tx, ORG_A, 'acme');
        await insertMembership(tx, ORG_A, USER, 'OWNER');
        await insertMembership(tx, ORG_A, USER, 'ADMIN');
      }),
    ).rejects.toThrow(/duplicate key/i);
  });

  it('rejects a membership for a user that does not exist', async () => {
    // The constraint ADR 0006 said should exist and, until 2026-10-16, did not:
    // `memberships.user_id` was a bare UUID the database never checked.
    await expect(
      withRollback(async (tx) => {
        await insertOrganization(tx, ORG_A, 'acme');
        await insertMembership(tx, ORG_A, USER, 'OWNER');
      }),
    ).rejects.toThrow(/memberships_user_id_fkey/i);
  });

  it('allows one user to hold independent roles in two organizations', async () => {
    const rows = await withRollback(async (tx) => {
      await insertUser(tx, USER, `owner-${USER}@example.invalid`);
      await insertOrganization(tx, ORG_A, 'acme');
      await insertOrganization(tx, ORG_B, 'beta');
      await insertMembership(tx, ORG_A, USER, 'VIEWER');
      await insertMembership(tx, ORG_B, USER, 'OWNER');

      return tx.$queryRaw<Array<{ organizationId: string; role: string }>>`
        SELECT organization_id AS "organizationId", role::text AS role
        FROM memberships
        WHERE user_id = ${USER}::uuid
        ORDER BY organization_id
      `;
    });

    expect(rows).toEqual([
      { organizationId: ORG_A, role: 'VIEWER' },
      { organizationId: ORG_B, role: 'OWNER' },
    ]);
  });

  it("deletes an organization's memberships with the organization", async () => {
    const remaining = await withRollback(async (tx) => {
      await insertUser(tx, USER, `owner-${USER}@example.invalid`);
      await insertOrganization(tx, ORG_A, 'acme');
      await insertMembership(tx, ORG_A, USER, 'OWNER');
      await tx.$executeRaw`DELETE FROM organizations WHERE id = ${ORG_A}::uuid`;

      return tx.$queryRaw<Array<{ count: bigint }>>`
        SELECT count(*) AS count FROM memberships WHERE user_id = ${USER}::uuid
      `;
    });

    expect(Number(remaining[0]?.count)).toBe(0);
  });

  it('leaves no rows of its own behind after the suite', async () => {
    // Scoped to this file's own identifiers rather than counting the whole
    // table. Other end-to-end suites run against the same database and create
    // organizations and users legitimately; a global count would fail for their
    // rows and would hide a real leak of this suite's own.
    const memberships = await database.$queryRaw<Array<{ count: bigint }>>`
      SELECT count(*) AS count FROM memberships
      WHERE user_id = ${USER}::uuid
    `;
    const organizations = await database.$queryRaw<Array<{ count: bigint }>>`
      SELECT count(*) AS count FROM organizations
      WHERE id IN (${ORG_A}::uuid, ${ORG_B}::uuid)
    `;
    const users = await database.$queryRaw<Array<{ count: bigint }>>`
      SELECT count(*) AS count FROM users WHERE id = ${USER}::uuid
    `;

    expect(Number(memberships[0]?.count)).toBe(0);
    expect(Number(organizations[0]?.count)).toBe(0);
    expect(Number(users[0]?.count)).toBe(0);
  });
});
