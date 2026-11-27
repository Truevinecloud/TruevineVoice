/**
 * Explicitly approved, local-only PLATFORM_OWNER grant in the development DB.
 *
 * This exists because the normal first-owner bootstrap is Linux-only and
 * deliberately refuses `truevine_voice`. It never touches an existing account,
 * organization, membership, bootstrap claim or credential. It creates one new
 * synthetic operator, records the operator approval in the immutable identity
 * audit trail, and verifies a real sign-in plus access to the settings API.
 *
 * The explicit CLI approval flag and reference are mandatory. No credential,
 * token or hash is ever printed. Idempotent: a matching existing account is
 * only verified, never modified.
 */

import { randomBytes, randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { assertKnownAuditAction, isSafeAuditMetadata } from '@truevine/auth';
import { checkPassword, hashPassword, verifyPassword } from '@truevine/auth/passwords';
import { createDatabaseClient } from '@truevine/database';
import { loadEnvFiles } from '@truevine/shared';

import { assertLocalProxyUrl, postJson, signIn } from './local-qa-http.mjs';
import { readCredentials, writeCredentials } from './local-qa-credentials.mjs';

export const ACCOUNT_EMAIL = 'qa-super-admin@example.invalid';
export const DATABASE_NAME = 'truevine_voice';
export const ROLE = 'PLATFORM_OWNER';
export const AUDIT_ACTION = 'platform.admin.role_granted';
export const DEFAULT_API_BASE_URL = 'http://localhost:3000/api';
export const DEFAULT_ADMIN_API_BASE_URL = 'http://localhost:3002/admin/api';
export const APPROVAL_FLAG = '--approve-local-platform-owner-grant';
const APPROVAL_REFERENCE_PATTERN = /^[A-Z][A-Z0-9_-]{2,63}$/;

/** Requires an explicit, non-default approval flag and references. */
export function parseArguments(argv) {
  if (!argv.includes(APPROVAL_FLAG)) {
    throw new Error('Explicit local platform-owner approval is required.');
  }
  const reference = optionValue(argv, '--approval-reference');
  const operator = optionValue(argv, '--operator-reference');
  if (!APPROVAL_REFERENCE_PATTERN.test(reference) || !APPROVAL_REFERENCE_PATTERN.test(operator)) {
    throw new Error('Approval and operator references are required.');
  }
  return { approved: true, approvalReference: reference, operatorReference: operator };
}

function optionValue(argv, name) {
  const index = argv.indexOf(name);
  if (index === -1 || index + 1 >= argv.length) throw new Error(`${name} requires a value.`);
  return argv[index + 1];
}

/** Fails closed unless the target is the local development database. */
export function validateTarget(env) {
  if (env['NODE_ENV'] !== 'development') {
    throw new Error('Local platform-owner grant requires NODE_ENV=development.');
  }
  if (env['LOCAL_QA_PROVISIONING_ENABLED'] !== 'true') {
    throw new Error('Local platform-owner grant requires LOCAL_QA_PROVISIONING_ENABLED=true.');
  }
  const url = new URL(env['DATABASE_URL'] ?? '');
  if (!['postgres:', 'postgresql:'].includes(url.protocol)) {
    throw new Error('A PostgreSQL DATABASE_URL is required.');
  }
  if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) {
    throw new Error('Local platform-owner grant requires a loopback database host.');
  }
  if (url.hash) throw new Error('DATABASE_URL fragments are not accepted.');
  if (decodeURIComponent(url.pathname) !== `/${DATABASE_NAME}`) {
    throw new Error(`Local platform-owner grant requires database ${DATABASE_NAME}.`);
  }
  const parameters = [...url.searchParams.keys()];
  if (
    parameters.some((key) => key !== 'schema') ||
    (url.searchParams.has('schema') && url.searchParams.get('schema') !== 'public')
  ) {
    throw new Error('DATABASE_URL contains unsupported query options.');
  }
  return { name: DATABASE_NAME };
}

