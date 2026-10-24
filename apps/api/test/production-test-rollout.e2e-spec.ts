import { execFileSync, spawnSync } from 'node:child_process';
import { generateKeyPairSync, randomBytes, randomUUID, type KeyObject } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { createServer as createHttpsServer, type Server as HttpsServer } from 'node:https';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { RequestMethod, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { createDatabaseClient, type PrismaClient } from '@truevine/database';
import { hashPassword } from '@truevine/auth/passwords';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { APP_CONFIG } from '../src/config/app-config.module.js';
import { DATABASE_CLIENT, REDIS_CLIENT } from '../src/tokens.js';
import { RATE_LIMITER } from '../src/auth/tokens.js';
import { bootstrapPlatformOwner } from '../../../infrastructure/scripts/bootstrap-platform-owner.mjs';
import { executeRollout, INVENTORY_DIGEST, ROLLOUT_ACCOUNTS } from '../../../infrastructure/scripts/production-test-rollout.mjs';
import { executePrivateHttp, privateHttpClient } from '../../../infrastructure/scripts/production-test-http.mjs';
import { signOwnerAuthorization } from '../../../infrastructure/scripts/production-test-rollout-owner-auth.mjs';

let admin: PrismaClient | undefined;
let database: PrismaClient | undefined;
let app: INestApplication | undefined;
let createdName: string | undefined;
let databaseUrl: string;
let origin: string;
let apiPort: number | undefined;
let httpsProxy: HttpsServer | undefined;
let privateDirectory: string | undefined;
let ownerKeyPair: { privateKey: KeyObject; publicKey: KeyObject } | undefined;
const priorWebPublicUrl = process.env['WEB_PUBLIC_URL'];
let systemIdentifier: string;
const revision = 'a'.repeat(40);
const adminUserId = randomUUID(), adminOrganizationId = randomUUID();
const passwords: Record<string, string> = Object.fromEntries(ROLLOUT_ACCOUNTS.map(account => [account.email, randomBytes(24).toString('base64url')]));
const credentials = { version: 1, reference: 'CREDENTIALS-E2E', passwords };
const bootstrapOperationId = randomUUID(), provisionOperationId = randomUUID();
let ownerId: string;
let artifact: { operationId: string; email: string; activationUrl: string };

beforeAll(async () => {
  const explicit = process.env['ROLLOUT_TEST_ADMIN_URL'];
  const configured = explicit ?? process.env['DATABASE_URL'];
  if (process.env['NODE_ENV'] !== 'test' || !configured)
    throw new Error('Rollout integration requires NODE_ENV=test, ROLLOUT_E2E_DISPOSABLE=1 and an explicitly disposable ROLLOUT_TEST_ADMIN_URL.');
  let url: URL;
  try { url = new URL(configured); } catch { throw new Error('Invalid disposable database configuration; no target details logged.'); }
  const existingCiFixture = process.env['CI'] === 'true' && url.port === '55432' && /^\/(truevine_voice|rbac_security_\d+_\d+_[a-z]+)$/.test(url.pathname);
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || !['127.0.0.1', 'localhost'].includes(url.hostname) || url.hash ||
      [...url.searchParams.keys()].some(key => !['schema', 'sslmode'].includes(key)) ||
      (url.searchParams.has('schema') && url.searchParams.get('schema') !== 'public') ||
      (explicit ? process.env['ROLLOUT_E2E_DISPOSABLE'] !== '1' || url.pathname !== '/postgres' : !existingCiFixture))
    throw new Error('Rollout integration refuses non-loopback or non-disposable admin targets.');
  admin = createDatabaseClient(configured, { log: [] });
  const cluster = await admin.$queryRaw<Array<{ name: string }>>`SELECT system_identifier::text AS name FROM pg_catalog.pg_control_system()`;
  systemIdentifier = cluster[0]!.name;
  const name = `truevine_bootstrap_test_${randomBytes(8).toString('hex')}`;
  await admin.$executeRawUnsafe(`CREATE DATABASE "${name}"`);
  createdName = name;
  url.pathname = `/${name}`; databaseUrl = url.toString();
  if (!process.env['npm_execpath']) throw new Error('Use the root npm integration command.');
  try {
    execFileSync(process.execPath, [process.env['npm_execpath'], 'run', 'prisma:migrate:deploy'], {
      cwd: resolve(import.meta.dirname, '../../..'), env: { ...process.env, DATABASE_URL: databaseUrl }, stdio: 'pipe', timeout: 60000,
    });
  } catch { throw new Error('Migration rehearsal failed in the newly created disposable database.'); }
  database = createDatabaseClient(databaseUrl, { log: [] });
  const preservedPasswordHash = await hashPassword(randomBytes(24).toString('base64url'));
  await database.$transaction(async tx => {
    await tx.organization.create({ data: { id: adminOrganizationId, name: 'Preserved synthetic owner fixture', slug: 'truevoice-testing-isolation' } });
    await tx.user.create({ data: { id: adminUserId, email: 'admin@truevoice.com', passwordHash: preservedPasswordHash } });
    await tx.membership.create({ data: { organizationId: adminOrganizationId, userId: adminUserId, role: 'OWNER' } });
  });
  if (process.env['ROLLOUT_E2E_HTTPS'] === '1') {
    if (process.platform !== 'linux' || !process.env['ROLLOUT_E2E_TLS_CERT'] || !process.env['ROLLOUT_E2E_TLS_KEY'])
      throw new Error('Linux HTTPS rehearsal requires its disposable TLS certificate.');
    privateDirectory = mkdtempSync(join(tmpdir(), 'truevine-rollout-private-'));
    chmodSync(privateDirectory, 0o700);
    ownerKeyPair = generateKeyPairSync('ed25519');
    const proxy = createHttpsServer({ cert: readFileSync(process.env['ROLLOUT_E2E_TLS_CERT']), key: readFileSync(process.env['ROLLOUT_E2E_TLS_KEY']) }, (request, response) => {
      if (apiPort === undefined) { response.writeHead(503).end(); return; }
      const upstream = httpRequest({ hostname: '127.0.0.1', port: apiPort, path: request.url, method: request.method,
        headers: { ...request.headers, host: `127.0.0.1:${apiPort}` } }, result => {
        response.writeHead(result.statusCode ?? 502, result.headers); result.pipe(response);
      });
      upstream.on('error', () => { response.writeHead(502).end(); });
      request.pipe(upstream);
    });
    await new Promise<void>((resolvePromise, reject) => {
      proxy.once('error', reject); proxy.listen(0, '127.0.0.1', () => { proxy.off('error', reject); resolvePromise(); });
    });
    httpsProxy = proxy;
    const address = proxy.address();
    if (!address || typeof address === 'string') throw new Error('Disposable HTTPS listener failed.');
    origin = `https://127.0.0.1:${address.port}`;
    process.env['WEB_PUBLIC_URL'] = origin;
    const credentialsPath = join(privateDirectory, 'credentials.json');
    const ownerKeyPath = join(privateDirectory, 'owner-authentication.key');
    writeFileSync(credentialsPath, `${JSON.stringify(credentials)}\n`, { mode: 0o600, flag: 'wx' });
    writeFileSync(ownerKeyPath, ownerKeyPair.privateKey.export({ format: 'pem', type: 'pkcs8' }), { mode: 0o600, flag: 'wx' });
    if ((statSync(privateDirectory).mode & 0o777) !== 0o700 || (statSync(credentialsPath).mode & 0o777) !== 0o600 ||
        (statSync(ownerKeyPath).mode & 0o777) !== 0o600) throw new Error('Disposable private-file permissions did not hold.');
  }
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(APP_CONFIG).useValue({ host: '127.0.0.1', port: 0, environment: 'test', version: revision,
      databaseUrl, redisUrl: 'redis://stub:6379', healthTimeoutMs: 50, serviceName: 'truevine-voice-api' })
    .overrideProvider(DATABASE_CLIENT).useValue(database)
    .overrideProvider(REDIS_CLIENT).useValue({ ping: async () => 'PONG', disconnect: () => undefined })
    // Fixture-only limiter: real rate-limit contracts remain covered by the
    // unchanged suite. Production tooling never substitutes its limiter.
    .overrideProvider(RATE_LIMITER).useValue({ consume: async () => ({ allowed: true, retryAfterMs: 0, remaining: 1000 }) })
    .compile();
  app = moduleRef.createNestApplication();
  app.setGlobalPrefix('api', { exclude: [{ path: 'health', method: RequestMethod.GET }] });
  await app.listen(0, '127.0.0.1');
  const apiAddress = app.getHttpServer().address();
  if (!apiAddress || typeof apiAddress === 'string') throw new Error('Disposable API listener failed.');
  apiPort = apiAddress.port;
  if (!origin) origin = await app.getUrl();
}, 60000);

