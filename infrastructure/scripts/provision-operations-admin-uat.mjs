import { randomBytes, randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { assertKnownAuditAction, checkEmail, generateToken, hashToken } from '@truevine/auth';
import { hashPassword } from '@truevine/auth/passwords';
import { createDatabaseClient } from '@truevine/database';

const UAT_DATABASE_PATTERN = /^truevine_(?:staging|uat)(?:_[a-z0-9]+)*$/;
const APPROVAL_REFERENCE_PATTERN = /^[A-Z][A-Z0-9_-]{2,63}$/;

export function assertStagingProvisioningEnvironment(environment, databaseUrl) {
  if (environment.NODE_ENV !== 'staging' || environment.UAT_PROVISIONING_ENABLED !== '1') {
    throw new Error('UAT provisioning requires NODE_ENV=staging and explicit opt-in.');
  }

  let url;
  try {
    url = new URL(databaseUrl);
  } catch {
    throw new Error('DATABASE_URL is not a valid PostgreSQL URL.');
  }
  if (url.protocol !== 'postgresql:' && url.protocol !== 'postgres:') {
    throw new Error('UAT provisioning requires PostgreSQL.');
  }
  const databaseName = decodeURIComponent(url.pathname.slice(1));
  const loopback = ['localhost', '127.0.0.1', '::1'].includes(url.hostname);
  const githubDisposable =
    environment.GITHUB_ACTIONS === 'true' &&
    loopback &&
    url.port === '55432' &&
    databaseName === 'truevine_uat_provisioning';
  const stagingHost = /staging|uat/i.test(url.hostname);
  if (
    !UAT_DATABASE_PATTERN.test(databaseName) ||
    (loopback && !githubDisposable) ||
    (!stagingHost && !githubDisposable)
  ) {
    throw new Error('Refusing a database outside the isolated staging/UAT allowlist.');
  }
  if (/prod/i.test(url.hostname) || /prod/i.test(databaseName)) {
    throw new Error('Refusing a production-looking database target.');
  }
  return { databaseName, host: url.hostname };
}

function validateActivationUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error('Provide the staging HTTPS application URL.');
  }
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.hostname === 'voice.truevinecloud.online'
  ) {
    throw new Error('Activation links must use the non-production HTTPS staging origin.');
  }
  return url.origin;
}

function activationPath(directory, id) {
  const root = resolve(directory);
  const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
  const relativePath = relative(repo, root);
  if (relativePath === '' || (!relativePath.startsWith(`..${sep}`) && relativePath !== '..')) {
    throw new Error('Activation files must be outside the repository.');
  }
  return resolve(root, `operations-admin-${id}.txt`);
}

