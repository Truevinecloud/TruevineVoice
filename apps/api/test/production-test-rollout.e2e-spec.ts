import { execFileSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
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

let admin: PrismaClient | undefined;
let database: PrismaClient | undefined;
let app: INestApplication | undefined;
let createdName: string | undefined;
let databaseUrl: string;
let origin: string;
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
  origin = await app.getUrl();
}, 60000);

afterAll(async () => {
  await app?.close(); await database?.$disconnect();
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
    approval: { version: 1, action, environment: 'test', releaseSha: revision, provisioningReleaseSha: revision, operationId: action === 'provision' ? provisionOperationId : randomUUID(),
      bootstrapOperationId, provisionOperationId, inventoryDigest: INVENTORY_DIGEST, credentialReference: credentials.reference,
      email: 'qa-platform-owner@truevoice.com', actorUserId: ownerId,
      approvalReference: 'APPROVAL-E2E', operatorReference: 'OPERATOR-E2E', rehearsalReference: 'REHEARSAL-E2E',
      expiresAt: new Date(Date.now() + 3600000).toISOString(), applicationOrigin: origin, bootstrapApplicationOrigin: 'https://localhost', httpAuthorized: true,
      preservedAdmin: { userId: adminUserId, organizationId: adminOrganizationId },
      isolationOrganizationId: adminOrganizationId, isolationFixtureAuthorized: true,
      database: { hostname: target.hostname, port: target.port || '5432', name: createdName, systemIdentifier } },
    dependencies: { environment: { NODE_ENV: 'test', APP_VERSION: revision, TEST_ACCOUNT_ROLLOUT_ENABLED: '1', ROLLOUT_E2E_DISPOSABLE: '1', DATABASE_URL: databaseUrl, WEB_PUBLIC_URL: origin } },
  };
}

describe('isolated real PostgreSQL + native HTTP rollout rehearsal', () => {
  it('bootstraps through immutable mechanism, initializes privately, provisions/retries, verifies eleven HTTP identities and disables', async () => {
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
    const provision = inputs('provision');
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
    const initial = await Promise.allSettled([executeRollout(provision.approval, credentials, {}, provision.dependencies), executeRollout(provision.approval, credentials, {}, provision.dependencies)]);
    const success = initial.find(attempt => attempt.status === 'fulfilled');
    if (!success) throw new Error('No concurrent provisioning operation committed.');
    const created = success.value;
    expect(created.accountCount).toBe(11);
    expect((await executeRollout(provision.approval, credentials, {}, provision.dependencies)).organizationId).toBe(created.organizationId);
    const concurrent = await Promise.allSettled([executeRollout(provision.approval, credentials, {}, provision.dependencies), executeRollout(provision.approval, credentials, {}, provision.dependencies)]);
    expect(concurrent.some(attempt => attempt.status === 'fulfilled')).toBe(true);
    expect(await database!.user.count()).toBe(12);
    const conflict = { ...credentials, passwords: { ...passwords, 'qa-viewer@truevoice.com': randomBytes(24).toString('base64url') } };
    await expect(executeRollout(provision.approval, conflict, {}, provision.dependencies)).rejects.toThrow();
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
    const verified = await executePrivateHttp(http.approval, credentials, {}, http.dependencies);
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
