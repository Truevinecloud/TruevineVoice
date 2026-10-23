import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { assertKnownAuditAction } from '@truevine/auth';
import { checkPassword, hashPassword, verifyPassword } from '@truevine/auth/passwords';
import { createDatabaseClient } from '@truevine/database';
import { readBootstrapApproval } from './bootstrap-platform-owner.mjs';
import { INVENTORY, validateTarget } from './qa-role-test-kit.mjs';

const SOURCE = 'developer_test_account_seeder';
const SLUG = 'truevoice-testing';

/** Private JSON input only. Never accept passwords in argv or load ambient .env. */
export function validateSeederConfiguration(config, environment) {
  if (environment.TEST_ACCOUNT_SEEDER_ENABLED !== '1') throw new Error('Seeder disabled.');
  // Reuse the strict disposable loopback target contract, not a production override.
  const target = validateTarget({ ...environment, QA_ROLE_KIT_ENABLED: '1' });
  if (config?.version !== 1 || !['seed', 'verify', 'disable'].includes(config.action)) throw new Error('Invalid seeder configuration.');
  if (!config.passwords || Object.keys(config.passwords).length !== INVENTORY.length ||
      Object.keys(config.passwords).some(email => !INVENTORY.some(item => item.email === email))) throw new Error('Exact eleven-account inventory required.');
  for (const account of INVENTORY) {
    if (checkPassword(config.passwords[account.email]) !== undefined) throw new Error('Test password policy rejected.');
  }
  if (new Set(Object.values(config.passwords)).size !== INVENTORY.length) throw new Error('Use a different password for every test account.');
  return target;
}

function validAssignment(user, account, organizationId) {
  return account.scope === 'organization'
    ? !user.platformRole && user.memberships.length === 1 && user.memberships[0].organizationId === organizationId && user.memberships[0].role === account.role
    : user.memberships.length === 0 && user.platformRole?.role === account.role && user.platformRole.revokedAt === null;
}

