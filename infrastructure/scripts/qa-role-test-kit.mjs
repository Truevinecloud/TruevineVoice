import { randomBytes, randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { assertKnownAuditAction, generateToken, hashToken, PASSWORD_RESET_TTL_MS, ORGANIZATION_ROLES, PLATFORM_ROLES } from '@truevine/auth';
import { hashPassword } from '@truevine/auth/passwords';
import { createDatabaseClient } from '@truevine/database';
import { prepareBootstrapArtifact } from './bootstrap-platform-owner.mjs';

export const INVENTORY = [
  ...ORGANIZATION_ROLES.map(role => ({ scope: 'organization', role, email: `qa-${role.toLowerCase().replaceAll('_', '-')}@example.invalid` })),
  ...PLATFORM_ROLES.map(role => ({ scope: 'platform', role, email: `qa-${role.toLowerCase().replaceAll('_', '-')}@example.invalid` })),
];
const SLUG = 'qa-role-test-kit';

/** No ambient .env loading; only an explicitly configured isolated loopback DB. */
export function validateTarget(env) {
  if (env.NODE_ENV !== 'test' || env.QA_ROLE_KIT_ENABLED !== '1') throw new Error('Explicit test opt-in required.');
  const url = new URL(env.DATABASE_URL);
  const name = decodeURIComponent(url.pathname.slice(1));
  if (!['postgres:', 'postgresql:'].includes(url.protocol) ||
      !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) ||
      !/^truevine_bootstrap_test_[a-f0-9]{16}$/.test(name) || url.search || url.hash) {
    throw new Error('Isolated loopback bootstrap test database required; URL options forbidden.');
  }
  const origin = new URL(env.WEB_PUBLIC_URL);
  if (origin.protocol !== 'https:' || !['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname) ||
      origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash) {
    throw new Error('Loopback HTTPS test application origin required.');
  }
  return { name, origin: origin.origin };
}

/** Existing identities are verified, never repaired or reactivated. */
export async function provisionRoleKit(options, dependencies = {}) {
  const env = dependencies.environment ?? process.env;
  const target = validateTarget(env);
  assertKnownAuditAction('qa.role_account.provisioned');
  const db = (dependencies.createClient ?? createDatabaseClient)(env.DATABASE_URL, { log: [] });
  try {
    return await db.$transaction(async tx => {
      const identity = await tx.$queryRaw`SELECT pg_catalog.current_database() AS name`;
      if (identity[0]?.name !== target.name) throw new Error('Connected database mismatch.');
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(712340981)`;
      const claim = await tx.platformOwnerBootstrap.findUnique({ where: { slot: 'first_platform_owner' } });
      const owner = await tx.user.findUnique({ where: { email: 'qa-platform-owner@example.invalid' }, include: { platformRole: true } });
      if (!owner || claim?.userId !== owner.id || owner.status !== 'ACTIVE' ||
          owner.platformRole?.role !== 'PLATFORM_OWNER' || owner.platformRole.revokedAt) {
        throw new Error('Bootstrap the isolated QA Platform Owner using the existing approved mechanism first.');
      }
      const org = await tx.organization.upsert({ where: { slug: SLUG }, update: {}, create: { slug: SLUG, name: 'QA Role Test Kit' } });
      if (org.suspendedAt) throw new Error('QA organization suspended; refusing repair.');
      const result = [];
      for (const account of INVENTORY) {
        const existing = await tx.user.findUnique({ where: { email: account.email }, include: { memberships: true, platformRole: true } });
        if (existing) {
          const valid = account.scope === 'organization'
            ? !existing.platformRole && existing.memberships.length === 1 && existing.memberships[0].organizationId === org.id && existing.memberships[0].role === account.role
            : existing.memberships.length === 0 && existing.platformRole?.role === account.role && !existing.platformRole.revokedAt;
          if (!valid || existing.status !== 'ACTIVE') throw new Error('Existing QA identity differs; refusing changes.');
          result.push({ ...account, status: 'unchanged' });
          continue;
        }
        const userId = randomUUID();
        const raw = generateToken();
        const expiresAt = new Date(Date.now() + PASSWORD_RESET_TTL_MS);
        (dependencies.prepareArtifact ?? prepareBootstrapArtifact)(options.directory, randomUUID(), {
          kit: SLUG, email: account.email, role: account.role, expiresAt: expiresAt.toISOString(),
          activationUrl: `${target.origin}/set-password?token=${encodeURIComponent(raw)}`,
        });
        await tx.user.create({ data: { id: userId, email: account.email,
          passwordHash: await (dependencies.hashPassword ?? hashPassword)(randomBytes(32).toString('base64url')) } });
        if (account.scope === 'organization') {
          await tx.membership.create({ data: { organizationId: org.id, userId, role: account.role } });
        } else {
          await tx.platformRoleAssignment.create({ data: { userId, role: account.role, grantedByUserId: owner.id } });
        }
        await tx.passwordResetToken.create({ data: { userId, tokenHash: hashToken(raw), expiresAt } });
        await tx.identityAuditEvent.create({ data: { actorUserId: owner.id, action: 'qa.role_account.provisioned', outcome: 'SUCCESS',
          metadata: { source: SLUG, actorKind: 'local_operator', targetUserId: userId, role: account.role, organizationId: account.scope === 'organization' ? org.id : null } } });
        result.push({ ...account, status: 'created' });
      }
      return result;
    }, { isolationLevel: 'Serializable', timeout: 120000 });
  } finally {
    // Retain private artifacts even on error: a lost commit acknowledgement is
    // ambiguous. Reconcile DB identities before delivery; never regenerate here.
    await db.$disconnect();
  }
}

export async function main(argv = process.argv.slice(2)) {
  try {
    if (argv.length !== 2 || argv[0] !== '--activation-directory') throw new Error('Invalid arguments.');
    const result = await provisionRoleKit({ directory: argv[1] });
    process.stdout.write(`QA inventory verified: ${result.length} roles. Deliver private artifacts only after reconciliation.\n`);
  } catch {
    process.stderr.write('QA role kit failed. Reconcile private artifacts and database state securely; no success claimed.\n');
    process.exitCode = 1;
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main();