afterAll(async () => {
  await app?.close();
  if (httpsProxy) await new Promise<void>((resolvePromise, reject) => httpsProxy!.close(error => error ? reject(error) : resolvePromise()));
  if (privateDirectory) {
    const exactTemp = resolve(tmpdir(), privateDirectory.slice(resolve(tmpdir()).length + 1));
    if (exactTemp !== resolve(privateDirectory) || !privateDirectory.includes('truevine-rollout-private-')) throw new Error('Unsafe temporary cleanup target.');
    rmSync(privateDirectory, { recursive: true });
  }
  if (priorWebPublicUrl === undefined) delete process.env['WEB_PUBLIC_URL']; else process.env['WEB_PUBLIC_URL'] = priorWebPublicUrl;
  await database?.$disconnect();
  // Only the exact database successfully created above may be removed. No audit
  // immutability is bypassed; retire the entire owned disposable fixture.
  if (createdName) {
    if (!/^truevine_bootstrap_test_[a-f0-9]{16}$/.test(createdName)) throw new Error('Unsafe cleanup target.');
    await admin!.$executeRawUnsafe(`DROP DATABASE "${createdName}" WITH (FORCE)`);
  }
  await admin?.$disconnect();
});

function inputs(action: string) {
  const target = new URL(databaseUrl);
  return {
    approval: { version: 1, action, environment: 'test', releaseSha: revision, provisioningReleaseSha: revision,
      operationId: action === 'bootstrap' ? bootstrapOperationId : action === 'provision' ? provisionOperationId : randomUUID(),
      bootstrapOperationId, provisionOperationId, inventoryDigest: INVENTORY_DIGEST, credentialReference: credentials.reference,
      email: 'qa-platform-owner@truevoice.com', actorUserId: action === 'bootstrap' ? null : ownerId,
      approvalReference: 'APPROVAL-E2E', operatorReference: 'OPERATOR-E2E', rehearsalReference: 'REHEARSAL-E2E',
      expiresAt: new Date(Date.now() + 3600000).toISOString(), applicationOrigin: origin,
      bootstrapApplicationOrigin: privateDirectory ? origin : 'https://localhost', httpAuthorized: true,
      preservedAdmin: { userId: adminUserId, organizationId: adminOrganizationId },
      isolationOrganizationId: adminOrganizationId, isolationFixtureAuthorized: true,
      database: { hostname: target.hostname, port: target.port || '5432', name: createdName, systemIdentifier } },
    dependencies: { environment: { NODE_ENV: 'test', APP_VERSION: revision, TEST_ACCOUNT_ROLLOUT_ENABLED: '1', ROLLOUT_E2E_DISPOSABLE: '1', DATABASE_URL: databaseUrl, WEB_PUBLIC_URL: origin,
      ...(ownerKeyPair ? { TEST_ACCOUNT_ROLLOUT_OWNER_PUBLIC_KEY_DER: ownerKeyPair.publicKey.export({ format: 'der', type: 'spki' }).toString('base64url') } : {}) } },
  };
}

