import { execFileSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createDatabaseClient, type PrismaClient } from '@truevine/database';
import { NullEmailSender } from '@truevine/messaging';
import { hashToken } from '@truevine/auth';
import { verifyPassword } from '@truevine/auth/passwords';
import {
  bootstrapPlatformOwner,
  BOOTSTRAP_ACTION,
} from '../../../infrastructure/scripts/bootstrap-platform-owner.mjs';
import { AuthService } from '../src/auth/auth.service.js';
import {
  PrismaAuditStore,
  PrismaAuthStore,
  PrismaSecurityTransaction,
} from '../src/auth/prisma-stores.js';

const root = resolve(import.meta.dirname, '../../..');
const created = new Set<string>();
let admin: PrismaClient, db: PrismaClient, databaseName: string, databaseUrl: string;
const artifacts = new Map<string, { activationUrl: string }>();

beforeAll(async () => {
  const explicit = process.env['BOOTSTRAP_TEST_ADMIN_URL'];
  const configured = explicit ?? process.env['DATABASE_URL'];
  if (process.env['NODE_ENV'] !== 'test' || !configured)
    throw new Error('Bootstrap E2E requires explicitly disposable PostgreSQL, never production.');
  const url = new URL(configured);
  const ciDatabase = /^\/(truevine_voice|rbac_security_\d+_\d+_[a-z]+)$/.test(url.pathname);
  if (
    !['127.0.0.1', 'localhost'].includes(url.hostname) ||
    [...url.searchParams.keys()].some((key) => !['schema', 'sslmode'].includes(key)) ||
    (explicit
      ? process.env['BOOTSTRAP_E2E_DISPOSABLE'] !== '1' || url.pathname !== '/postgres'
      : process.env['CI'] !== 'true' || !ciDatabase || url.port !== '55432')
  )
    throw new Error('Bootstrap E2E target is not an opted-in disposable local instance.');
  admin = createDatabaseClient(configured, { log: [] });
  const identity = await admin.$queryRaw<
    Array<{ name: string }>
  >`SELECT current_database() AS name`;
  expect(identity[0]?.name).toBe(decodeURIComponent(url.pathname.slice(1)));
});

beforeEach(async () => {
  databaseName = `truevine_bootstrap_test_${randomBytes(8).toString('hex')}`;
  await admin.$executeRawUnsafe(`CREATE DATABASE "${databaseName}"`);
  created.add(databaseName);
  const url = new URL(process.env['BOOTSTRAP_TEST_ADMIN_URL'] ?? process.env['DATABASE_URL']!);
  url.pathname = `/${databaseName}`;
  databaseUrl = url.toString();
  if (!process.env['npm_execpath'])
    throw new Error('Run bootstrap E2E through the root npm script.');
  try {
    execFileSync(process.execPath, [process.env['npm_execpath'], 'run', 'prisma:migrate:deploy'], {
      cwd: root,
      env: { ...process.env, DATABASE_URL: databaseUrl },
      stdio: 'pipe',
      timeout: 60000,
    });
  } catch {
    throw new Error(
      'Migration application to the newly created disposable bootstrap database failed.',
    );
  }
  db = createDatabaseClient(databaseUrl, { log: [] });
  artifacts.clear();
}, 60000);

afterEach(async () => {
  if (db) await db.$disconnect();
  for (const name of [...created]) {
    if (!/^truevine_bootstrap_test_[a-f0-9]{16}$/.test(name))
      throw new Error('Unsafe test cleanup target');
    await admin.$executeRawUnsafe(`DROP DATABASE "${name}" WITH (FORCE)`);
    created.delete(name);
  }
  artifacts.clear();
});
afterAll(async () => {
  if (admin) await admin.$disconnect();
});

function attempt(email = `owner-${randomUUID()}@example.invalid`) {
  const operationId = randomUUID();
  const options = {
    email,
    environment: 'test',
    operationId,
    approvalFile: 'synthetic-private-approval',
    activationDirectory: 'synthetic-memory-vault',
  };
  const url = new URL(databaseUrl);
  const environment = {
    NODE_ENV: 'test',
    PLATFORM_OWNER_BOOTSTRAP_ENABLED: '1',
    DATABASE_URL: databaseUrl,
    WEB_PUBLIC_URL: 'https://bootstrap.example.invalid',
  };
  const approval = {
    version: 1,
    email,
    environment: 'test',
    operationId,
    database: { hostname: url.hostname, port: url.port, name: databaseName },
    applicationOrigin: environment.WEB_PUBLIC_URL,
    approvalReference: 'BOOTSTRAP-E2E-123',
    operatorReference: 'OPERATOR-SYNTHETIC',
    expiresAt: new Date(Date.now() + 3600000).toISOString(),
  };
  const dependencies = {
    environment,
    readApproval: () => approval,
    prepareArtifact: (_directory: string, id: string, payload: { activationUrl: string }) => {
      artifacts.set(id, payload);
      return {
        path: `synthetic-memory-vault/${id}`,
        discard: () => {
          artifacts.delete(id);
        },
      };
    },
  };
  return { options, dependencies };
}
function authentication() {
  return new AuthService(
    new PrismaAuthStore(db),
    new PrismaAuditStore(db),
    { consume: async () => ({ allowed: true, remaining: 100, retryAfterMs: 0 }) },
    new NullEmailSender(),
    'https://bootstrap.example.invalid',
    5,
    60000,
    60000,
    new PrismaSecurityTransaction(db),
  );
}
async function bootstrap() {
  const f = attempt();
  const result = await bootstrapPlatformOwner(f.options, f.dependencies);
  const token = new URL(artifacts.get(f.options.operationId)!.activationUrl).searchParams.get(
    'token',
  )!;
  return { ...f, result, token };
}