/** Operator-only, no HTTP endpoint, startup hook, mail sender or activation token. */
export async function runTestAccountSeeder(config, dependencies = {}) {
  const environment = dependencies.environment ?? process.env;
  const target = validateSeederConfiguration(config, environment);
  for (const action of ['test_account.seeded', 'test_account.disabled', 'test_organization.created']) assertKnownAuditAction(action);
  const database = (dependencies.createClient ?? createDatabaseClient)(environment.DATABASE_URL, { log: [] });
  try {
    return await database.$transaction(async tx => {
      const identity = await tx.$queryRaw`SELECT pg_catalog.current_database() AS name`;
      if (identity[0]?.name !== target.name) throw new Error('Connected database mismatch.');
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(712340982)`;
      const preserved = await tx.user.findUnique({ where: { email: 'admin@truevoice.com' },
        select: { status: true, memberships: { select: { role: true, organizationId: true } }, platformRole: { select: { role: true, revokedAt: true } } } });
      const claim = await tx.platformOwnerBootstrap.findUnique({ where: { slot: 'first_platform_owner' } });
      const owner = await tx.user.findUnique({ where: { email: 'qa-platform-owner@example.invalid' }, include: { memberships: true, platformRole: true } });
      const ownerAccount = INVENTORY.find(item => item.role === 'PLATFORM_OWNER');
      if (!owner || claim?.userId !== owner.id || owner.status !== 'ACTIVE' ||
          !validAssignment(owner, ownerAccount) || !(await verifyPassword(owner.passwordHash, config.passwords[owner.email]))) {
        throw new Error('Existing approved bootstrap owner with matching credentials required; no bootstrap or password replacement performed.');
      }
      let organization = await tx.organization.findUnique({ where: { slug: SLUG } });
      if (organization?.suspendedAt) throw new Error('Test organization is suspended.');
      if (organization) {
        const provenance = await tx.identityAuditEvent.findFirst({ where: { action: 'test_organization.created', metadata: { path: ['organizationId'], equals: organization.id } } });
        if (provenance?.metadata?.source !== SOURCE) throw new Error('Existing organization is not owned by this seeder.');
      }
      // Preflight all identities before making any writes. Existing accounts must
      // have immutable seeder provenance, exact scope and matching credentials.
      const accounts = [];
      for (const account of INVENTORY.filter(item => item.role !== 'PLATFORM_OWNER')) {
        const user = await tx.user.findUnique({ where: { email: account.email }, include: { memberships: true, platformRole: true } });
        if (user) {
          const event = await tx.identityAuditEvent.findFirst({ where: { action: 'test_account.seeded',
            metadata: { path: ['targetUserId'], equals: user.id } } });
          if (!event || event.metadata.source !== SOURCE || !organization ||
              !validAssignment(user, account, organization.id) ||
              !['ACTIVE', ...(config.action === 'disable' ? ['SUSPENDED'] : [])].includes(user.status) ||
              !(await verifyPassword(user.passwordHash, config.passwords[account.email]))) throw new Error('Existing account conflict; no changes authorized.');
        } else if (config.action === 'verify') throw new Error('Missing test account.');
        accounts.push({ account, user });
      }
      if (!organization && config.action === 'seed') {
        organization = await tx.organization.create({ data: { slug: SLUG, name: SLUG } });
        await tx.identityAuditEvent.create({ data: { actorUserId: owner.id, action: 'test_organization.created', outcome: 'SUCCESS', metadata: { source: SOURCE, organizationId: organization.id } } });
      }
      const report = [{ email: owner.email, role: 'PLATFORM_OWNER', status: 'preserved', passwordVerified: true }];
      for (const { account, user } of accounts) {
        if (config.action === 'disable') {
          if (!user) { report.push({ email: account.email, role: account.role, status: 'absent' }); continue; }
          if (user.status === 'ACTIVE') {
            const now = new Date();
            await tx.user.update({ where: { id: user.id }, data: { status: 'SUSPENDED' } });
            await tx.session.updateMany({ where: { userId: user.id, revokedAt: null }, data: { revokedAt: now, revokedReason: 'test_account_disabled' } });
            await tx.passwordResetToken.updateMany({ where: { userId: user.id, usedAt: null }, data: { expiresAt: now } });
            await tx.identityAuditEvent.create({ data: { actorUserId: owner.id, action: 'test_account.disabled', outcome: 'SUCCESS', metadata: { source: SOURCE, targetUserId: user.id, role: account.role } } });
          }
          report.push({ email: account.email, role: account.role, status: 'disabled', passwordVerified: false });
          continue;
        }
        if (!user) {
          const userId = randomUUID();
          await tx.user.create({ data: { id: userId, email: account.email, passwordHash: await hashPassword(config.passwords[account.email]) } });
          if (account.scope === 'organization') {
            await tx.membership.create({ data: { userId, organizationId: organization.id, role: account.role } });
          } else {
            await tx.platformRoleAssignment.create({ data: { userId, role: account.role, grantedByUserId: owner.id } });
          }
          await tx.identityAuditEvent.create({ data: { actorUserId: owner.id, action: 'test_account.seeded', outcome: 'SUCCESS', metadata: { source: SOURCE, targetUserId: userId, role: account.role, organizationId: account.scope === 'organization' ? organization.id : null } } });
        }
        report.push({ email: account.email, role: account.role, status: user ? 'unchanged' : 'created', passwordVerified: true });
      }
      return { existingQaOwner: preserved ?? 'absent-in-isolated-database', accounts: report };
    }, { isolationLevel: 'Serializable', timeout: 120000 });
  } finally { await database.$disconnect(); }
}

export async function main(argv = process.argv.slice(2)) {
  try {
    if (process.env.TEST_ACCOUNT_SEEDER_ENABLED !== '1') throw new Error('Disabled.');
    if (argv.length !== 3 || !['seed', 'verify', 'disable'].includes(argv[0]) || argv[1] !== '--config') throw new Error('Invalid arguments.');
    const config = readBootstrapApproval(argv[2]);
    if (config.action !== argv[0]) throw new Error('Action mismatch.');
    const result = await runTestAccountSeeder(config);
    // Only non-secret outcome data. No exception object, password or hash output.
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch {
    process.stderr.write('Test account seeder refused or failed. No success claimed; reconcile securely before retrying.\n');
    process.exitCode = 1;
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main();
