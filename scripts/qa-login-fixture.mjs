/**
 * Development-only QA login fixture.
 *
 * Ensures the four local QA login accounts exist in the database named by
 * DATABASE_URL, each with a known password, the correct role, accepted terms
 * and an unlocked ACTIVE status. Idempotent: re-running only refreshes the
 * password hash / lockout counters and never creates duplicate rows.
 *
 * Passwords are read from the environment, never hardcoded here:
 *   QA_OWNER_PASSWORD, QA_VIEWER_PASSWORD,
 *   QA_PLATFORM_OWNER_PASSWORD, QA_SUPPORT_ADMIN_PASSWORD
 *
 * This is local operator tooling for a disposable development database, in the
 * same spirit as scripts/seed-test-accounts.mjs and create-qa-fixture.mjs.
 */

import process from 'node:process';
import { URL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { hashPassword } from '@truevine/auth/passwords';
import { createDatabaseClient } from '@truevine/database';

const TERMS_VERSION = '2026-10-01';
const DEV_ORG_SLUG = 'truevoice-demo';

const DATABASE_URL = process.env.DATABASE_URL?.trim();
if (!DATABASE_URL) throw new Error('Missing required environment variable: DATABASE_URL');

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

const ACCOUNTS = [
  { email: 'qa-owner@truevoice.com', password: required('QA_OWNER_PASSWORD'), kind: 'org', role: 'OWNER' },
  { email: 'qa-viewer@truevoice.com', password: required('QA_VIEWER_PASSWORD'), kind: 'org', role: 'VIEWER' },
  {
    email: 'qa-platform-owner@truevoice.com',
    password: required('QA_PLATFORM_OWNER_PASSWORD'),
    kind: 'platform',
    role: 'PLATFORM_OWNER',
  },
  {
    email: 'qa-support-admin@truevoice.com',
    password: required('QA_SUPPORT_ADMIN_PASSWORD'),
    kind: 'platform',
    role: 'SUPPORT_ADMIN',
  },
];

const db = createDatabaseClient(DATABASE_URL, { log: [] });

async function upsertUser(email, passwordHash) {
  const existing = await db.user.findUnique({ where: { email }, select: { id: true } });
  if (existing) {
    await db.user.update({
      where: { id: existing.id },
      data: {
        passwordHash,
        status: 'ACTIVE',
        failedLoginCount: 0,
        lockedUntil: null,
        passwordChangedAt: new Date(),
      },
    });
    return existing.id;
  }
  const id = randomUUID();
  await db.user.create({ data: { id, email, passwordHash, status: 'ACTIVE' } });
  return id;
}

async function ensureOrg() {
  const existing = await db.organization.findUnique({
    where: { slug: DEV_ORG_SLUG },
    select: { id: true },
  });
  if (existing) return existing.id;
  const id = randomUUID();
  await db.organization.create({ data: { id, slug: DEV_ORG_SLUG, name: 'Truevoice Demo' } });
  return id;
}

async function upsertMembership(organizationId, userId, role) {
  await db.membership.upsert({
    where: { organizationId_userId: { organizationId, userId } },
    update: { role },
    create: { organizationId, userId, role },
  });
}

async function upsertPlatformRole(userId, role, grantedByUserId) {
  await db.platformRoleAssignment.upsert({
    where: { userId },
    update: { role, grantedByUserId, revokedAt: null },
    create: { userId, role, grantedByUserId },
  });
}

async function ensureTerms(userId) {
  await db.termsAcceptance.upsert({
    where: { userId_termsVersion: { userId, termsVersion: TERMS_VERSION } },
    update: {},
    create: { userId, termsVersion: TERMS_VERSION },
  });
}

async function main() {
  const dbName = new URL(DATABASE_URL).pathname.replace(/^\//, '').split('?')[0];
  process.stdout.write(`Target database: ${dbName}\n`);

  const organizationId = await ensureOrg();
  let platformOwnerId = null;

  // First pass: create/update every user so cross-references resolve.
  const ids = new Map();
  for (const account of ACCOUNTS) {
    const passwordHash = await hashPassword(account.password);
    const id = await upsertUser(account.email, passwordHash);
    ids.set(account.email, id);
    await ensureTerms(id);
    if (account.role === 'PLATFORM_OWNER') platformOwnerId = id;
  }

  // Second pass: apply tenant / platform roles.
  for (const account of ACCOUNTS) {
    const userId = ids.get(account.email);
    if (account.kind === 'org') {
      await upsertMembership(organizationId, userId, account.role);
    } else {
      await upsertPlatformRole(userId, account.role, platformOwnerId);
    }
  }

  process.stdout.write('\n=== VERIFICATION ===\n');
  for (const account of ACCOUNTS) {
    const row = await db.user.findUnique({
      where: { email: account.email },
      include: { memberships: true, platformRole: true, termsAcceptances: true },
    });
    const membership = row?.memberships.map((m) => `${m.role}@${m.organizationId}`).join(',') || '-';
    const platformRole = row?.platformRole?.role || '-';
    const terms = row?.termsAcceptances.some((t) => t.termsVersion === TERMS_VERSION) ? 'yes' : 'no';
    process.stdout.write(
      `${row?.email} | status=${row?.status} | failed=${row?.failedLoginCount} | org=[${membership}] | platform=${platformRole} | terms=${terms}\n`,
    );
  }

  await db.$disconnect();
  process.stdout.write('\nQA login fixture complete.\n');
}

main().catch((error) => {
  process.stderr.write(`QA login fixture failed: ${error?.stack ?? error}\n`);
  process.exit(1);
});