describe('first Platform Owner bootstrap on fresh disposable PostgreSQL', () => {
  it('verifies the production-mode cluster fingerprint on this disposable connection before writes', async () => {
    const f = attempt();
    const cluster = await db.$queryRaw<
      Array<{ name: string }>
    >`SELECT system_identifier::text AS name FROM pg_catalog.pg_control_system()`;
    const systemIdentifier = cluster[0]!.name;
    const approval = {
      ...f.dependencies.readApproval(),
      environment: 'production',
      productionAuthorized: true,
      applicationOrigin: 'https://voice.truevinecloud.online',
    };
    const dependencies = {
      ...f.dependencies,
      environment: {
        ...f.dependencies.environment,
        NODE_ENV: 'production',
        WEB_PUBLIC_URL: approval.applicationOrigin,
      },
      readApproval: () => ({
        ...approval,
        database: {
          ...approval.database,
          systemIdentifier: (BigInt(systemIdentifier) + 1n).toString(),
        },
      }),
    };
    const options = { ...f.options, environment: 'production', confirmProduction: true };
    await expect(bootstrapPlatformOwner(options, dependencies)).rejects.toThrow('cluster_mismatch');
    expect(await db.user.count()).toBe(0);
    dependencies.readApproval = () => ({
      ...approval,
      database: { ...approval.database, systemIdentifier },
    });
    await bootstrapPlatformOwner(options, dependencies);
    expect(await db.platformOwnerBootstrap.count()).toBe(1);
  });
  it('runs the real private-file CLI on Linux and refuses unsupported operator platforms', async () => {
    const f = attempt();
    if (process.platform !== 'linux') {
      await expect(
        bootstrapPlatformOwner(
          { ...f.options, approvalFile: resolve(tmpdir(), 'synthetic-bootstrap-approval.json') },
          { environment: f.dependencies.environment },
        ),
      ).rejects.toThrow('requires_linux');
      expect(await db.user.count()).toBe(0);
      return;
    }
    const directory = mkdtempSync(join(tmpdir(), 'truevine-bootstrap-cli-test-'));
    if (!resolve(directory).startsWith(`${resolve(tmpdir())}${sep}truevine-bootstrap-cli-test-`))
      throw new Error('Unsafe temporary CLI test cleanup target');
    chmodSync(directory, 0o700);
    try {
      const approvalFile = join(directory, 'approval.json');
      writeFileSync(approvalFile, JSON.stringify(f.dependencies.readApproval()), {
        mode: 0o600,
        flag: 'wx',
      });
      let output: string;
      try {
        output = execFileSync(
          process.execPath,
          [
            resolve(root, 'infrastructure/scripts/bootstrap-platform-owner.mjs'),
            '--environment',
            'test',
            '--email',
            f.options.email,
            '--operation-id',
            f.options.operationId,
            '--approval-file',
            approvalFile,
            '--activation-directory',
            directory,
          ],
          {
            cwd: root,
            env: { ...process.env, ...f.dependencies.environment },
            stdio: 'pipe',
            timeout: 30000,
          },
        ).toString();
      } catch {
        throw new Error('Disposable Linux bootstrap CLI failed; output withheld.');
      }
      const artifact = join(directory, `platform-owner-${f.options.operationId}.json`);
      expect(statSync(artifact).mode & 0o777).toBe(0o600);
      const token = new URL(
        JSON.parse(readFileSync(artifact, 'utf8')).activationUrl,
      ).searchParams.get('token')!;
      expect(output.includes(token)).toBe(false);
      expect(output.includes(databaseUrl)).toBe(false);
      expect(await db.platformOwnerBootstrap.count()).toBe(1);
      const stored = await db.passwordResetToken.findFirstOrThrow();
      expect(stored.tokenHash === hashToken(token)).toBe(true);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
  it('commits one new platform-only identity, activation hash, attributed audit and immutable claim', async () => {
    const f = await bootstrap();
    const user = await db.user.findUniqueOrThrow({
      where: { id: f.result.userId },
      include: { platformRole: true, memberships: true },
    });
    expect(user.platformRole).toMatchObject({
      role: 'PLATFORM_OWNER',
      grantedByUserId: null,
      revokedAt: null,
    });
    expect(user.memberships).toHaveLength(0);
    const token = await db.passwordResetToken.findFirstOrThrow({ where: { userId: user.id } });
    expect(token.tokenHash).toBe(hashToken(f.token));
    expect(token.usedAt).toBeNull();
    expect(token.expiresAt.getTime() - token.createdAt.getTime()).toBeGreaterThan(23 * 3600000);
    const claim = await db.platformOwnerBootstrap.findUniqueOrThrow({
      where: { slot: 'first_platform_owner' },
    });
    const audit = await db.identityAuditEvent.findUniqueOrThrow({
      where: { id: claim.auditEventId },
    });
    expect(audit).toMatchObject({
      actorUserId: user.id,
      action: BOOTSTRAP_ACTION,
      outcome: 'SUCCESS',
      metadata: {
        actorKind: 'external_operator',
        operatorReference: 'OPERATOR-SYNTHETIC',
        approvalReference: 'BOOTSTRAP-E2E-123',
        subjectUserId: user.id,
        operationId: f.options.operationId,
      },
    });
    expect(JSON.stringify(audit).includes(f.token)).toBe(false);
    await expect(
      db.platformOwnerBootstrap.delete({ where: { slot: claim.slot } }),
    ).rejects.toThrow();
    await expect(
      db.platformOwnerBootstrap.update({
        where: { slot: claim.slot },
        data: { operationId: randomUUID() },
      }),
    ).rejects.toThrow();
    await expect(db.$executeRawUnsafe('TRUNCATE platform_owner_bootstrap')).rejects.toThrow();
    await expect(db.identityAuditEvent.delete({ where: { id: audit.id } })).rejects.toThrow();
  });

  it('rejects a duplicate while activation is pending and never reopens after revocation', async () => {
    const f = await bootstrap();
    const second = attempt();
    await expect(bootstrapPlatformOwner(second.options, second.dependencies)).rejects.toThrow(
      'already_exists',
    );
    await db.platformRoleAssignment.update({
      where: { userId: f.result.userId },
      data: { revokedAt: new Date() },
    });
    const third = attempt();
    await expect(bootstrapPlatformOwner(third.options, third.dependencies)).rejects.toThrow(
      'already_exists',
    );
    expect(await db.user.count()).toBe(1);
    expect(await db.identityAuditEvent.count({ where: { action: BOOTSTRAP_ACTION } })).toBe(1);
  });

  it('serializes simultaneous bootstrap attempts with different identities', async () => {
    const a = attempt(),
      b = attempt();
    const results = await Promise.allSettled([
      bootstrapPlatformOwner(a.options, a.dependencies),
      bootstrapPlatformOwner(b.options, b.dependencies),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    expect(await db.user.count()).toBe(1);
    expect(await db.platformRoleAssignment.count()).toBe(1);
    expect(await db.passwordResetToken.count()).toBe(1);
    expect(await db.identityAuditEvent.count()).toBe(1);
    expect(await db.platformOwnerBootstrap.count()).toBe(1);
  });

  it('refuses a pre-existing Platform Owner without relying on a bootstrap claim', async () => {
    const existing = await db.user.create({
      data: { email: 'existing-owner@example.invalid', passwordHash: 'synthetic-unusable' },
    });
    await db.platformRoleAssignment.create({
      data: { userId: existing.id, role: 'PLATFORM_OWNER' },
    });
    const f = attempt();
    await expect(bootstrapPlatformOwner(f.options, f.dependencies)).rejects.toThrow(
      'already_exists',
    );
    expect(await db.user.count()).toBe(1);
    expect(await db.platformOwnerBootstrap.count()).toBe(0);
    expect(await db.identityAuditEvent.count()).toBe(0);
  });

  it('cannot satisfy the claim trigger using caller temporary role tables', async () => {
    const user = await db.user.create({
      data: { email: 'shadow-test@example.invalid', passwordHash: 'synthetic-unusable' },
    });
    const operationId = randomUUID();
    const audit = await db.identityAuditEvent.create({
      data: {
        actorUserId: user.id,
        action: BOOTSTRAP_ACTION,
        outcome: 'SUCCESS',
        metadata: { operationId, subjectUserId: user.id, actorKind: 'external_operator' },
      },
    });
    await expect(
      db.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(
          'CREATE TEMP TABLE platform_role_assignments (user_id uuid, role text, revoked_at timestamptz) ON COMMIT DROP',
        );
        await tx.$executeRaw`INSERT INTO pg_temp.platform_role_assignments VALUES (${user.id}::uuid, 'PLATFORM_OWNER', NULL)`;
        await tx.platformOwnerBootstrap.create({
          data: {
            slot: 'first_platform_owner',
            operationId,
            userId: user.id,
            auditEventId: audit.id,
          },
        });
      }),
    ).rejects.toThrow('requires its role and success audit');
    expect(await db.platformRoleAssignment.count()).toBe(0);
    expect(await db.platformOwnerBootstrap.count()).toBe(0);
  });

  it('rolls back the success audit and every identity row if the final claim insert fails', async () => {
    await db.$executeRawUnsafe(`CREATE FUNCTION reject_bootstrap_claim() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'synthetic claim failure'; END; $$`);
    await db.$executeRawUnsafe(
      'CREATE TRIGGER reject_bootstrap_claim BEFORE INSERT ON platform_owner_bootstrap FOR EACH ROW EXECUTE FUNCTION reject_bootstrap_claim()',
    );
    const f = attempt();
    await expect(bootstrapPlatformOwner(f.options, f.dependencies)).rejects.toThrow(
      'outcome_unverified',
    );
    expect(await db.user.count()).toBe(0);
    expect(await db.platformRoleAssignment.count()).toBe(0);
    expect(await db.passwordResetToken.count()).toBe(0);
    expect(await db.identityAuditEvent.count()).toBe(0);
    expect(await db.platformOwnerBootstrap.count()).toBe(0);
  });

  it('refuses an existing identity without changing credentials or roles', async () => {
    const f = attempt();
    const user = await db.user.create({
      data: { email: f.options.email, passwordHash: 'existing-unusable-hash' },
    });
    await expect(bootstrapPlatformOwner(f.options, f.dependencies)).rejects.toThrow(
      'identity_already_exists',
    );
    expect(await db.user.findUnique({ where: { id: user.id } })).toEqual(user);
    expect(await db.platformRoleAssignment.count()).toBe(0);
    expect(await db.identityAuditEvent.count()).toBe(0);
  });

  it('rolls back identity, role, activation and claim if the actual audit insertion fails', async () => {
    await db.$executeRawUnsafe(`CREATE FUNCTION reject_bootstrap_audit() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.action = 'platform.owner.bootstrapped' THEN RAISE EXCEPTION 'synthetic audit failure'; END IF; RETURN NEW; END; $$`);
    await db.$executeRawUnsafe(
      'CREATE TRIGGER reject_bootstrap_audit BEFORE INSERT ON identity_audit_events FOR EACH ROW EXECUTE FUNCTION reject_bootstrap_audit()',
    );
    const f = attempt();
    await expect(bootstrapPlatformOwner(f.options, f.dependencies)).rejects.toThrow(
      'outcome_unverified',
    );
    expect(await db.user.count()).toBe(0);
    expect(await db.platformRoleAssignment.count()).toBe(0);
    expect(await db.passwordResetToken.count()).toBe(0);
    expect(await db.identityAuditEvent.count()).toBe(0);
    expect(await db.platformOwnerBootstrap.count()).toBe(0);
  });

  it('sets the initial password once through the real activation contract; reuse cannot overwrite it', async () => {
    const f = await bootstrap(),
      service = authentication();
    const password = 'Synthetic-owner-initial-passphrase-2026';
    await service.completePasswordReset(f.token, password);
    const user = await db.user.findUniqueOrThrow({ where: { id: f.result.userId } });
    expect(await verifyPassword(user.passwordHash, password)).toBe(true);
    await expect(
      service.completePasswordReset(f.token, 'Different-synthetic-passphrase-2026'),
    ).rejects.toThrow('already been used');
    expect((await db.user.findUniqueOrThrow({ where: { id: user.id } })).passwordHash).toBe(
      user.passwordHash,
    );
    expect(
      await db.identityAuditEvent.count({ where: { action: 'auth.password_reset_completed' } }),
    ).toBe(1);
  });

  it('rejects expired activation without changing the initial unusable password', async () => {
    const f = await bootstrap(),
      service = authentication();
    const before = await db.user.findUniqueOrThrow({ where: { id: f.result.userId } });
    await db.passwordResetToken.updateMany({
      where: { userId: before.id },
      data: { expiresAt: new Date(0) },
    });
    await expect(
      service.completePasswordReset(f.token, 'Synthetic-expiration-passphrase-2026'),
    ).rejects.toThrow('not valid');
    expect((await db.user.findUniqueOrThrow({ where: { id: before.id } })).passwordHash).toBe(
      before.passwordHash,
    );
    expect(
      await db.identityAuditEvent.count({ where: { action: 'auth.password_reset_completed' } }),
    ).toBe(0);
  });
});
