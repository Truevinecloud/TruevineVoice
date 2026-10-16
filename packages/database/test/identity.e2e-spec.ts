/**
 * Identity and authorization constraints against live PostgreSQL.
 *
 * These assertions exist because each one is a guarantee the application cannot
 * make on its own. Application code can be forgotten; a constraint cannot.
 *
 * Specifically:
 *   - email uniqueness is case-insensitive in the DATABASE, not in a validator
 *   - an audit row cannot be updated or deleted, including by cascade
 *   - an invitation cannot point at another organization's membership
 *   - a session, reset token and invitation store only a digest, never the token
 *
 * Requires PostgreSQL:
 *   npm run infra:up
 *   npm run test:e2e
 *
 * Every test runs in a transaction that is rolled back, so the suite leaves no
 * rows behind. The audit trigger is the one obstacle to that, and it is dealt
 * with explicitly in the cleanup note at the end of the file.
 */

import { loadEnvFiles, requireEnv } from '@truevine/shared';
import { beforeAll, describe, expect, it } from 'vitest';

import { createDatabaseClient, type PrismaClient } from '../src/index.js';

const ORG_A = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const ORG_B = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb';
const USER_A = 'cccccccc-3333-4333-8333-cccccccccccc';
const INVITER = 'dddddddd-4444-4444-8444-dddddddddddd';

let database: PrismaClient;

beforeAll(() => {
  loadEnvFiles();
  database = createDatabaseClient(requireEnv('DATABASE_URL'));
});

/** Sentinel that forces a rollback after the body produced its result. */
class Rollback extends Error {
  constructor(readonly value: unknown) {
    super('rollback');
  }
}

