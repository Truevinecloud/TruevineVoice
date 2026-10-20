import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { hashPassword } from '@truevine/auth/passwords';
import { createDatabaseClient } from '@truevine/database';

if (process.env['GITHUB_ACTIONS'] !== 'true') {
  throw new Error('Refusing Operations Admin provisioning rehearsal outside GitHub Actions.');
}
const baseUrl = process.env['DATABASE_URL'];
if (!baseUrl) throw new Error('The isolated CI DATABASE_URL is required.');
const url = new URL(baseUrl);
if (!['localhost', '127.0.0.1'].includes(url.hostname) || url.port !== '55432') {
  throw new Error('Provisioning rehearsal requires the loopback-only CI PostgreSQL service.');
}

const databaseName = 'truevine_uat_provisioning';
const runId = `${Date.now()}-${process.pid}`;
const actorId = '726530de-1ad1-4d8c-b985-74800cd2e47a';
const ordinaryActorId = 'c4c3273c-20ec-4267-9fe4-1bf61a692f90';
const targetEmail = `operations-admin-${runId}@example.invalid`;
const deniedEmail = `denied-operations-admin-${runId}@example.invalid`;
const activationDir = mkdtempSync(join(tmpdir(), 'truevine-operations-admin-'));
const targetUrl = new URL(baseUrl);
targetUrl.pathname = `/${databaseName}`;
const targetDatabaseUrl = targetUrl.toString();
const ciEnv = {
  ...process.env,
  NODE_ENV: 'staging',
  UAT_PROVISIONING_ENABLED: '1',
  DATABASE_URL: targetDatabaseUrl,
};

function psql(database, sql) {
  execFileSync(
    'docker',
    [
      'compose',
      'exec',
      '-T',
      'postgres',
      'psql',
      '-v',
      'ON_ERROR_STOP=1',
      '-U',
      'truevine',
      '-d',
      database,
      '-c',
      sql,
    ],
    { stdio: 'ignore' },
  );
}

function runProvision(email, actorUserId, approvalReference) {
  return spawnSync(
    process.execPath,
    [
      'infrastructure/scripts/provision-operations-admin-uat.mjs',
      '--email',
      email,
      '--actor-user-id',
      actorUserId,
      '--approval-reference',
      approvalReference,
      '--base-url',
      'https://uat.example.invalid',
      '--activation-directory',
      activationDir,
    ],
    { encoding: 'utf8', env: ciEnv },
  );
}

let db;
try {
  psql('postgres', `DROP DATABASE IF EXISTS ${databaseName} WITH (FORCE);`);
  psql('postgres', `CREATE DATABASE ${databaseName};`);
  execFileSync(process.execPath, [process.env['npm_execpath'], 'run', 'prisma:migrate:deploy'], {
    stdio: 'inherit',
    env: ciEnv,
  });

  db = createDatabaseClient(targetDatabaseUrl);
  const unusableHash = await hashPassword('synthetic non-login rehearsal password');
  await db.user.createMany({
    data: [
      { id: actorId, email: `platform-owner-${runId}@example.invalid`, passwordHash: unusableHash },
      {
        id: ordinaryActorId,
        email: `ordinary-user-${runId}@example.invalid`,
        passwordHash: unusableHash,
      },
    ],
  });
  await db.platformRoleAssignment.create({ data: { userId: actorId, role: 'PLATFORM_OWNER' } });

  const denied = runProvision(deniedEmail, ordinaryActorId, 'UAT-APPROVAL-REHEARSAL');
  if (denied.status === 0) throw new Error('A non-PLATFORM_OWNER provisioned Operations Admin.');
  if (await db.user.findUnique({ where: { email: deniedEmail } })) {
    throw new Error('Denied provisioning created a user.');
  }

  const provision = runProvision(targetEmail, actorId, 'UAT-APPROVAL-REHEARSAL');
  if (provision.status !== 0) throw new Error('Approved staging provisioning command failed.');
  const target = await db.user.findUnique({
    where: { email: targetEmail },
    include: { platformRole: true },
  });
  if (
    !target ||
    target.platformRole?.role !== 'OPERATIONS_ADMIN' ||
    target.platformRole.grantedByUserId !== actorId
  ) {
    throw new Error('Expected Operations Admin assignment and grantor were not persisted.');
  }
  const audit = await db.identityAuditEvent.findFirst({
    where: { actorUserId: actorId, action: 'platform.operations_admin.provisioned' },
  });
  if (
    audit?.metadata?.targetUserId !== target.id ||
    audit.metadata?.platformRole !== 'OPERATIONS_ADMIN' ||
    audit.metadata?.approvalReference !== 'UAT-APPROVAL-REHEARSAL'
  ) {
    throw new Error('Provisioning audit evidence is missing or incomplete.');
  }
  const activationFile = provision.stdout.match(/Activation file: (.+)/)?.[1]?.trim();
  if (!activationFile) throw new Error('Provisioner did not report an activation-file path.');
  const activationMode = statSync(activationFile).mode & 0o777;
  if (activationMode !== 0o600) throw new Error('Activation file permissions are not 0600.');
  const activationText = readFileSync(activationFile, 'utf8');
  const token = new URL(activationText.match(/https:\/\/[^\s]+/)?.[0] ?? '').searchParams.get(
    'token',
  );
  if (!token || provision.stdout.includes(token))
    throw new Error('Activation token handling is unsafe.');
  const resetToken = await db.passwordResetToken.findFirst({ where: { userId: target.id } });
  if (!resetToken || resetToken.usedAt)
    throw new Error('Single-use activation token was not stored as a hash.');

  const duplicate = runProvision(targetEmail, actorId, 'UAT-APPROVAL-REHEARSAL');
  if (duplicate.status === 0)
    throw new Error('Repeated provisioning unexpectedly changed an existing account.');
  const auditCount = await db.identityAuditEvent.count({
    where: { actorUserId: actorId, action: 'platform.operations_admin.provisioned' },
  });
  if (auditCount !== 1)
    throw new Error('Repeated provisioning wrote a duplicate success audit event.');

  process.stdout.write(
    'PASS: non-owner denied; PLATFORM_OWNER grant created atomically with audit; one-use activation stayed private; duplicate request refused.\n',
  );
} finally {
  if (db) await db.$disconnect();
  psql('postgres', `DROP DATABASE IF EXISTS ${databaseName} WITH (FORCE);`);
  rmSync(activationDir, { recursive: true, force: true });
}