/** Fresh, policy-valid password that differs from every stored QA password. */
export function generateOwnerPassword(existingPasswords = []) {
  let password;
  do {
    password = randomBytes(24).toString('base64url');
  } while (existingPasswords.includes(password));
  const problem = checkPassword(password);
  if (problem) throw new Error(`Generated password rejected by policy: ${problem}`);
  return password;
}

/** Guards against driving a non-loopback admin proxy during verification. */
export function assertLocalAdminProxyUrl(baseUrl) {
  const parsed = new URL(baseUrl);
  if (
    parsed.protocol !== 'http:' ||
    !['localhost', '127.0.0.1'].includes(parsed.hostname) ||
    parsed.port !== '3002' ||
    parsed.pathname.replace(/\/$/, '') !== '/admin/api'
  ) {
    throw new Error('Settings verification must target http://localhost:3002/admin/api.');
  }
}

/** Reads a protected platform API route with the verified session jar. */
async function getJson(fetchImpl, baseUrl, path, jar) {
  const cookie = [...jar.entries()].map(([name, value]) => `${name}=${value}`).join('; ');
  return fetchImpl(`${baseUrl}${path}`, {
    method: 'GET',
    headers: { accept: 'application/json', cookie },
    redirect: 'manual',
    cache: 'no-store',
  });
}

/** Verifies the final database state and a real authenticated settings read. */
async function verifyAccount(database, password, fetchImpl, baseUrl, adminBaseUrl) {
  const user = await database.user.findUnique({
    where: { email: ACCOUNT_EMAIL },
    include: { platformRole: true },
  });
  if (!user || user.status !== 'ACTIVE' || user.platformRole?.role !== ROLE ||
      user.platformRole.revokedAt !== null) {
    throw new Error('Platform owner account is missing, inactive or mis-roled.');
  }
  if (!(await verifyPassword(user.passwordHash, password))) {
    throw new Error('Stored password does not match the private credential file.');
  }

  const { jar } = await signIn(fetchImpl, baseUrl, ACCOUNT_EMAIL, password);

  // Use the real application endpoint so the acceptance is recorded normally.
  const accepted = await postJson(fetchImpl, baseUrl, '/auth/terms/accept', {}, jar);
  if (!accepted.ok) throw new Error(`Terms acceptance refused with status ${accepted.status}.`);

  const settings = await getJson(fetchImpl, adminBaseUrl, '/platform/payments/me', jar);
  if (!settings.ok) throw new Error(`Settings access refused with status ${settings.status}.`);
  return { loginVerified: true, settingsVerified: true };
}

/**
 * Grants the single local platform owner if absent, or verifies it if present.
 * Dependencies are injected so the flow is testable without a live database.
 */