function safeSubprocessDiagnostic(stderr: string | null) {
  const diagnostic = stderr?.split(/\r?\n/).find(line =>
    /^(?:Private HTTP verification failed(?: \([A-Za-z0-9:_-]+\))?; no secrets reported\.|Disposable rollout transaction failed during [a-z-]+\.)$/.test(line));
  return diagnostic ? ` Safe diagnostic: ${diagnostic}` : '';
}

function runPrivateCommand(name: string, executable: string, args: string[], cwd: string, env: NodeJS.ProcessEnv, timeout: number) {
  const result = spawnSync(executable, args, { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout, maxBuffer: 1024 * 1024 });
  if (result.error || result.status !== 0) {
    const safeDiagnostic = safeSubprocessDiagnostic(result.stderr);
    const spawnError = result.error as NodeJS.ErrnoException | undefined;
    const outcome = spawnError?.code === 'ETIMEDOUT' ? 'timed out'
      : Number.isInteger(result.status) ? `exited ${result.status}`
        : 'could not start';
    throw new Error(`Disposable ${name} subprocess ${outcome}; captured output and private paths withheld.${safeDiagnostic}`);
  }
  return result.stdout;
}

function runSignedLinuxCli(action: 'bootstrap' | 'initialize' | 'provision' | 'verify' | 'http', extra?: { activationDirectory?: string; artifactPath?: string }) {
  if (!privateDirectory || !ownerKeyPair) throw new Error('Protected Linux rehearsal files are unavailable.');
  const { approval } = inputs(action);
  const draftPath = join(privateDirectory, `${action}-${approval.operationId}.draft.json`);
  const signedPath = join(privateDirectory, `${action}-${approval.operationId}.signed.json`);
  writeFileSync(draftPath, `${JSON.stringify(approval)}\n`, { mode: 0o600, flag: 'wx' });
  const base = resolve(import.meta.dirname, '../../..');
  const environment: NodeJS.ProcessEnv = { ...process.env, NODE_ENV: 'test', WEB_PUBLIC_URL: origin, DATABASE_URL: databaseUrl,
    APP_VERSION: revision, TEST_ACCOUNT_ROLLOUT_ENABLED: '1', ROLLOUT_E2E_DISPOSABLE: '1',
    TEST_ACCOUNT_ROLLOUT_OWNER_PUBLIC_KEY_DER: ownerKeyPair.publicKey.export({ format: 'der', type: 'spki' }).toString('base64url') };
  const signer = resolve(base, 'infrastructure/scripts/production-test-rollout-owner-auth.mjs');
  const rollout = resolve(base, 'infrastructure/scripts/production-test-rollout.mjs');
  const signed = runPrivateCommand('owner-signer', process.execPath,
    [signer, '--draft', draftPath, '--owner-key', join(privateDirectory, 'owner-authentication.key'), '--output', signedPath], base, environment, 30000);
  const signerResult = JSON.parse(signed) as { action: string; keyId: string; outputPath: string };
  if (signerResult.action !== action || signerResult.outputPath !== signedPath) throw new Error('Owner signer did not bind the requested action.');
  const args = [rollout, action, '--approval', signedPath, '--credentials', join(privateDirectory, 'credentials.json')];
  if (action === 'bootstrap') {
    if (!extra?.activationDirectory) throw new Error('Bootstrap rehearsal activation directory is missing.');
    environment.PLATFORM_OWNER_BOOTSTRAP_ENABLED = '1'; args.push('--activation-directory', extra.activationDirectory);
  }
  if (action === 'initialize') {
    if (!extra?.artifactPath) throw new Error('Initialization rehearsal artifact is missing.');
    args.push('--artifact', extra.artifactPath);
  }
  const output = runPrivateCommand(action, process.execPath, args, base, environment, 120000);
  if (Object.values(passwords).some(password => output.includes(password))) throw new Error('Disposable CLI exposed a password.');
  return JSON.parse(output) as { userId?: string; activationFile?: string; ownerInitialized?: boolean; accountCount?: number;
    accounts?: Array<{ email: string; httpSignIn: string }>; ownerAuthorizationKeyId?: string };
}

