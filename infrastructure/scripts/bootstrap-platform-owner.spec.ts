import { randomUUID } from 'node:crypto';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { hashToken } from '@truevine/auth';
import {
  assertPrivateStat,
  bootstrapPlatformOwner,
  BOOTSTRAP_ACTION,
  BOOTSTRAP_SLOT,
  main,
  prepareBootstrapArtifact,
  readBootstrapApproval,
  validateBootstrapApproval,
} from './bootstrap-platform-owner.mjs';

const now = new Date('2026-10-20T18:00:00Z');
const databaseName = 'truevine_bootstrap_test_0123456789abcdef';
function inputs() {
  const options = {
    environment: 'test',
    email: 'new-owner@example.invalid',
    operationId: randomUUID(),
    approvalFile: '/private/approval.json',
    activationDirectory: '/private/activation',
  };
  const environment = {
    NODE_ENV: 'test',
    PLATFORM_OWNER_BOOTSTRAP_ENABLED: '1',
    DATABASE_URL: `postgresql://synthetic:synthetic@127.0.0.1:55432/${databaseName}`,
    WEB_PUBLIC_URL: 'https://uat.example.invalid',
  };
  const approval = {
    version: 1,
    ...options,
    database: { hostname: '127.0.0.1', port: '55432', name: databaseName },
    applicationOrigin: environment.WEB_PUBLIC_URL,
    approvalReference: 'BOOTSTRAP-TEST-123',
    operatorReference: 'OPERATOR-TEST',
    expiresAt: new Date(now.getTime() + 3600000).toISOString(),
  };
  return { options, environment, approval };
}
function fixture() {
  const input = inputs();
  const transaction = {
    $queryRaw: vi.fn().mockResolvedValue([{ name: databaseName }]),
    platformOwnerBootstrap: {
      findUnique: vi.fn().mockResolvedValue(null as unknown),
      create: vi.fn(),
    },
    platformRoleAssignment: {
      findFirst: vi.fn().mockResolvedValue(null as unknown),
      create: vi.fn(),
    },
    user: { findUnique: vi.fn().mockResolvedValue(null as unknown), create: vi.fn() },
    passwordResetToken: { create: vi.fn() },
    identityAuditEvent: { create: vi.fn() },
  };
  const db = {
    $transaction: vi.fn(async (work: (tx: typeof transaction) => Promise<unknown>) =>
      work(transaction),
    ),
    $disconnect: vi.fn().mockResolvedValue(undefined),
  };
  const artifact = { path: '/private/activation/artifact.json', discard: vi.fn() };
  const dependencies = {
    environment: input.environment,
    now: () => now,
    readApproval: vi.fn(() => input.approval),
    prepareArtifact: vi.fn(
      (_directory: string, _operationId: string, _payload: unknown) => artifact,
    ),
    createClient: vi.fn((_url: string, _options: { log: string[] }) => db),
    hashPassword: vi.fn().mockResolvedValue('synthetic-unusable-hash'),
  };
  return { ...input, transaction, db, artifact, dependencies };
}
describe('first Platform Owner authorization', () => {
  it('accepts an exact authorized disposable target', () => {
    const { options, environment, approval } = inputs();
    expect(validateBootstrapApproval(options, environment, approval, now)).toMatchObject({
      databaseName,
    });
  });
  it.each(['', '0'])('refuses missing explicit opt-in (%s)', (flag) => {
    const { options, environment, approval } = inputs();
    environment.PLATFORM_OWNER_BOOTSTRAP_ENABLED = flag;
    expect(() => validateBootstrapApproval(options, environment, approval, now)).toThrow(
      'not_authorized',
    );
  });
  it.each(['development', '', 'production'])('refuses contradictory environment %s', (value) => {
    const { options, environment, approval } = inputs();
    environment.NODE_ENV = value;
    expect(() => validateBootstrapApproval(options, environment, approval, now)).toThrow(
      'environment',
    );
  });
  it.each(['approvalReference', 'operatorReference', 'operationId', 'email'])(
    'requires matching approval field %s',
    (field) => {
      const { options, environment, approval } = inputs();
      expect(() =>
        validateBootstrapApproval(options, environment, { ...approval, [field]: '' }, now),
      ).toThrow('approval_mismatch');
    },
  );
  it('rejects expired and excessively long approval windows', () => {
    const { options, environment, approval } = inputs();
    for (const expiresAt of [
      'invalid',
      now.toISOString(),
      new Date(now.getTime() + 86400001).toISOString(),
    ])
      expect(() =>
        validateBootstrapApproval(options, environment, { ...approval, expiresAt }, now),
      ).toThrow('expired');
  });
  it.each([
    `postgresql://u:p@127.0.0.1:55433/${databaseName}`,
    `postgresql://u:p@127.0.0.1:55432/${databaseName}?host=elsewhere`,
    `postgresql://u:p@127.0.0.1:55432/${databaseName}?schema=other`,
    `postgresql://u:p@127.0.0.1:55432/${databaseName}?schema=public&schema=other`,
    `postgresql://u:p@prod.example:55432/${databaseName}`,
  ])('refuses mismatched or redirected database inventory', (url) => {
    const { options, environment, approval } = inputs();
    expect(() =>
      validateBootstrapApproval(options, { ...environment, DATABASE_URL: url }, approval, now),
    ).toThrow('mismatch');
  });
  it('requires an independently approved production confirmation', () => {
    const { options, environment, approval } = inputs();
    const prodOptions = { ...options, environment: 'production', confirmProduction: true };
    const prodEnv = {
      ...environment,
      NODE_ENV: 'production',
      WEB_PUBLIC_URL: 'https://voice.truevinecloud.online',
    };
    const prodApproval = {
      ...approval,
      environment: 'production',
      applicationOrigin: prodEnv.WEB_PUBLIC_URL,
      productionAuthorized: true,
      database: { ...approval.database, systemIdentifier: '1234567890123456789' },
    };
    expect(() => validateBootstrapApproval(prodOptions, prodEnv, prodApproval, now)).not.toThrow();
    expect(() =>
      validateBootstrapApproval(
        { ...prodOptions, confirmProduction: false },
        prodEnv,
        prodApproval,
        now,
      ),
    ).toThrow('not_authorized');
    expect(() =>
      validateBootstrapApproval(
        prodOptions,
        prodEnv,
        { ...prodApproval, productionAuthorized: false },
        now,
      ),
    ).toThrow('not_authorized');
    expect(() =>
      validateBootstrapApproval(
        prodOptions,
        prodEnv,
        { ...prodApproval, database: { ...prodApproval.database, systemIdentifier: '' } },
        now,
      ),
    ).toThrow('identity_required');
  });
  it('fails before creating a client or artifact when approval is absent', async () => {
    const f = fixture();
    f.dependencies.readApproval.mockReturnValue(undefined as never);
    await expect(bootstrapPlatformOwner(f.options, f.dependencies)).rejects.toThrow();
    expect(f.dependencies.createClient).not.toHaveBeenCalled();
    expect(f.dependencies.prepareArtifact).not.toHaveBeenCalled();
  });
  it('does not open approval files without process authorization', async () => {
    const f = fixture();
    f.dependencies.environment.PLATFORM_OWNER_BOOTSTRAP_ENABLED = '0';
    await expect(bootstrapPlatformOwner(f.options, f.dependencies)).rejects.toThrow(
      'not_authorized',
    );
    expect(f.dependencies.readApproval).not.toHaveBeenCalled();
    expect(f.dependencies.createClient).not.toHaveBeenCalled();
  });
  it('refuses staging labels on an unapproved database name', () => {
    const { options, environment, approval } = inputs();
    expect(() =>
      validateBootstrapApproval(
        { ...options, environment: 'staging' },
        { ...environment, NODE_ENV: 'staging' },
        { ...approval, environment: 'staging' },
        now,
      ),
    ).toThrow('not_allowlisted');
  });
});