export async function grantLocalPlatformOwner(options = {}, dependencies = {}) {
  const environment = dependencies.environment ?? process.env;
  const approval = options.approval ?? parseArguments([]);
  const target = validateTarget(environment);
  assertKnownAuditAction(AUDIT_ACTION);

  const readStore = dependencies.readCredentials ?? readCredentials;
  const writeStore = dependencies.writeCredentials ?? writeCredentials;
  const hash = dependencies.hashPassword ?? hashPassword;
  const createClient = dependencies.createDatabaseClient ?? createDatabaseClient;
  const fetchImpl = dependencies.fetchImpl ?? fetch;
  const baseUrl = options.baseUrl ?? DEFAULT_API_BASE_URL;
  const adminBaseUrl = options.adminBaseUrl ?? DEFAULT_ADMIN_API_BASE_URL;
  const credentialDirectory = options.credentialDirectory;

  const database = createClient(environment['DATABASE_URL'], { log: [] });
  try {
    const credentials = readStore(credentialDirectory);
    const existingRecord = credentials[ACCOUNT_EMAIL];
    const existingUser = await database.user.findUnique({
      where: { email: ACCOUNT_EMAIL },
      include: { platformRole: true },
    });
    if (existingRecord && !existingUser) {
      throw new Error('A credential exists without a matching account; refusing to overwrite it.');
    }
    if (existingUser && !existingRecord) {
      throw new Error('The account exists but has no private credential; refusing to change it.');
    }

    let password = existingRecord?.password;
    if (!existingUser) {
      const assigned = Object.values(credentials)
        .map((record) => record.password)
        .filter((value) => typeof value === 'string');
      password = generateOwnerPassword(assigned);
      const now = new Date().toISOString();
      const store = {
        ...credentials,
        [ACCOUNT_EMAIL]: {
          email: ACCOUNT_EMAIL,
          password,
          role: ROLE,
          scope: 'platform',
          organizationSlug: '',
          createdAt: now,
          updatedAt: now,
        },
      };
      // Persist the credential before the database write: a lost commit is
      // recoverable, a lost generated password is not.
      writeStore(store, credentialDirectory);
    }

    const outcome = await database.$transaction(async (tx) => {
      const identity = await tx.$queryRaw`SELECT pg_catalog.current_database() AS name`;
      if (identity[0]?.name !== target.name) throw new Error('Connected database mismatch.');
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(712340984::bigint)::text`;

      const current = await tx.user.findUnique({
        where: { email: ACCOUNT_EMAIL },
        include: { platformRole: true },
      });
      if (current) {
        if (current.status !== 'ACTIVE' || current.platformRole?.role !== ROLE ||
            current.platformRole.revokedAt !== null) {
          throw new Error('Existing account is not an active platform owner; refusing to modify it.');
        }
        return { status: 'unchanged' };
      }

      const userId = randomUUID();
      const passwordHash = await hash(password);
      await tx.user.create({
        data: { id: userId, email: ACCOUNT_EMAIL, passwordHash, status: 'ACTIVE' },
      });
      await tx.platformRoleAssignment.create({
        data: { userId, role: ROLE },
      });
      const metadata = {
        source: 'local_platform_owner_grant',
        actorKind: 'local_operator',
        actorAuthentication: 'explicit_operator_approval',
        approvalReference: approval.approvalReference,
        operatorReference: approval.operatorReference,
        targetUserId: userId,
        role: ROLE,
      };
      if (!isSafeAuditMetadata(metadata)) throw new Error('Unsafe grant audit metadata.');
      await tx.identityAuditEvent.create({
        data: {
          actorUserId: userId,
          action: AUDIT_ACTION,
          outcome: 'SUCCESS',
          metadata,
        },
      });
      return { status: 'created' };
    }, { isolationLevel: 'Serializable', timeout: 120000 });

    const verification = await verifyAccount(database, password, fetchImpl, baseUrl, adminBaseUrl);
    return {
      email: ACCOUNT_EMAIL,
      role: ROLE,
      scope: 'platform',
      database: target.name,
      status: outcome.status,
      ...verification,
    };
  } finally {
    await database.$disconnect();
  }
}

/** CLI entry point. No output contains a password, token or hash. */
export async function main() {
  loadEnvFiles();
  const approval = parseArguments(process.argv.slice(2));
  const baseUrl = process.env['QA_API_BASE_URL'] ?? DEFAULT_API_BASE_URL;
  const adminBaseUrl = process.env['QA_ADMIN_API_BASE_URL'] ?? DEFAULT_ADMIN_API_BASE_URL;
  assertLocalProxyUrl(baseUrl);
  assertLocalAdminProxyUrl(adminBaseUrl);
  const result = await grantLocalPlatformOwner({ approval, baseUrl, adminBaseUrl });
  process.stdout.write(
    `platform owner: ${result.status}; login: ${result.loginVerified ? 'verified' : 'failed'}; ` +
    `settings access: ${result.settingsVerified ? 'verified' : 'failed'}\n`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(() => {
    process.stderr.write('Local platform-owner grant failed. No credential was printed.\n');
    process.exitCode = 1;
  });
}