export async function provisionOperationsAdmin(options, dependencies = {}) {
  const email = checkEmail(options.email);
  if (!email.ok) throw new Error('Provide a valid UAT email address.');
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      options.actorUserId,
    )
  ) {
    throw new Error('Provide the existing PLATFORM_OWNER user id.');
  }
  if (!APPROVAL_REFERENCE_PATTERN.test(options.approvalReference ?? '')) {
    throw new Error('Provide an approved UAT request reference.');
  }
  const applicationOrigin = validateActivationUrl(options.applicationBaseUrl);
  const environment = dependencies.environment ?? process.env;
  const databaseUrl = dependencies.databaseUrl ?? environment['DATABASE_URL'];
  const target = assertStagingProvisioningEnvironment(environment, databaseUrl ?? '');
  assertKnownAuditAction('platform.operations_admin.provisioned');
  const id = randomUUID();
  const rawToken = (dependencies.generateToken ?? generateToken)();
  const tokenHash = hashToken(rawToken);
  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
  const file = activationPath(
    options.activationDirectory ?? resolve(tmpdir(), 'truevine-uat-activation'),
    id,
  );
  const activationUrl = `${applicationOrigin}/set-password?token=${rawToken}`;

  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  chmodSync(dirname(file), 0o700);
  writeFileSync(
    file,
    [
      'Truevine Voice - Operations Admin UAT activation',
      '',
      `Email:   ${email.value}`,
      `Expires: ${expiresAt.toISOString()}`,
      '',
      'Open this link in a private browser window to set your own password:',
      '',
      activationUrl,
      '',
      'This single-use link expires in 24 hours. Delete this file after activation.',
      '',
    ].join('\n'),
    { encoding: 'utf8', mode: 0o600, flag: 'wx' },
  );

  const createClient = dependencies.createClient ?? createDatabaseClient;
  let db;
  try {
    db = createClient(databaseUrl);
    const passwordHash = await (dependencies.hashPassword ?? hashPassword)(
      randomBytes(32).toString('base64url'),
    );
    await db.$transaction(async (tx) => {
      const actor = await tx.user.findUnique({
        where: { id: options.actorUserId },
        select: {
          id: true,
          status: true,
          platformRole: { select: { role: true, revokedAt: true } },
        },
      });
      if (
        actor?.status !== 'ACTIVE' ||
        actor.platformRole?.role !== 'PLATFORM_OWNER' ||
        actor.platformRole.revokedAt
      ) {
        throw new Error('The approving actor must be an active PLATFORM_OWNER.');
      }
      if (await tx.user.findUnique({ where: { email: email.value }, select: { id: true } })) {
        throw new Error(
          'That user already exists; provisioning never resets or changes an existing account.',
        );
      }
      await tx.user.create({
        data: { id, email: email.value, passwordHash },
      });
      await tx.platformRoleAssignment.create({
        data: { userId: id, role: 'OPERATIONS_ADMIN', grantedByUserId: options.actorUserId },
      });
      await tx.passwordResetToken.create({
        data: { userId: id, tokenHash, expiresAt },
      });
      await tx.identityAuditEvent.create({
        data: {
          actorUserId: options.actorUserId,
          action: 'platform.operations_admin.provisioned',
          outcome: 'SUCCESS',
          metadata: {
            targetUserId: id,
            platformRole: 'OPERATIONS_ADMIN',
            approvalReference: options.approvalReference,
            databaseName: target.databaseName,
          },
        },
      });
    });
    return { userId: id, email: email.value, activationFile: file, activationExpiresAt: expiresAt };
  } catch (error) {
    const { rmSync } = await import('node:fs');
    rmSync(file, { force: true });
    throw error;
  } finally {
    if (db) await db.$disconnect();
  }
}

function parseArguments(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (!key.startsWith('--')) continue;
    const name = key.slice(2);
    const value = argv[++index];
    if (!value || value.startsWith('--')) throw new Error(`Option --${name} needs a value.`);
    options[name] = value;
  }
  return options;
}

export async function main(argv = process.argv.slice(2), environment = process.env) {
  const options = parseArguments(argv);
  if (options['help'] !== undefined) {
    process.stdout.write(
      'Provision a new OPERATIONS_ADMIN UAT account. Requires an active PLATFORM_OWNER, a UAT approval reference, NODE_ENV=staging, UAT_PROVISIONING_ENABLED=1 and an allowlisted staging DATABASE_URL.\n\n' +
        '  --email <synthetic-address>\n  --actor-user-id <PLATFORM_OWNER UUID>\n  --approval-reference <ticket-or-approval-id>\n  --base-url <https://staging-origin>\n  --activation-directory <outside-repository path>\n',
    );
    return;
  }
  if (
    !options.email ||
    !options['actor-user-id'] ||
    !options['approval-reference'] ||
    !options['base-url']
  ) {
    throw new Error('email, actor-user-id, approval-reference and base-url are required.');
  }
  const result = await provisionOperationsAdmin(
    {
      email: options.email,
      actorUserId: options['actor-user-id'],
      approvalReference: options['approval-reference'],
      applicationBaseUrl: options['base-url'],
      activationDirectory: options['activation-directory'],
    },
    { environment },
  );
  process.stdout.write(
    `Operations Admin UAT account provisioned for ${result.email} (user ${result.userId}).\n` +
      `Activation file: ${result.activationFile}\nExpires: ${result.activationExpiresAt.toISOString()}\n`,
  );
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main().catch(() => {
    process.stderr.write(
      'Provisioning refused or failed. Check the staging environment and approval reference; database errors are intentionally not printed.\n',
    );
    process.exitCode = 1;
  });
}
