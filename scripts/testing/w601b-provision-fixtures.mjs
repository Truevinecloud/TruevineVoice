/**
 * Provisions synthetic W6-01B browser-acceptance fixtures.
 *
 * This script refuses every target except the dedicated loopback database
 * `truevine_w601b_qa`. It never overwrites an existing password; generated
 * credentials are written only to the gitignored, owner-only `.qa-credentials`
 * directory. The fixture manifest deliberately contains no password or hash.
 */

import { randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, existsSync, lstatSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { hashPassword } from '@truevine/auth/passwords';
import { createDatabaseClient } from '@truevine/database';

import { restrictPath } from '../../infrastructure/scripts/local-qa-credentials.mjs';

const CREDENTIAL_DIRECTORY = resolve(process.cwd(), '.qa-credentials');
const CREDENTIAL_FILE = join(CREDENTIAL_DIRECTORY, 'w601b-qa-credentials.json');
const MANIFEST_FILE = process.env['W601B_MANIFEST_FILE'] ?? '';
const TERMS_VERSION = '2026-10-01';
const RESERVE_MINOR = 1_000n;

const ORG_A = '60000000-0000-4000-8000-000000000001';
const ORG_B = '60000000-0000-4000-8000-000000000002';
const ORG_C = '60000000-0000-4000-8000-000000000003';

const USERS = [
  { key: 'ownerA', email: 'w601b-owner-a@example.invalid', role: 'OWNER', organizationId: ORG_A },
  { key: 'managerA', email: 'w601b-manager-a@example.invalid', role: 'CAMPAIGN_MANAGER', organizationId: ORG_A },
  { key: 'viewerA', email: 'w601b-viewer-a@example.invalid', role: 'VIEWER', organizationId: ORG_A },
  { key: 'ownerB', email: 'w601b-owner-b@example.invalid', role: 'OWNER', organizationId: ORG_B },
  { key: 'ownerC', email: 'w601b-owner-c@example.invalid', role: 'OWNER', organizationId: ORG_C },
  { key: 'operations', email: 'w601b-operations@example.invalid', platformRole: 'OPERATIONS_ADMIN' },
  { key: 'support', email: 'w601b-support@example.invalid', platformRole: 'SUPPORT_ADMIN' },
];

const CAMPAIGNS = [
  {
    key: 'customer',
    id: '70000000-0000-4000-8000-000000000001',
    organizationId: ORG_A,
    name: 'W6-01B customer controls',
    destination: '+256700000001',
  },
  {
    key: 'stop',
    id: '70000000-0000-4000-8000-000000000002',
    organizationId: ORG_A,
    name: 'W6-01B platform stop target',
    destination: '+256700000002',
  },
  {
    key: 'foreign',
    id: '70000000-0000-4000-8000-000000000003',
    organizationId: ORG_B,
    name: 'W6-01B tenant B target',
    destination: '+256700000003',
  },
  {
    key: 'lowBalance',
    id: '70000000-0000-4000-8000-000000000004',
    organizationId: ORG_C,
    name: 'W6-01B low balance',
    destination: '+256700000004',
  },
];

function assertTarget() {
  if (process.env['NODE_ENV'] !== 'development') {
    throw new Error('W6-01B fixture provisioning requires NODE_ENV=development.');
  }
  const source = process.env['DATABASE_URL'] ?? '';
  const url = new URL(source);
  if (
    !['postgres:', 'postgresql:'].includes(url.protocol) ||
    !['localhost', '127.0.0.1', '::1', '[::1]'].includes(url.hostname) ||
    url.port !== '55434' ||
    url.pathname !== '/truevine_w601b_qa' ||
    url.hash ||
    ['host', 'hostaddr', 'port', 'database', 'dbname'].some((key) => url.searchParams.has(key))
  ) {
    throw new Error('W6-01B fixtures refuse every database except truevine_w601b_qa on loopback 55434.');
  }
  if (process.env['EXPECTED_DATABASE_NAME'] !== 'truevine_w601b_qa') {
    throw new Error('W6-01B fixtures require EXPECTED_DATABASE_NAME=truevine_w601b_qa.');
  }
}

function readCredentials() {
  if (!existsSync(CREDENTIAL_FILE)) return {};
  const stat = lstatSync(CREDENTIAL_FILE);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Credential path is not a regular file.');
  const parsed = JSON.parse(readFileSync(CREDENTIAL_FILE, 'utf8'));
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('W6-01B credential store is malformed.');
  }
  return parsed;
}

