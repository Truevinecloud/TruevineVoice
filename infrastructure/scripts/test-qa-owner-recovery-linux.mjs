// Real CLI, filesystem and transaction rehearsal. Only a database created here is mutated.
import { randomUUID, randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createDatabaseClient } from '@truevine/database';
import { generateToken, hashToken, PASSWORD_RESET_TTL_MS } from '@truevine/auth';
import { verifyPassword } from '@truevine/auth/passwords';
import { recoverQaOwner } from './recover-qa-owner.mjs';

const root = resolve(import.meta.dirname, '../..');
class RehearsalAssertion extends Error {}
const check = (condition, label) => { if (!condition) throw new RehearsalAssertion(label); };
const pass = (label) => process.stdout.write(`PASS QA recovery: ${label}\n`);
// Capture all subprocess diagnostics; never surface database errors, token material or URLs.
function start(args, env) {
  const child = spawn(process.execPath, args, { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', (data) => { output += data; });
  child.stderr.on('data', (data) => { output += data; });
  const done = new Promise((resolveResult, reject) => {
    child.on('error', () => reject(new Error('Rehearsal subprocess failed to start.')));
    child.on('close', (code) => resolveResult({ code, output }));
  });
  return { done, child };
}
async function run(args, env) { return start(args, env).done; }

let admin, database, directory, created = false;
const name = `qa_recovery_${randomUUID().replaceAll('-', '')}`;
try {
  check(process.platform === 'linux' && process.env.NODE_ENV === 'test' &&
    process.env.QA_OWNER_RECOVERY_DISPOSABLE === '1' && process.env.npm_execpath,
  'Linux rehearsal requires explicit disposable test environment and root npm command.');
  const configured = new URL(process.env.DATABASE_URL);
  check(['localhost', '127.0.0.1'].includes(configured.hostname) && configured.port === '55432' &&
    configured.pathname === '/truevine_voice', 'Rehearsal requires the runner-local Compose database.');
  admin = createDatabaseClient(configured.toString(), { log: [] });
  // The name is generated here and never accepted from an environment variable or argument.
  await admin.$executeRawUnsafe(`CREATE DATABASE "${name}"`);
  created = true;
  const target = new URL(configured);
  target.pathname = `/${name}`;
  target.search = '';
  const env = { ...process.env, DATABASE_URL: target.toString(), WEB_PUBLIC_URL: 'https://qa.example.invalid' };
  const migration = await run([process.env.npm_execpath, 'run', 'prisma:migrate:deploy'], env);
  check(migration.code === 0, 'Disposable migration failed (diagnostics withheld).');
  database = createDatabaseClient(target.toString(), { log: [] });
  directory = mkdtempSync(join(tmpdir(), 'qa-owner-recovery-'));
  chmodSync(directory, 0o700);
  const userId = randomUUID(), organizationId = randomUUID();
  await database.$transaction(async (tx) => {
    await tx.user.create({ data: { id: userId, email: 'admin@truevoice.com', passwordHash: 'unusable-disposable-fixture' } });
    await tx.organization.create({ data: { id: organizationId, slug: 'truevine-voice-qa', name: 'Disposable recovery test' } });
    await tx.membership.create({ data: { organizationId, userId, role: 'OWNER' } });
  });
  const beforeUser = await database.user.findUnique({ where: { id: userId } });
  const beforeMembers = JSON.stringify(await database.membership.findMany({ where: { organizationId } }));
  const beforeCounts = [await database.user.count(), await database.organization.count()];
  const oldRaw = generateToken();
  const old = await database.passwordResetToken.create({ data: { userId, tokenHash: hashToken(oldRaw), expiresAt: new Date(Date.now() + PASSWORD_RESET_TTL_MS) } });
  const options = { directory, baseUrl: env.WEB_PUBLIC_URL };
  const args = ['infrastructure/scripts/recover-qa-owner.mjs', '--confirm-production', '--activation-directory', directory];
  const refused = await run([args[0], '--activation-directory', directory], env);
  check(refused.code !== 0 && (await database.passwordResetToken.count()) === 1, 'Confirmation must refuse before mutation.');
  const begin = Date.now();
  const success = await run(args, env);
  check(success.code === 0, 'Real Node CLI must succeed.');
  const file = join(directory, readdirSync(directory)[0]);
  const token = new URL(readFileSync(file, 'utf8').split('\n')[0]).searchParams.get('token');
  check(Boolean(token) && !success.output.includes(token) && !success.output.includes('/set-password?'), 'CLI must not emit activation credential.');
  check((statSync(file).mode & 0o777) === 0o600 && statSync(file).uid === process.getuid() &&
    (statSync(directory).mode & 0o777) === 0o700, 'Real file and directory permissions.');
  const issued = await database.passwordResetToken.findUnique({ where: { tokenHash: hashToken(token) } });
  check(issued && issued.expiresAt.getTime() >= begin + PASSWORD_RESET_TTL_MS &&
    issued.expiresAt.getTime() <= Date.now() + PASSWORD_RESET_TTL_MS, 'Shared digest and expiry.');
  check((await database.passwordResetToken.findUnique({ where: { id: old.id } })).expiresAt.getTime() === 0, 'Prior token revoked.');
  check(JSON.stringify(beforeUser) === JSON.stringify(await database.user.findUnique({ where: { id: userId } })) &&
    beforeMembers === JSON.stringify(await database.membership.findMany({ where: { organizationId } })) &&
    beforeCounts[0] === await database.user.count() && beforeCounts[1] === await database.organization.count(),
  'No password, identity, organization or role mutation.');
  const audit = await database.identityAuditEvent.findFirst({ where: { action: 'auth.password_reset_requested' } });
  check(audit?.metadata?.source === 'operator_qa_owner_recovery' && audit.metadata.targetUserId === userId &&
    !JSON.stringify(audit).includes(token), 'Safe recovery audit committed.');
  pass('plain Node CLI, 0700/0600, prior-token revocation, audit and unchanged identities/roles');

  // Verify lock waits from PostgreSQL itself, rather than inferring from elapsed time.
  let waiting;
  await database.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM users WHERE id = ${userId}::uuid FOR UPDATE`;
    waiting = start(args, env);
    const deadline = Date.now() + 3500;
    let blocked = false;
    while (Date.now() < deadline) {
      const rows = await admin.$queryRaw`SELECT pid FROM pg_stat_activity WHERE datname = ${name} AND wait_event_type = 'Lock' AND query LIKE '%FROM users%FOR UPDATE%'`;
      if (rows.length) { blocked = true; break; }
      await delay(50);
    }
    check(blocked, 'Recovery must block on the same user lock as reset consumption.');
  });
  check((await waiting.done).code === 0, 'Recovery resumes after user lock release.');
  await database.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM organizations WHERE id = ${organizationId}::uuid FOR UPDATE`;
    waiting = start(args, env);
    const deadline = Date.now() + 3500;
    let blocked = false;
    while (Date.now() < deadline) {
      const rows = await admin.$queryRaw`SELECT pid FROM pg_stat_activity WHERE datname = ${name} AND wait_event_type = 'Lock' AND query LIKE '%FROM organizations%FOR UPDATE%'`;
      if (rows.length) { blocked = true; break; }
      await delay(50);
    }
    check(blocked, 'Recovery must lock organization against concurrent membership changes.');
  });
  check((await waiting.done).code === 0, 'Recovery resumes after organization lock release.');
  const concurrent = await Promise.all([run(args, env), run(args, env)]);
  check(concurrent.every((result) => result.code === 0), 'Concurrent recovery requests complete.');
  check(await database.passwordResetToken.count({ where: { userId, usedAt: null, expiresAt: { gt: new Date() } } }) === 1, 'Only newest replacement remains usable.');
  pass('real user-row locking and concurrent issuance serialization');

  const snapshot = async () => JSON.stringify(await database.passwordResetToken.findMany({ orderBy: { id: 'asc' } }));
  const baseline = await snapshot();
  const filesBefore = readdirSync(directory).length;
  // A deferred trigger raises at commit, after the private file was fsynced.
  await database.$executeRawUnsafe("CREATE FUNCTION qa_recovery_fail_commit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'disposable recovery commit failure'; END $$");
  await database.$executeRawUnsafe("CREATE CONSTRAINT TRIGGER qa_recovery_fail_commit AFTER INSERT ON identity_audit_events DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION qa_recovery_fail_commit()");
  const failed = await run(args, env);
  check(failed.code !== 0 && await snapshot() === baseline && readdirSync(directory).length === filesBefore, 'Commit failure rolls back token revocation/issuance and removes created file.');
  check(!failed.output.includes(target.toString()) && !failed.output.includes('/set-password?'), 'Failure diagnostics stay private.');
  await database.$executeRawUnsafe('DROP TRIGGER qa_recovery_fail_commit ON identity_audit_events');
  await database.$executeRawUnsafe('DROP FUNCTION qa_recovery_fail_commit()');
  // Inject a directory-mode change after the audit insert to force late file failure.
  const wrapper = { $transaction: (work) => database.$transaction(async (tx) => work({
    organization: tx.organization, user: tx.user, membership: tx.membership,
    platformRoleAssignment: tx.platformRoleAssignment, passwordResetToken: tx.passwordResetToken,
    $queryRaw: tx.$queryRaw.bind(tx),
    identityAuditEvent: { create: async (input) => {
      const result = await tx.identityAuditEvent.create(input);
      chmodSync(directory, 0o500);
      return result;
    } },
  })) };
  let fileFailed = false;
  try { await recoverQaOwner(wrapper, options); } catch { fileFailed = true; } finally { chmodSync(directory, 0o700); }
  check(fileFailed && await snapshot() === baseline && readdirSync(directory).length === filesBefore,
    'Late filesystem failure rolls back revocation and replacement.');
  const link = join(directory, 'symlink');
  symlinkSync(directory, link);
  check((await run([args[0], '--confirm-production', '--activation-directory', link], env)).code !== 0, 'Symlink directory refused.');
  chmodSync(directory, 0o750);
  check((await run(args, env)).code !== 0, 'Group-accessible directory refused.');
  chmodSync(directory, 0o700);
  check((await run(args, env)).code === 0, 'Retry succeeds after failure correction.');
  pass('deferred commit rollback/file cleanup, late filesystem rollback, unsafe-directory refusal and retry');

  // Exercise existing application consumption against the token produced by the real CLI.
  await import('reflect-metadata');
  const { AuthService } = await import('../../apps/api/dist/auth/auth.service.js');
  const { PrismaAuthStore, PrismaAuditStore, PrismaSecurityTransaction } = await import('../../apps/api/dist/auth/prisma-stores.js');
  const auth = new AuthService(new PrismaAuthStore(database), new PrismaAuditStore(database),
    { consume: async () => ({ allowed: true }) }, { send: async () => { throw new Error('Email must not be used.'); } },
    env.WEB_PUBLIC_URL, 5, 60000, 60000, new PrismaSecurityTransaction(database));
  const active = await database.passwordResetToken.findFirst({ where: { userId, usedAt: null, expiresAt: { gt: new Date() } } });
  const raw = readdirSync(directory).filter((name) => name.endsWith('.txt')).map((name) =>
    new URL(readFileSync(join(directory, name), 'utf8').split('\n')[0]).searchParams.get('token')).find((value) => hashToken(value) === active.tokenHash);
  check(Boolean(raw), 'Active delivery file found without exposing token.');
  const password = randomBytes(32).toString('base64url');
  let oldRefused = false;
  try { await auth.completePasswordReset(oldRaw, password); } catch { oldRefused = true; }
  check(oldRefused, 'Superseded activation/reset token is refused by existing consumption.');
  const session = await database.session.create({ data: { userId, tokenHash: hashToken(generateToken()), expiresAt: new Date(Date.now() + PASSWORD_RESET_TTL_MS) } });
  await auth.completePasswordReset(raw, password);
  check(await verifyPassword((await database.user.findUnique({ where: { id: userId } })).passwordHash, password), 'Custodian-selected password is consumed by existing flow.');
  check((await database.session.findUnique({ where: { id: session.id } })).revokedAt !== null, 'Completion revokes previous sessions.');
  let replayRefused = false;
  try { await auth.completePasswordReset(raw, randomBytes(32).toString('base64url')); } catch { replayRefused = true; }
  check(replayRefused && await database.passwordResetToken.count({ where: { userId, usedAt: null, expiresAt: { gt: new Date() } } }) === 0, 'Consumption is single-use.');
  pass('existing reset consumption, custodian-selected password and replay refusal without email');
} catch (error) {
  process.stderr.write('FAIL QA recovery Linux rehearsal; credential-bearing diagnostics withheld.\n');
  if (error instanceof RehearsalAssertion) process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
} finally {
  try {
    await database?.$disconnect();
    if (created) {
      check(/^qa_recovery_[a-f0-9]{32}$/.test(name), 'Refusing unowned database cleanup.');
      await admin.$executeRawUnsafe(`DROP DATABASE "${name}" WITH (FORCE)`);
    }
    if (directory) { chmodSync(directory, 0o700); rmSync(directory, { recursive: true }); }
    await admin?.$disconnect();
  } catch {
    process.stderr.write('FAIL QA recovery rehearsal cleanup; operator review required.\n');
    process.exitCode = 1;
  }
}