describe('first-owner orchestration and private handoff', () => {
  it('creates only a new platform identity, hashed activation, role, audit and fixed claim', async () => {
    const f = fixture();
    const result = await bootstrapPlatformOwner(f.options, f.dependencies);
    expect(f.dependencies.createClient).toHaveBeenCalledWith(f.environment.DATABASE_URL, {
      log: [],
    });
    expect(f.db.$transaction).toHaveBeenCalledWith(expect.any(Function), {
      isolationLevel: 'Serializable',
    });
    expect(f.transaction.user.create).toHaveBeenCalledWith({
      data: {
        id: result.userId,
        email: f.options.email,
        passwordHash: 'synthetic-unusable-hash',
      },
    });
    expect(f.transaction.platformRoleAssignment.create).toHaveBeenCalledWith({
      data: { userId: result.userId, role: 'PLATFORM_OWNER' },
    });
    const payload = f.dependencies.prepareArtifact.mock.calls[0]?.[2] as { activationUrl: string };
    const rawToken = new URL(payload.activationUrl).searchParams.get('token')!;
    expect(rawToken.length).toBeGreaterThan(20);
    expect(f.transaction.passwordResetToken.create).toHaveBeenCalledWith({
      data: {
        userId: result.userId,
        tokenHash: hashToken(rawToken),
        expiresAt: new Date(now.getTime() + 86400000),
      },
    });
    expect(f.transaction.identityAuditEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        actorUserId: result.userId,
        action: BOOTSTRAP_ACTION,
        outcome: 'SUCCESS',
        metadata: expect.objectContaining({
          actorKind: 'external_operator',
          operatorReference: 'OPERATOR-TEST',
          approvalReference: 'BOOTSTRAP-TEST-123',
          operationId: f.options.operationId,
          subjectUserId: result.userId,
        }),
      }),
    });
    expect(f.transaction.platformOwnerBootstrap.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ slot: BOOTSTRAP_SLOT, userId: result.userId }),
    });
    expect(JSON.stringify(result).includes(rawToken)).toBe(false);
    expect(
      JSON.stringify(f.transaction.identityAuditEvent.create.mock.calls).includes(rawToken),
    ).toBe(false);
    expect(f.db.$disconnect).toHaveBeenCalledOnce();
    expect(f.artifact.discard).not.toHaveBeenCalled();
  });
  it.each(['claim', 'role', 'identity'])(
    'refuses existing %s without mutating it',
    async (conflict) => {
      const f = fixture();
      if (conflict === 'claim')
        f.transaction.platformOwnerBootstrap.findUnique.mockResolvedValue({ slot: BOOTSTRAP_SLOT });
      if (conflict === 'role')
        f.transaction.platformRoleAssignment.findFirst.mockResolvedValue({ revokedAt: now });
      if (conflict === 'identity')
        f.transaction.user.findUnique.mockResolvedValue({ id: randomUUID() });
      await expect(bootstrapPlatformOwner(f.options, f.dependencies)).rejects.toThrow(
        'already_exists',
      );
      expect(f.transaction.user.create).not.toHaveBeenCalled();
      expect(f.transaction.platformRoleAssignment.create).not.toHaveBeenCalled();
      expect(f.artifact.discard).toHaveBeenCalledOnce();
      expect(f.db.$disconnect).toHaveBeenCalledOnce();
    },
  );
  it.each(['P2002', 'P2034'])(
    'handles definite concurrent rollback %s without duplicate credentials',
    async (code) => {
      const f = fixture();
      f.db.$transaction.mockRejectedValue({ code });
      await expect(bootstrapPlatformOwner(f.options, f.dependencies)).rejects.toThrow(
        'concurrent_attempt',
      );
      expect(f.artifact.discard).toHaveBeenCalledOnce();
    },
  );
  it('preserves the artifact and redacts an ambiguous transaction failure', async () => {
    const f = fixture();
    f.db.$transaction.mockImplementation(async (work) => {
      await work(f.transaction);
      throw new Error('credential-shaped-private-detail');
    });
    await expect(bootstrapPlatformOwner(f.options, f.dependencies)).rejects.toThrow(
      'outcome_unverified',
    );
    expect(f.transaction.platformOwnerBootstrap.create).toHaveBeenCalledOnce();
    expect(f.artifact.discard).not.toHaveBeenCalled();
  });
  it('rechecks approval expiration after slow credential preparation', async () => {
    const f = fixture();
    f.dependencies.now = vi
      .fn()
      .mockReturnValueOnce(now)
      .mockReturnValue(new Date(now.getTime() + 7200000));
    await expect(bootstrapPlatformOwner(f.options, f.dependencies)).rejects.toThrow(
      'approval_expired',
    );
    expect(f.transaction.user.create).not.toHaveBeenCalled();
    expect(f.artifact.discard).toHaveBeenCalledOnce();
  });
  it('reports failed artifact retirement without hiding the reconciliation requirement', async () => {
    const f = fixture();
    f.transaction.user.findUnique.mockResolvedValue({ id: randomUUID() });
    f.artifact.discard.mockImplementation(() => {
      throw new Error('private filesystem detail');
    });
    await expect(bootstrapPlatformOwner(f.options, f.dependencies)).rejects.toThrow(
      'cleanup_failed_reconcile',
    );
    expect(f.transaction.user.create).not.toHaveBeenCalled();
  });
  it('never starts a transaction after private-file preparation fails', async () => {
    const f = fixture();
    f.dependencies.prepareArtifact.mockImplementation(() => {
      throw new Error('disk full');
    });
    await expect(bootstrapPlatformOwner(f.options, f.dependencies)).rejects.toThrow();
    expect(f.dependencies.createClient).not.toHaveBeenCalled();
  });
  it('refuses a connection to the wrong database before creating any identity', async () => {
    const f = fixture();
    f.transaction.$queryRaw.mockResolvedValue([{ name: 'different_database' }]);
    await expect(bootstrapPlatformOwner(f.options, f.dependencies)).rejects.toThrow(
      'connected_database_mismatch',
    );
    expect(f.transaction.user.create).not.toHaveBeenCalled();
    expect(f.artifact.discard).toHaveBeenCalledOnce();
  });
  it('reports lifecycle shutdown failure rather than claiming success', async () => {
    const f = fixture();
    f.db.$disconnect.mockRejectedValue(new Error('private detail'));
    await expect(bootstrapPlatformOwner(f.options, f.dependencies)).rejects.toThrow(
      'shutdown_failed',
    );
    expect(f.artifact.discard).not.toHaveBeenCalled();
  });
  it.each(['different-cluster', '1234567890123456789'])(
    'checks the approved production cluster before writes (%s)',
    async (cluster) => {
      const f = fixture();
      const options = { ...f.options, environment: 'production', confirmProduction: true };
      f.dependencies.environment.NODE_ENV = 'production';
      f.dependencies.environment.WEB_PUBLIC_URL = 'https://voice.truevinecloud.online';
      f.dependencies.readApproval.mockReturnValue({
        ...f.approval,
        environment: 'production',
        applicationOrigin: f.dependencies.environment.WEB_PUBLIC_URL,
        productionAuthorized: true,
        database: { ...f.approval.database, systemIdentifier: '1234567890123456789' },
      } as typeof f.approval);
      f.transaction.$queryRaw
        .mockResolvedValueOnce([{ name: databaseName }])
        .mockResolvedValueOnce([{ name: cluster }]);
      if (cluster === 'different-cluster') {
        await expect(bootstrapPlatformOwner(options, f.dependencies)).rejects.toThrow(
          'cluster_mismatch',
        );
        expect(f.transaction.user.create).not.toHaveBeenCalled();
        expect(f.artifact.discard).toHaveBeenCalledOnce();
      } else {
        await bootstrapPlatformOwner(options, f.dependencies);
        expect(f.transaction.user.create).toHaveBeenCalledOnce();
      }
    },
  );
  it('rejects path traversal in operation IDs before filesystem access', () => {
    expect(() => prepareBootstrapArtifact('/private', '../../elsewhere', {})).toThrow(
      'invalid_bootstrap_operation_id',
    );
  });
  it('refuses incorrect file owner, mode, type and hard links', () => {
    const stat = { uid: 1000, mode: 0o600, nlink: 1, isFile: () => true, isDirectory: () => false };
    expect(() => assertPrivateStat(stat, 1000, false)).not.toThrow();
    for (const invalid of [
      { ...stat, uid: 1001 },
      { ...stat, mode: 0o644 },
      { ...stat, mode: 0o4600 },
      { ...stat, nlink: 2 },
      { ...stat, isFile: () => false },
    ])
      expect(() => assertPrivateStat(invalid, 1000, false)).toThrow('permissions');
  });
  it('never allows a relative artifact directory on any platform', () => {
    expect(() => prepareBootstrapArtifact('.', randomUUID(), {})).toThrow();
  });
  it('enforces the actual private-file contract on Linux and refuses other operator platforms', () => {
    if (process.platform !== 'linux') {
      expect(() => readBootstrapApproval('/synthetic/approval.json')).toThrow('requires_linux');
      expect(() =>
        prepareBootstrapArtifact('/synthetic', randomUUID(), {
          operationId: randomUUID(),
          email: 'synthetic@example.invalid',
          expiresAt: now.toISOString(),
          activationUrl: 'https://uat.example.invalid/set-password?token=synthetic-only',
        }),
      ).toThrow('requires_linux');
      return;
    }
    const root = mkdtempSync(join(tmpdir(), 'truevine-bootstrap-private-test-'));
    if (!resolve(root).startsWith(`${resolve(tmpdir())}${sep}truevine-bootstrap-private-test-`))
      throw new Error('Unsafe temporary test cleanup target');
    chmodSync(root, 0o700);
    const approvalPath = join(root, 'approval.json');
    const approval = inputs().approval;
    try {
      writeFileSync(approvalPath, JSON.stringify(approval), { mode: 0o600, flag: 'wx' });
      expect(readBootstrapApproval(approvalPath)).toEqual(approval);
      const operationId = randomUUID();
      const payload = {
        operationId,
        email: 'synthetic@example.invalid',
        expiresAt: now.toISOString(),
        activationUrl: 'https://uat.example.invalid/set-password?token=synthetic-only',
      };
      const artifact = prepareBootstrapArtifact(root, operationId, payload);
      expect(statSync(artifact.path).mode & 0o777).toBe(0o600);
      expect(JSON.parse(readFileSync(artifact.path, 'utf8'))).toEqual(payload);
      expect(() => prepareBootstrapArtifact(root, operationId, payload)).toThrow();
      const link = join(root, 'approval-link.json');
      symlinkSync(approvalPath, link);
      expect(() => readBootstrapApproval(link)).toThrow();
      chmodSync(approvalPath, 0o644);
      expect(() => readBootstrapApproval(approvalPath)).toThrow('permissions');
      const unsafeParent = join(root, 'shared');
      mkdirSync(unsafeParent, { mode: 0o777 });
      chmodSync(unsafeParent, 0o777);
      const privateLeaf = join(unsafeParent, 'private');
      mkdirSync(privateLeaf, { mode: 0o700 });
      expect(() => prepareBootstrapArtifact(privateLeaf, randomUUID(), payload)).toThrow(
        'directory_ancestor',
      );
      const original = `${artifact.path}.original`;
      renameSync(artifact.path, original);
      writeFileSync(artifact.path, 'replacement', { mode: 0o600, flag: 'wx' });
      expect(() => artifact.discard()).toThrow('artifact_replaced');
      expect(readFileSync(artifact.path, 'utf8')).toBe('replacement');
      rmSync(artifact.path);
      renameSync(original, artifact.path);
      artifact.discard();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
  it('prints only operation and file location from the CLI', async () => {
    const f = fixture();
    const output = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    try {
      await main(
        [
          '--environment',
          'test',
          '--email',
          f.options.email,
          '--operation-id',
          f.options.operationId,
          '--approval-file',
          f.options.approvalFile,
          '--activation-directory',
          f.options.activationDirectory,
        ],
        f.environment,
        f.dependencies,
      );
      const payload = f.dependencies.prepareArtifact.mock.calls[0]?.[2] as {
        activationUrl: string;
      };
      expect(
        output.mock.calls
          .flat()
          .join('')
          .includes(new URL(payload.activationUrl).searchParams.get('token')!),
      ).toBe(false);
      expect(output.mock.calls.flat().join('').includes(f.environment.DATABASE_URL)).toBe(false);
    } finally {
      output.mockRestore();
    }
  });
});
