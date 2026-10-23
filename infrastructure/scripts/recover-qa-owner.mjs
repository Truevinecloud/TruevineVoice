import { randomUUID } from 'node:crypto';
import { constants, closeSync, fstatSync, fsyncSync, lstatSync, openSync, realpathSync, unlinkSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { generateToken, hashToken, PASSWORD_RESET_TTL_MS } from '@truevine/auth';
import { createDatabaseClient } from '@truevine/database';
import { loadEnvFiles, requireEnv } from '@truevine/shared';

const EMAIL = 'admin@truevoice.com';
const SLUG = 'truevine-voice-qa';

/** Strict arguments: production acknowledgement is never inferred from environment. */
export function parseRecoveryArguments(argv) {
  if (argv.length !== 3 || argv[0] !== '--confirm-production' ||
      argv[1] !== '--activation-directory' || !isAbsolute(argv[2])) {
    throw new Error('Recovery requires --confirm-production --activation-directory <absolute-private-directory>.');
  }
  return { directory: argv[2] };
}

/** Existing directory only; reject symlinks, foreign ownership and all group/other access. */
export function assertPrivateDirectory(directory) {
  if (process.platform === 'win32' || !isAbsolute(directory) ||
      realpathSync(directory) !== resolve(directory)) throw new Error('Private POSIX directory required.');
  const stat = lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid() ||
      (stat.mode & 0o777) !== 0o700) throw new Error('Directory must be operator-owned with mode 0700.');
}

/** No credentials or identity/role rows are changed. Token replacement and audit commit together. */
export async function recoverQaOwner(database, { directory, baseUrl }, checkDirectory = assertPrivateDirectory) {
  checkDirectory(directory);
  const origin = new URL(baseUrl);
  if (origin.protocol !== 'https:' || origin.username || origin.password ||
      origin.pathname !== '/' || origin.search || origin.hash) throw new Error('HTTPS customer origin required.');
  let file;
  let created = false;
  try {
    return await database.$transaction(async (tx) => {
      const org = await tx.organization.findUnique({ where: { slug: SLUG } });
      if (!org) throw new Error('Target verification failed.');
      await tx.$queryRaw`SELECT id FROM organizations WHERE id = ${org.id}::uuid FOR UPDATE`;
      const user = await tx.user.findUnique({ where: { email: EMAIL } });
      if (!user) throw new Error('Target verification failed.');
      await tx.$queryRaw`SELECT id FROM users WHERE id = ${user.id}::uuid FOR UPDATE`;
      const current = await tx.user.findUnique({ where: { id: user.id } });
      const currentOrg = await tx.organization.findUnique({ where: { id: org.id } });
      const member = await tx.membership.findUnique({ where: {
        organizationId_userId: { organizationId: org.id, userId: user.id },
      } });
      const platform = await tx.platformRoleAssignment.findUnique({ where: { userId: user.id } });
      if (current?.email !== EMAIL || current.status !== 'ACTIVE' ||
          currentOrg?.slug !== SLUG || currentOrg.suspendedAt !== null ||
          member?.role !== 'OWNER' || platform) throw new Error('Target verification failed.');
      const raw = generateToken();
      const expiresAt = new Date(Date.now() + PASSWORD_RESET_TTL_MS);
      await tx.passwordResetToken.updateMany({ where: { userId: user.id, usedAt: null },
        data: { expiresAt: new Date(0) } });
      await tx.passwordResetToken.create({ data: {
        id: randomUUID(), userId: user.id, tokenHash: hashToken(raw), expiresAt,
      } });
      await tx.identityAuditEvent.create({ data: {
        // Identity audits require an existing user reference, as in operator provisioning.
        // Metadata distinguishes the OS operator initiating this from the recovered subject.
        actorUserId: user.id, action: 'auth.password_reset_requested', outcome: 'SUCCESS',
        metadata: { source: 'operator_qa_owner_recovery', targetUserId: user.id,
          organizationId: org.id, operatorUid: process.getuid?.() ?? -1,
          actorKind: 'local_operator', actorAuthentication: 'operating_system' },
      } });
      checkDirectory(directory);
      file = join(directory, `qa-owner-recovery-${randomUUID()}.txt`);
      const fd = openSync(file, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
      created = true;
      try {
        const stat = fstatSync(fd);
        if ((stat.mode & 0o777) !== 0o600 || stat.uid !== process.getuid?.()) throw new Error('Private file required.');
        writeFileSync(fd, `${origin.origin}/set-password?token=${encodeURIComponent(raw)}\nExpires: ${expiresAt.toISOString()}\n`);
        fsyncSync(fd);
      } finally { closeSync(fd); }
      return { file, expiresAt };
    });
  } catch (error) {
    if (created) unlinkSync(file);
    throw error;
  }
}

export async function main(argv = process.argv.slice(2)) {
  let database;
  try {
    const { directory } = parseRecoveryArguments(argv);
    assertPrivateDirectory(directory);
    loadEnvFiles();
    // Disable ORM logging: database errors can include credentials or token digests.
    database = createDatabaseClient(requireEnv('DATABASE_URL'), { log: [] });
    const result = await recoverQaOwner(database, { directory, baseUrl: requireEnv('WEB_PUBLIC_URL') });
    process.stdout.write(`Recovery file created: ${result.file}\nExpires: ${result.expiresAt.toISOString()}\n`);
  } catch {
    process.stderr.write('QA Owner recovery failed; inspect target identity, configuration and private directory securely. No success is claimed.\n');
    process.exitCode = 1;
  } finally {
    try { await database?.$disconnect(); } catch { process.exitCode = 1; }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main();
