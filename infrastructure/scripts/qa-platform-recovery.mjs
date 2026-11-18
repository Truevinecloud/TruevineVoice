import { randomBytes, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { userInfo } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { assertKnownAuditAction, generateToken, hashToken, isSafeAuditMetadata, PASSWORD_RESET_TTL_MS } from '@truevine/auth';
import { checkPassword } from '@truevine/auth/passwords';
import { createDatabaseClient } from '@truevine/database';
import { loadEnvFiles, requireEnv } from '@truevine/shared';

export const DATABASE = 'truevine_bootstrap_test_a1b2c3d4e5f67890';
export const ACCOUNTS = Object.freeze([
  Object.freeze({ email: 'qa-platform-owner@truevoice.com', id: '918d4f57-f901-459e-b522-71a9165cffe2', role: 'PLATFORM_OWNER' }),
  Object.freeze({ email: 'qa-support-admin@truevoice.com', id: 'c53c116b-8f77-4af4-b8af-281bcc9219e5', role: 'SUPPORT_ADMIN' }),
]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SOURCE = 'operator_local_qa_platform_recovery';
const HELPER = fileURLToPath(new URL('./qa-platform-vault.ps1', import.meta.url));

export function parseArguments(argv) {
  if (argv.length !== 4 || !['issue', 'complete'].includes(argv[0]) ||
      argv[1] !== '--approve-local-qa-recovery' || argv[2] !== '--operation-id' || !UUID.test(argv[3])) {
    throw new Error('Explicit action, approval and version-4 operation UUID required.');
  }
  return { action: argv[0], operationId: argv[3] };
}

/** No implicit selection of the development database, URI options or remote host. */
export function validateTarget(env, platform = process.platform) {
  const url = new URL(env.DATABASE_URL);
  const redis = new URL(env.REDIS_URL);
  if (platform !== 'win32' || !['development', 'test'].includes(env.NODE_ENV) ||
      !['postgres:', 'postgresql:'].includes(url.protocol) ||
      !['localhost', '127.0.0.1'].includes(url.hostname) || url.port !== '55432' ||
      url.pathname !== `/${DATABASE}` || url.search || url.hash ||
      env.EXPECTED_DATABASE_NAME !== DATABASE || redis.protocol !== 'redis:' ||
      !['localhost', '127.0.0.1'].includes(redis.hostname) || redis.port !== '56379' ||
      redis.search || redis.hash) throw new Error('Local QA target refused.');
}

/** Fixed PowerShell helper; secrets travel only through anonymous stdin/stdout pipes. */
export async function vault(action, operationId, bundle) {
  if (!['write', 'read'].includes(action) || !UUID.test(operationId) || process.platform !== 'win32') {
    throw new Error('Vault request refused.');
  }
  return new Promise((fulfill, reject) => {
    const script = readFileSync(HELPER, 'utf8');
    const repository = fileURLToPath(new URL('../../', import.meta.url)).replaceAll("'", "''");
    // Inline trusted source instead of changing machine/user execution policy.
    // No credential is ever interpolated into the command or argument list.
    const command = `& { ${script} } -Action ${action} -OperationId ${operationId} -RepositoryRoot '${repository}'`;
    const child = spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command],
      { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let output = '';
    let oversized = false;
    child.stdout.on('data', (chunk) => {
      if (output.length + chunk.length > 32768) { oversized = true; child.kill(); }
      else output += chunk.toString('utf8');
    });
    // Never forward diagnostics: PowerShell errors can quote secret-bearing input.
    child.stderr.resume();
    child.on('error', () => reject(new Error('Windows vault unavailable.')));
    child.stdin.on('error', () => reject(new Error('Windows vault input failed.')));
    child.on('close', (code) => {
      if (code !== 0 || oversized) return reject(new Error('Windows vault operation failed.'));
      try { fulfill(JSON.parse(output)); } catch { reject(new Error('Windows vault response invalid.')); }
    });
    child.stdin.end(bundle === undefined ? '' : JSON.stringify(bundle));
  });
}

export async function verifyAccounts(tx) {
  const rows = await tx.$queryRaw`SELECT current_database() AS name, inet_server_port() AS port`;
  if (rows.length !== 1 || rows[0].name !== DATABASE || rows[0].port !== 5432) {
    throw new Error('Connected database refused.');
  }
  for (const expected of ACCOUNTS) {
    await tx.$queryRaw`SELECT id FROM users WHERE id = ${expected.id}::uuid FOR UPDATE`;
    await tx.$queryRaw`SELECT user_id FROM platform_role_assignments WHERE user_id = ${expected.id}::uuid FOR UPDATE`;
    const user = await tx.user.findUnique({ where: { id: expected.id }, include: { platformRole: true } });
    if (user?.email !== expected.email || user.status !== 'ACTIVE' ||
        user.platformRole?.role !== expected.role || user.platformRole.revokedAt !== null) {
      throw new Error('Existing account identity or role refused.');
    }
  }
}

/** Same hash/TTL, prior-token expiry and transactional identity audit as existing recovery tools. */
export async function issueRecovery(database, options, store = vault) {
  if (!UUID.test(options.operationId) || options.approved !== true) throw new Error('Approval required.');
  return database.$transaction(async (tx) => {
    await verifyAccounts(tx);
    const prior = await tx.identityAuditEvent.findFirst({ where: {
      action: 'auth.password_reset_requested',
      metadata: { path: ['operationId'], equals: options.operationId },
    } });
    if (prior) throw new Error('Operation already issued; reconcile existing bundle.');
    const expiresAt = new Date(Date.now() + PASSWORD_RESET_TTL_MS);
    const entries = ACCOUNTS.map((account) => ({ ...account, token: generateToken(),
      password: randomBytes(32).toString('base64url') }));
    if (entries[0].password === entries[1].password || entries.some((entry) => checkPassword(entry.password))) {
      throw new Error('Generated credential rejected by password policy.');
    }
    for (const entry of entries) {
      const metadata = {
        source: SOURCE, operationId: options.operationId, targetUserId: entry.id,
        actorKind: 'local_operator', actorAuthentication: 'operating_system', operatorReference: options.operator,
      };
      assertKnownAuditAction('auth.password_reset_requested');
      if (!isSafeAuditMetadata(metadata)) throw new Error('Unsafe recovery audit.');
      await tx.passwordResetToken.updateMany({ where: { userId: entry.id, usedAt: null }, data: { expiresAt: new Date(0) } });
      await tx.passwordResetToken.create({ data: { id: randomUUID(), userId: entry.id,
        tokenHash: hashToken(entry.token), expiresAt } });
      await tx.identityAuditEvent.create({ data: { actorUserId: entry.id,
        action: 'auth.password_reset_requested', outcome: 'SUCCESS', metadata } });
    }
    // Storage must succeed before DB commit. Keep an encrypted bundle on uncertain commit;
    // it cannot be overwritten/reissued with this operation ID, and requires reconciliation.
    const location = await store('write', options.operationId, { version: 1, database: DATABASE,
      operationId: options.operationId, expiresAt: expiresAt.toISOString(), entries });
    return { location, expiresAt: expiresAt.toISOString() };
  }, { timeout: 30000 });
}

export async function completeRecovery(database, options, service, store = vault) {
  if (!UUID.test(options.operationId) || options.approved !== true) throw new Error('Approval required.');
  const bundle = await store('read', options.operationId);
  if (bundle.version !== 1 || bundle.database !== DATABASE || bundle.operationId !== options.operationId ||
      !Number.isFinite(Date.parse(bundle.expiresAt)) || Date.parse(bundle.expiresAt) <= Date.now() ||
      bundle.entries?.length !== 2) throw new Error('Recovery bundle refused.');
  for (const [index, expected] of ACCOUNTS.entries()) {
    const entry = bundle.entries[index];
    if (entry.id !== expected.id || entry.email !== expected.email || entry.role !== expected.role ||
        typeof entry.token !== 'string' || !entry.token || checkPassword(entry.password)) throw new Error('Recovery entry refused.');
  }
  if (bundle.entries[0].password === bundle.entries[1].password) throw new Error('Distinct credentials required.');
  // Validate all tokens before completing either account. Completion itself owns atomic
  // policy enforcement, token consumption, session revocation and credential-change audit.
  await database.$transaction(async (tx) => {
    await verifyAccounts(tx);
    for (const entry of bundle.entries) {
      const audit = await tx.identityAuditEvent.findFirst({ where: { actorUserId: entry.id,
        action: 'auth.password_reset_requested', outcome: 'SUCCESS',
        metadata: { path: ['operationId'], equals: options.operationId } } });
      const token = await tx.passwordResetToken.findUnique({ where: { tokenHash: hashToken(entry.token) } });
      if (!audit || audit.metadata.source !== SOURCE || !token || token.userId !== entry.id || token.usedAt !== null ||
          token.expiresAt <= new Date()) throw new Error('Issued recovery proof refused.');
    }
  });
  for (const entry of bundle.entries) await service.completePasswordReset(entry.token, entry.password);
}

/** Fence every application-service mutation with the same exact-account guards.
 * The actual Prisma adapter and audit stores still own all credential writes.
 */
export function guardedDatabase(database) {
  return new Proxy(database, { get(target, property) {
    if (property === '$transaction') return (work, options) => target.$transaction(async (tx) => {
      await verifyAccounts(tx);
      return work(tx);
    }, options);
    const value = Reflect.get(target, property, target);
    return typeof value === 'function' ? value.bind(target) : value;
  } });
}

export async function main(argv = process.argv.slice(2)) {
  let database;
  let app;
  try {
    const options = parseArguments(argv);
    loadEnvFiles();
    validateTarget(process.env);
    database = createDatabaseClient(requireEnv('DATABASE_URL'), { log: [] });
    if (options.action === 'issue') {
      const result = await issueRecovery(database, { ...options, approved: true, operator: userInfo().username });
      process.stdout.write(`QA recovery issued. Encrypted bundle: ${result.location}\nExpires: ${result.expiresAt}\n`);
    } else {
      // Boot the actual application's exported service against this explicitly pinned
      // connection, without opening HTTP or routing through an unverified running API.
      process.env.EMAIL_TRANSPORT = 'none';
      // Existing local Nest testing harness lets us override infrastructure with
      // the pinned, log-disabled Prisma client; no ORM diagnostics can leak hashes.
      const { Test } = await import('@nestjs/testing');
      const { AppModule } = await import('../../apps/api/dist/app.module.js');
      const { AuthService } = await import('../../apps/api/dist/auth/auth.service.js');
      const { DATABASE_CLIENT } = await import('../../apps/api/dist/tokens.js');
      app = await Test.createTestingModule({ imports: [AppModule] })
        .overrideProvider(DATABASE_CLIENT).useValue(guardedDatabase(database)).setLogger(false).compile();
      await app.init();
      await completeRecovery(database, { ...options, approved: true }, app.get(AuthService));
      process.stdout.write('Both QA password resets completed using AuthService. Credentials remain in the Windows vault bundle.\n');
    }
  } catch {
    process.stderr.write('QA recovery failed; no success claimed. Reconcile the operation and encrypted bundle before retrying. Diagnostics withheld.\n');
    process.exitCode = 1;
  } finally {
    try { await app?.close(); await database?.$disconnect(); } catch { process.exitCode = 1; }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main();