describe('isolated real PostgreSQL + native HTTP rollout rehearsal', () => {
  it('bounds private subprocesses and withholds captured output on failure', () => {
    const marker = 'private-output-must-not-escape';
    let message = '';
    try {
      runPrivateCommand('synthetic', process.execPath,
        ['-e', `process.stderr.write(${JSON.stringify(marker)}); process.exit(23);`], process.cwd(), process.env, 5000);
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain('exited 23');
    expect(message).not.toContain(marker);
    expect(message).not.toContain('Safe diagnostic:');
    expect(safeSubprocessDiagnostic('unrelated private marker\nPrivate HTTP verification failed (role:denial); no secrets reported.\n'))
      .toBe(' Safe diagnostic: Private HTTP verification failed (role:denial); no secrets reported.');
    expect(safeSubprocessDiagnostic('unrelated private marker')).toBe('');
  });

  it('bootstraps through immutable mechanism, initializes privately, provisions/retries, verifies eleven HTTP identities and disables', async () => {
    if (privateDirectory) {
      const activationDirectory = join(privateDirectory, 'activation');
      mkdirSync(activationDirectory, { mode: 0o700 }); chmodSync(activationDirectory, 0o700);
      const bootstrapped = runSignedLinuxCli('bootstrap', { activationDirectory });
      if (!bootstrapped.userId || !bootstrapped.activationFile) throw new Error('Private CLI bootstrap produced no reconciliation identifiers.');
      ownerId = bootstrapped.userId;
      artifact = JSON.parse(readFileSync(bootstrapped.activationFile, 'utf8')) as typeof artifact;
      expect(runSignedLinuxCli('initialize', { artifactPath: bootstrapped.activationFile }).ownerInitialized).toBe(true);
    } else {
      const target = new URL(databaseUrl);
      const bootstrapApproval = { version: 1, environment: 'test', email: 'qa-platform-owner@truevoice.com', operationId: bootstrapOperationId,
        approvalReference: 'APPROVAL-E2E', operatorReference: 'OPERATOR-E2E', expiresAt: new Date(Date.now() + 3600000).toISOString(),
        database: { hostname: target.hostname, port: target.port || '5432', name: createdName }, applicationOrigin: 'https://localhost' };
      const result = await bootstrapPlatformOwner({ environment: 'test', email: bootstrapApproval.email, operationId: bootstrapOperationId,
        approvalFile: 'memory-private-approval', activationDirectory: 'memory-private-artifact' }, {
        environment: { NODE_ENV: 'test', PLATFORM_OWNER_BOOTSTRAP_ENABLED: '1', DATABASE_URL: databaseUrl, WEB_PUBLIC_URL: 'https://localhost' },
        readApproval: () => bootstrapApproval,
        prepareArtifact: (_directory, _operation, payload) => { artifact = payload; return { path: 'memory-only', discard: () => undefined }; },
      });
      ownerId = result.userId;
      const initialization = inputs('initialize');
      const initialized = await executePrivateHttp(initialization.approval, credentials, { artifact }, initialization.dependencies);
      expect(initialized.ownerInitialized).toBe(true);
      expect((await executePrivateHttp(initialization.approval, credentials, { artifact }, initialization.dependencies)).ownerInitialized).toBe(true);
    }
    const provision = inputs('provision');
    if (ownerKeyPair) Object.assign(provision.approval, signOwnerAuthorization(provision.approval, ownerKeyPair.privateKey, { allowTest: true }));
    const beforeAdmin = await database!.user.findUniqueOrThrow({ where: { id: adminUserId }, select: { passwordHash: true } });
    const failureClient = {
      $disconnect: async () => undefined,
      $transaction: async (work: (tx: unknown) => Promise<unknown>, options: { isolationLevel: 'Serializable'; timeout: number }) => database!.$transaction(async tx => {
        return work({ ...tx, identityAuditEvent: { ...tx.identityAuditEvent, create: async (input: Parameters<typeof tx.identityAuditEvent.create>[0]) => {
          if (input.data.id === provisionOperationId) throw new Error('Synthetic final-audit failure');
          return tx.identityAuditEvent.create(input);
        } } });
      }, options),
    };
    await expect(executeRollout(provision.approval, credentials, {}, { ...provision.dependencies, createClient: () => failureClient })).rejects.toThrow();
    expect(await database!.user.count()).toBe(2);
    expect(await database!.organization.count()).toBe(1);
    let created: { organizationId?: string; accountCount?: number };
    if (privateDirectory) {
      const provisioned = runSignedLinuxCli('provision');
      if (!provisioned.accountCount) throw new Error('Protected CLI provisioning did not report its committed batch.');
      const state = await executeRollout(provision.approval, credentials, {}, provision.dependencies);
      created = { organizationId: state.organizationId!, accountCount: state.accountCount };
      expect(created.accountCount).toBe(11);
      const concurrent = await Promise.allSettled([executeRollout(provision.approval, credentials, {}, provision.dependencies), executeRollout(provision.approval, credentials, {}, provision.dependencies)]);
      expect(concurrent.some(attempt => attempt.status === 'fulfilled')).toBe(true);
    } else {
      const initial = await Promise.allSettled([executeRollout(provision.approval, credentials, {}, provision.dependencies), executeRollout(provision.approval, credentials, {}, provision.dependencies)]);
      const success = initial.find(attempt => attempt.status === 'fulfilled');
      if (!success) throw new Error('No concurrent provisioning operation committed.');
      created = success.value;
      expect(created.accountCount).toBe(11);
      expect((await executeRollout(provision.approval, credentials, {}, provision.dependencies)).organizationId).toBe(created.organizationId);
      const concurrent = await Promise.allSettled([executeRollout(provision.approval, credentials, {}, provision.dependencies), executeRollout(provision.approval, credentials, {}, provision.dependencies)]);
      expect(concurrent.some(attempt => attempt.status === 'fulfilled')).toBe(true);
    }
    expect(await database!.user.count()).toBe(12);
    const conflict = { ...credentials, passwords: { ...passwords, 'qa-viewer@truevoice.com': randomBytes(24).toString('base64url') } };
    await expect(executeRollout(provision.approval, conflict, {}, provision.dependencies)).rejects.toThrow();
    if (privateDirectory) expect(runSignedLinuxCli('verify').accountCount).toBe(11);
    // Synthetic custodians accept real terms through HTTP; no direct insertion
    // or automatic terms acceptance is included in the production verifier.
    for (const account of ROLLOUT_ACCOUNTS) {
      const client = privateHttpClient(origin);
      await client.call('GET', '/api/auth/terms');
      expect((await client.call('POST', '/api/auth/sign-in', { email: account.email, password: passwords[account.email] })).status).toBe(200);
      expect((await client.call('POST', '/api/auth/terms/accept')).status).toBe(204);
      await client.call('POST', '/api/auth/sign-out');
    }
    const http = inputs('http');
    const verified = privateDirectory
      ? runSignedLinuxCli('http')
      : await executePrivateHttp(http.approval, credentials, {}, http.dependencies);
    expect(verified.accounts).toHaveLength(11);
    const disable = inputs('disable');
    const stale = privateHttpClient(origin);
    await stale.call('GET', '/api/auth/terms');
    await stale.call('POST', '/api/auth/sign-in', { email: 'qa-viewer@truevoice.com', password: passwords['qa-viewer@truevoice.com'] });
    const checkStale = stale.snapshot();
    await executeRollout(disable.approval, credentials, {}, disable.dependencies);
    await executeRollout(disable.approval, credentials, {}, disable.dependencies);
    await checkStale();
    expect((await stale.call('POST', '/api/auth/sign-in', { email: 'qa-viewer@truevoice.com', password: passwords['qa-viewer@truevoice.com'] })).status).toBe(401);
    const afterAdmin = await database!.user.findUniqueOrThrow({ where: { id: adminUserId }, select: { passwordHash: true } });
    expect(beforeAdmin.passwordHash === afterAdmin.passwordHash).toBe(true);
    expect(await database!.platformOwnerBootstrap.count()).toBe(1);
    expect((await database!.user.findUniqueOrThrow({ where: { id: ownerId } })).status).toBe('ACTIVE');
  }, 120000);
});