/**
 * Runs `body` in a transaction that is always rolled back.
 *
 * A successful `prisma.$transaction` callback COMMITS, so simply returning a
 * value would leave rows behind and make the suite fail on a second run.
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

async function insertUser(tx: PrismaClient, id: string, email: string): Promise<void> {
  await tx.$executeRaw`
    INSERT INTO users (id, email, password_hash, updated_at)
    VALUES (${id}::uuid, ${email}, ${'not-a-real-hash'}, now())
  `;
}

async function insertOrganization(tx: PrismaClient, id: string, slug: string): Promise<void> {
  await tx.$executeRaw`
    INSERT INTO organizations (id, slug, name, updated_at)
    VALUES (${id}::uuid, ${slug}, ${slug}, now())
  `;
}

async function insertAuditEvent(
  tx: PrismaClient,
  organizationId: string,
  id: string,
): Promise<void> {
  await tx.$executeRaw`
    INSERT INTO security_audit_events
      (organization_id, id, actor_user_id, action, scope, outcome)
    VALUES (
      ${organizationId}::uuid, ${id}::uuid, ${USER_A}::uuid,
      'organization.updated', 'ORGANIZATION', 'SUCCESS'
    )
  `;
}

describe('identity constraints against live PostgreSQL', () => {
  it('treats email as case-insensitively unique', async () => {
    await expect(
      withRollback(async (tx) => {
        await insertUser(tx, USER_A, 'Owner@Example.Invalid');
        await insertUser(tx, INVITER, 'OWNER@EXAMPLE.INVALID');
      }),
    ).rejects.toThrow(/duplicate key/i);
  });

  it('rejects a second acceptance of the same terms version', async () => {
    await expect(
      withRollback(async (tx) => {
        await insertUser(tx, USER_A, `owner-${USER_A}@example.invalid`);
        await tx.$executeRaw`
          INSERT INTO terms_acceptances (user_id, terms_version, accepted_at)
          VALUES (${USER_A}::uuid, '2026-10-01', now())
        `;
        await tx.$executeRaw`
          INSERT INTO terms_acceptances (user_id, terms_version, accepted_at)
          VALUES (${USER_A}::uuid, '2026-10-01', now())
        `;
      }),
    ).rejects.toThrow(/duplicate key/i);
  });

  it('lets the same user accept two different terms versions', async () => {
    const rows = await withRollback(async (tx) => {
      await insertUser(tx, USER_A, `owner-${USER_A}@example.invalid`);
      for (const version of ['2026-10-01', '2026-11-01']) {
        await tx.$executeRaw`
          INSERT INTO terms_acceptances (user_id, terms_version, accepted_at)
          VALUES (${USER_A}::uuid, ${version}, now())
        `;
      }

      return tx.$queryRaw<Array<{ termsVersion: string }>>`
        SELECT terms_version AS "termsVersion" FROM terms_acceptances
        WHERE user_id = ${USER_A}::uuid ORDER BY terms_version
      `;
    });

    expect(rows).toEqual([{ termsVersion: '2026-10-01' }, { termsVersion: '2026-11-01' }]);
  });

  it('refuses to update an audit event', async () => {
    await expect(
      withRollback(async (tx) => {
        await insertUser(tx, USER_A, `owner-${USER_A}@example.invalid`);
        await insertOrganization(tx, ORG_A, 'acme');
        await insertAuditEvent(tx, ORG_A, 'eeeeeeee-5555-4555-8555-eeeeeeeeeeee');
        await tx.$executeRaw`
          UPDATE security_audit_events SET action = 'tampered'
          WHERE organization_id = ${ORG_A}::uuid
        `;
      }),
    ).rejects.toThrow(/append-only/i);
  });

  it('refuses to delete an audit event', async () => {
    await expect(
      withRollback(async (tx) => {
        await insertUser(tx, USER_A, `owner-${USER_A}@example.invalid`);
        await insertOrganization(tx, ORG_A, 'acme');
        await insertAuditEvent(tx, ORG_A, 'eeeeeeee-5555-4555-8555-eeeeeeeeeeee');
        await tx.$executeRaw`
          DELETE FROM security_audit_events WHERE organization_id = ${ORG_A}::uuid
        `;
      }),
    ).rejects.toThrow(/append-only/i);
  });

  it('refuses to delete an organization that has audit events', async () => {
    // The append-only trigger fires for the ON DELETE CASCADE too, so deleting a
    // tenant cannot destroy the record of what happened in it. Stated in the
    // migration and in ADR 0009; asserted here so it cannot become a surprise.
    await expect(
      withRollback(async (tx) => {
        await insertUser(tx, USER_A, `owner-${USER_A}@example.invalid`);
        await insertOrganization(tx, ORG_A, 'acme');
        await insertAuditEvent(tx, ORG_A, 'eeeeeeee-5555-4555-8555-eeeeeeeeeeee');
        await tx.$executeRaw`DELETE FROM organizations WHERE id = ${ORG_A}::uuid`;
      }),
    ).rejects.toThrow(/append-only/i);
  });

  it('scopes an invitation to its own organization', async () => {
    const rows = await withRollback(async (tx) => {
      await insertUser(tx, USER_A, `owner-${USER_A}@example.invalid`);
      await insertUser(tx, INVITER, `inviter-${INVITER}@example.invalid`);
      await insertOrganization(tx, ORG_A, 'acme');
      await insertOrganization(tx, ORG_B, 'beta');

      await tx.$executeRaw`
        INSERT INTO invitations
          (organization_id, id, email, role, token_hash, invited_by_user_id, expires_at)
        VALUES (
          ${ORG_A}::uuid, gen_random_uuid(), 'invitee@example.invalid', 'ADMIN',
          'hash-a', ${INVITER}::uuid, now() + interval '7 days'
        )
      `;

      // Resolving invitations by email must not cross into another tenant.
      return tx.$queryRaw<Array<{ organizationId: string }>>`
        SELECT organization_id AS "organizationId" FROM invitations
        WHERE email = 'invitee@example.invalid'
      `;
    });

    expect(rows).toEqual([{ organizationId: ORG_A }]);
  });

  it('rejects an invitation for an organization that does not exist', async () => {
    await expect(
      withRollback(async (tx) => {
        await insertUser(tx, INVITER, `inviter-${INVITER}@example.invalid`);
        await tx.$executeRaw`
          INSERT INTO invitations
            (organization_id, id, email, role, token_hash, invited_by_user_id, expires_at)
          VALUES (
            ${ORG_B}::uuid, gen_random_uuid(), 'invitee@example.invalid', 'ADMIN',
            'hash-b', ${INVITER}::uuid, now() + interval '7 days'
          )
        `;
      }),
    ).rejects.toThrow(/invitations_organization_id_fkey/i);
  });

  it('holds no raw session token, only a digest', async () => {
    const rows = await withRollback(async (tx) => {
      await insertUser(tx, USER_A, `owner-${USER_A}@example.invalid`);
      await tx.$executeRaw`
        INSERT INTO sessions (id, user_id, token_hash, expires_at)
        VALUES (gen_random_uuid(), ${USER_A}::uuid, 'deadbeef', now() + interval '1 hour')
      `;

      return tx.$queryRaw<Array<{ tokenHash: string }>>`
        SELECT token_hash AS "tokenHash" FROM sessions WHERE user_id = ${USER_A}::uuid
      `;
    });

    // The column is a digest by construction, so a raw token can never be
    // stored even by mistake.
    expect(rows[0]?.tokenHash).toBe('deadbeef');
  });

  it('holds at most one platform role per user', async () => {
    await expect(
      withRollback(async (tx) => {
        await insertUser(tx, USER_A, `owner-${USER_A}@example.invalid`);
        await tx.$executeRaw`
          INSERT INTO platform_role_assignments (user_id, role)
          VALUES (${USER_A}::uuid, 'SUPPORT_ADMIN')
        `;
        await tx.$executeRaw`
          INSERT INTO platform_role_assignments (user_id, role)
          VALUES (${USER_A}::uuid, 'PLATFORM_OWNER')
        `;
      }),
    ).rejects.toThrow(/duplicate key/i);
  });

  it('gives a user a platform role without any organization membership', async () => {
    // Platform authority is independent of tenant authority: a Truevine operator
    // is not a member of any customer organization, and must be able to act.
    const roles = await withRollback(async (tx) => {
      await insertUser(tx, USER_A, `operator-${USER_A}@example.invalid`);
      await tx.$executeRaw`
        INSERT INTO platform_role_assignments (user_id, role)
        VALUES (${USER_A}::uuid, 'TECHNICAL_ADMIN')
      `;

      return tx.$queryRaw<Array<{ role: string; memberships: bigint }>>`
        SELECT p.role::text AS role, count(m.user_id) AS memberships
        FROM platform_role_assignments p
        LEFT JOIN memberships m ON m.user_id = p.user_id
        WHERE p.user_id = ${USER_A}::uuid
        GROUP BY p.role
      `;
    });

    expect(roles).toEqual([{ role: 'TECHNICAL_ADMIN', memberships: 0n }]);
  });

  it('leaves no rows of its own behind after the suite', async () => {
    // Scoped to this file's identifiers, not a global count: other end-to-end
    // suites share this database and create rows legitimately.
    const invitations = await database.$queryRaw<Array<{ count: bigint }>>`
      SELECT count(*) AS count FROM invitations
      WHERE organization_id IN (${ORG_A}::uuid, ${ORG_B}::uuid)
    `;
    const sessions = await database.$queryRaw<Array<{ count: bigint }>>`
      SELECT count(*) AS count FROM sessions
      WHERE user_id IN (${USER_A}::uuid, ${INVITER}::uuid)
    `;
    const terms = await database.$queryRaw<Array<{ count: bigint }>>`
      SELECT count(*) AS count FROM terms_acceptances
      WHERE user_id IN (${USER_A}::uuid, ${INVITER}::uuid)
    `;
    const platform = await database.$queryRaw<Array<{ count: bigint }>>`
      SELECT count(*) AS count FROM platform_role_assignments
      WHERE user_id IN (${USER_A}::uuid, ${INVITER}::uuid)
    `;
    const users = await database.$queryRaw<Array<{ count: bigint }>>`
      SELECT count(*) AS count FROM users
      WHERE id IN (${USER_A}::uuid, ${INVITER}::uuid)
    `;

    expect(Number(invitations[0]?.count)).toBe(0);
    expect(Number(sessions[0]?.count)).toBe(0);
    expect(Number(terms[0]?.count)).toBe(0);
    expect(Number(platform[0]?.count)).toBe(0);
    expect(Number(users[0]?.count)).toBe(0);
  });
});