function writeCredentials(records) {
  mkdirSync(CREDENTIAL_DIRECTORY, { recursive: true, mode: 0o700 });
  restrictPath(CREDENTIAL_DIRECTORY, true);
  const temporary = join(CREDENTIAL_DIRECTORY, `.w601b-qa-credentials.${randomUUID()}.tmp`);
  writeFileSync(temporary, `${JSON.stringify(records, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
    flag: 'wx',
  });
  restrictPath(temporary);
  try {
    if (existsSync(CREDENTIAL_FILE)) rmSync(CREDENTIAL_FILE);
    renameSync(temporary, CREDENTIAL_FILE);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
  restrictPath(CREDENTIAL_FILE);
}

function randomUuid() {
  return randomUUID();
}

function newPassword(existing) {
  let password;
  do {
    password = randomBytes(18).toString('base64url');
  } while (existing.has(password));
  return password;
}

async function main() {
  assertTarget();
  const database = createDatabaseClient(process.env['DATABASE_URL'], { log: [] });
  try {
    const identity = await database.$queryRaw`SELECT current_database()::text AS name`;
    if (identity[0]?.name !== 'truevine_w601b_qa') {
      throw new Error('Connected database does not match the W6-01B QA database.');
    }

    const credentials = readCredentials();
    const existingPasswords = new Set(
      Object.values(credentials)
        .map((record) => record?.password)
        .filter((value) => typeof value === 'string'),
    );
    for (const user of USERS) {
      if (!credentials[user.email]) {
        const now = new Date().toISOString();
        credentials[user.email] = {
          email: user.email,
          password: newPassword(existingPasswords),
          scope: user.platformRole ? 'platform' : 'organization',
          role: user.platformRole ?? user.role,
          organizationSlug: user.organizationId ? `w601b-${user.key}` : '',
          createdAt: now,
          updatedAt: now,
        };
        existingPasswords.add(credentials[user.email].password);
      }
    }
    // Credentials are stored before any database row is written: a lost commit
    // is recoverable, a lost generated password is not.
    writeCredentials(credentials);

    await database.$transaction(async (tx) => {
      for (const [key, organizationId] of [
        ['a', ORG_A],
        ['b', ORG_B],
        ['c', ORG_C],
      ]) {
        await tx.organization.upsert({
          where: { id: organizationId },
          update: {},
          create: {
            id: organizationId,
            slug: `w601b-org-${key}`,
            name: `W6-01B QA Org ${key.toUpperCase()}`,
          },
        });
      }

      const userIds = {};
      for (const user of USERS) {
        const passwordHash = await hashPassword(credentials[user.email].password);
        const row = await tx.user.upsert({
          where: { email: user.email },
          update: {
            status: 'ACTIVE',
            failedLoginCount: 0,
            lockedUntil: null,
            passwordHash,
          },
          create: {
            id: randomUuid(),
            email: user.email,
            passwordHash,
            status: 'ACTIVE',
          },
        });
        userIds[user.key] = row.id;
        await tx.termsAcceptance.upsert({
          where: { userId_termsVersion: { userId: row.id, termsVersion: TERMS_VERSION } },
          update: {},
          create: { userId: row.id, termsVersion: TERMS_VERSION },
        });
        if (user.organizationId) {
          await tx.membership.upsert({
            where: { organizationId_userId: { organizationId: user.organizationId, userId: row.id } },
            update: { role: user.role },
            create: { organizationId: user.organizationId, userId: row.id, role: user.role },
          });
        }
        if (user.platformRole) {
          await tx.platformRoleAssignment.upsert({
            where: { userId: row.id },
            update: { role: user.platformRole, revokedAt: null, grantedByUserId: userIds.operations ?? null },
            create: {
              userId: row.id,
              role: user.platformRole,
              grantedByUserId: userIds.operations ?? null,
            },
          });
        }
      }

      const creatorByOrganization = {
        [ORG_A]: userIds.ownerA,
        [ORG_B]: userIds.ownerB,
        [ORG_C]: userIds.ownerC,
      };
      for (const campaign of CAMPAIGNS) {
        await tx.campaign.upsert({
          where: { organizationId_id: { organizationId: campaign.organizationId, id: campaign.id } },
          update: {},
          create: {
            organizationId: campaign.organizationId,
            id: campaign.id,
            name: campaign.name,
            status: 'ACTIVE',
            createdById: creatorByOrganization[campaign.organizationId],
            dispatchState: 'RUNNING',
            dispatchEpoch: 1,
            retryMaxAttempts: 1,
            retryDelayMinutes: 5,
          },
        });
        const contactId = `80000000-0000-4000-8000-${campaign.id.slice(-12)}`;
        await tx.contact.upsert({
          where: { organizationId_id: { organizationId: campaign.organizationId, id: contactId } },
          update: {},
          create: {
            organizationId: campaign.organizationId,
            id: contactId,
            destination: campaign.destination,
            createdById: creatorByOrganization[campaign.organizationId],
          },
        });
        const recipientId = `90000000-0000-4000-8000-${campaign.id.slice(-12)}`;
        await tx.campaignRecipient.upsert({
          where: { organizationId_id: { organizationId: campaign.organizationId, id: recipientId } },
          update: {},
          create: {
            organizationId: campaign.organizationId,
            id: recipientId,
            campaignId: campaign.id,
            contactId,
            destination: campaign.destination,
          },
        });
        await tx.campaignExecution.upsert({
          where: { organizationId_campaignId: { organizationId: campaign.organizationId, campaignId: campaign.id } },
          update: {},
          create: {
            organizationId: campaign.organizationId,
            id: randomUuid(),
            campaignId: campaign.id,
          },
        });
      }

      const walletId = 'b0000000-0000-4000-8000-000000000001';
      await tx.walletEntry.upsert({
        where: { organizationId_id: { organizationId: ORG_A, id: walletId } },
        update: {},
        create: {
          organizationId: ORG_A,
          id: walletId,
          amountMinor: 20_000n,
          currency: 'UGX',
          reference: 'w601b-credit-org-a',
          description: 'W6-01B synthetic acceptance credit',
        },
      });
      const lowWalletId = 'b0000000-0000-4000-8000-000000000002';
      await tx.walletEntry.upsert({
        where: { organizationId_id: { organizationId: ORG_C, id: lowWalletId } },
        update: {},
        create: {
          organizationId: ORG_C,
          id: lowWalletId,
          amountMinor: 500n,
          currency: 'UGX',
          reference: 'w601b-credit-org-c-low',
          description: 'W6-01B synthetic low-balance credit',
        },
      });
    }, { isolationLevel: 'Serializable', timeout: 120_000 });

    const manifest = {
      database: 'truevine_w601b_qa',
      redis: 'redis://127.0.0.1:56384/0',
      syntheticReserveMinor: RESERVE_MINOR.toString(),
      organizations: { A: ORG_A, B: ORG_B, C: ORG_C },
      accounts: USERS.map(({ key, email, role, platformRole, organizationId }) => ({
        key,
        email,
        organizationRole: role ?? null,
        platformRole: platformRole ?? null,
        organizationId: organizationId ?? null,
      })),
      campaigns: CAMPAIGNS.map(({ key, id, organizationId, name, destination }) => ({
        key,
        id,
        organizationId,
        name,
        destination,
      })),
      credentialFile: '.qa-credentials/w601b-qa-credentials.json (gitignored, owner-only)',
    };
    if (MANIFEST_FILE) {
      writeFileSync(MANIFEST_FILE, `${JSON.stringify(manifest, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    }
    process.stdout.write(
      `W601B_FIXTURES ${JSON.stringify({ accounts: USERS.length, campaigns: CAMPAIGNS.length, manifestFile: MANIFEST_FILE || null })}\n`,
    );
  } finally {
    await database.$disconnect();
  }
}

main().catch((error) => {
  process.stderr.write(`W6-01B fixture provisioning failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
