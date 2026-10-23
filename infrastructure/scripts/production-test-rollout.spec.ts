import { randomBytes, randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { hashToken } from '@truevine/auth';
import { hashPassword, verifyPassword } from '@truevine/auth/passwords';
const path = './production-test-rollout.mjs';
const { executeRollout, validateRollout, INVENTORY_DIGEST, ROLLOUT_ACCOUNTS } = await import(path);

async function rolloutFixture() {
  const credentials = { version: 1, reference: 'CREDENTIALS-TEST', passwords: Object.fromEntries(ROLLOUT_ACCOUNTS.map(account => [account.email, randomBytes(24).toString('base64url')])) };
  const environment = { NODE_ENV: 'test', TEST_ACCOUNT_ROLLOUT_ENABLED: '1', ROLLOUT_E2E_DISPOSABLE: '1', APP_VERSION: 'a'.repeat(40),
    WEB_PUBLIC_URL: 'http://127.0.0.1:3100', DATABASE_URL: 'postgresql://127.0.0.1/truevine_bootstrap_test_0123456789abcdef' };
  const actorUserId = randomUUID();
  const approval = { version: 1, action: 'provision', environment: 'test', releaseSha: environment.APP_VERSION, provisioningReleaseSha: environment.APP_VERSION,
    operationId: randomUUID(), bootstrapOperationId: randomUUID(), provisionOperationId: '',
    inventoryDigest: INVENTORY_DIGEST, credentialReference: 'CREDENTIALS-TEST', approvalReference: 'APPROVAL-TEST', operatorReference: 'OPERATOR-TEST', rehearsalReference: 'REHEARSAL-TEST',
    expiresAt: new Date(Date.now() + 3600000).toISOString(), actorUserId, email: 'qa-platform-owner@truevoice.com',
    applicationOrigin: environment.WEB_PUBLIC_URL, httpAuthorized: true,
    database: { hostname: '127.0.0.1', port: '5432', name: 'truevine_bootstrap_test_0123456789abcdef', systemIdentifier: '12345678901234567' },
    preservedAdmin: { userId: randomUUID(), organizationId: randomUUID() },
    isolationOrganizationId: randomUUID(), isolationFixtureAuthorized: true };
  approval.provisionOperationId = approval.operationId;
  const users = new Map();
  const organizations = new Map();
  organizations.set('truevoice-testing-isolation', { id: approval.isolationOrganizationId, slug: 'truevoice-testing-isolation', suspendedAt: null });
  const events = new Map();
  const owner = { id: actorUserId, email: approval.email, status: 'ACTIVE', passwordHash: await hashPassword(credentials.passwords[approval.email]), memberships: [], platformRole: { role: 'PLATFORM_OWNER', revokedAt: null } };
  users.set(owner.email, owner);
  users.set('admin@truevoice.com', { id: approval.preservedAdmin.userId, email: 'admin@truevoice.com', status: 'ACTIVE',
    memberships: [{ organizationId: approval.preservedAdmin.organizationId, role: 'OWNER' }], platformRole: null });
  const auditEventId = randomUUID();
  events.set(auditEventId, { id: auditEventId, actorUserId, outcome: 'SUCCESS', action: 'platform.owner.bootstrapped', metadata: { operationId: approval.bootstrapOperationId, subjectUserId: actorUserId, environment: 'test' } });
  const claim = { userId: owner.id, operationId: approval.bootstrapOperationId, auditEventId };
  const tx = {
    $queryRaw: vi.fn(async strings => [{ name: strings[0].includes('pg_control_system') ? approval.database.systemIdentifier : approval.database.name }]),
    user: { findUnique: vi.fn(async ({ where }) => structuredClone(users.get(where.email) ?? [...users.values()].find(user => user.id === where.id) ?? null)),
      create: vi.fn(async ({ data }) => { if (users.has(data.email)) throw new Error('Conflict'); users.set(data.email, { ...data, status: 'ACTIVE', memberships: [], platformRole: null }); }),
      update: vi.fn(async ({ where, data }) => Object.assign([...users.values()].find(user => user.id === where.id), data)) },
    organization: { findUnique: vi.fn(async ({ where }) => organizations.get(where.slug) ?? [...organizations.values()].find(org => org.id === where.id) ?? null),
      create: vi.fn(async ({ data }) => { const row = { id: randomUUID(), suspendedAt: null, ...data }; organizations.set(row.slug, row); return row; }) },
    membership: { create: vi.fn(async ({ data }) => [...users.values()].find(user => user.id === data.userId).memberships.push(data)) },
    platformRoleAssignment: { create: vi.fn(async ({ data }) => { [...users.values()].find(user => user.id === data.userId).platformRole = { ...data, revokedAt: null }; }) },
    platformOwnerBootstrap: { findUnique: vi.fn(async () => structuredClone(claim)) },
    identityAuditEvent: { findUnique: vi.fn(async ({ where }) => events.get(where.id) ?? null),
      create: vi.fn(async ({ data }) => { if (events.has(data.id)) throw new Error('Duplicate audit'); events.set(data.id, data); }) },
    session: { updateMany: vi.fn() }, passwordResetToken: { updateMany: vi.fn(), findUnique: vi.fn() },
    supportAccessSession: { findMany: vi.fn().mockResolvedValue([]), update: vi.fn() },
  };
  const db = { $disconnect: vi.fn(), $transaction: vi.fn(async work => {
    const snapshots = [users, organizations, events].map(map => structuredClone(map));
    try { return await work(tx); } catch (error) {
      [users, organizations, events].forEach((map, index) => { map.clear(); for (const [key, value] of snapshots[index]) map.set(key, value); });
      throw error;
    }
  }) };
  return { approval, credentials, environment, users, organizations, events, tx, db, claim, dependencies: { environment, createClient: () => db } };
}

describe('production test rollout executor', () => {
  it.each(['disabled', 'expired', 'fingerprint', 'inventory', 'release', 'password', 'origin', 'redirect-option'])('rejects unsafe approval before connection: %s', async reason => {
    const f = await rolloutFixture();
    if (reason === 'disabled') f.environment.TEST_ACCOUNT_ROLLOUT_ENABLED = '0';
    if (reason === 'expired') f.approval.expiresAt = new Date(0).toISOString();
    if (reason === 'fingerprint') f.approval.database.systemIdentifier = '';
    if (reason === 'inventory') f.approval.inventoryDigest = '';
    if (reason === 'release') f.approval.releaseSha = 'b'.repeat(40);
    if (reason === 'password') f.credentials.passwords[f.approval.email] = 'short';
    if (reason === 'origin') f.approval.applicationOrigin = 'https://voice.truevinecloud.online';
    if (reason === 'redirect-option') f.environment.DATABASE_URL += '?host=production';
    const createClient = vi.fn();
    await expect(executeRollout(f.approval, f.credentials, {}, { environment: f.environment, createClient })).rejects.toThrow();
    expect(createClient).not.toHaveBeenCalled();
  });
  it('requires independent explicit production authorization and confirmation', async () => {
    const { approval, credentials, environment } = await rolloutFixture();
    approval.environment = 'production'; environment.NODE_ENV = 'production';
    approval.applicationOrigin = environment.WEB_PUBLIC_URL = 'https://voice.truevinecloud.online';
    expect(() => validateRollout(approval, credentials, environment, true)).toThrow();
    Object.assign(approval, { productionAuthorized: true });
    expect(() => validateRollout(approval, credentials, environment, false)).toThrow();
    expect(validateRollout(approval, credentials, environment, true).origin).toBe('https://voice.truevinecloud.online');
  });
  it('creates ten exact identities with durable operation provenance and never replaces credentials on rerun', async () => {
    const f = await rolloutFixture();
    const result = await executeRollout(f.approval, f.credentials, {}, f.dependencies);
    expect(result.accountCount).toBe(11);
    expect(f.users.size).toBe(12);
    expect(f.events.get(f.approval.provisionOperationId).action).toBe('test_rollout.provisioned');
    for (const account of ROLLOUT_ACCOUNTS) {
      const user = f.users.get(account.email);
      expect(await verifyPassword(user.passwordHash, f.credentials.passwords[account.email])).toBe(true);
      if (account.scope === 'organization') expect(user.memberships[0].role).toBe(account.role);
      else { expect(user.memberships).toHaveLength(0); expect(user.platformRole.role).toBe(account.role); }
    }
    await executeRollout(f.approval, f.credentials, {}, f.dependencies);
    expect(f.tx.user.create).toHaveBeenCalledTimes(10);
    expect(f.tx.user.update).not.toHaveBeenCalled();
  });
  it.each(['admin', 'claim', 'cluster', 'existing-email', 'existing-organization', 'missing-isolation'])('rejects conflicting production state before mutation: %s', async reason => {
    const f = await rolloutFixture();
    if (reason === 'admin') f.users.get('admin@truevoice.com').memberships[0].role = 'ADMIN';
    if (reason === 'claim') f.claim.operationId = randomUUID();
    if (reason === 'cluster') f.tx.$queryRaw.mockResolvedValue([{ name: 'wrong' }]);
    if (reason === 'existing-email') f.users.set('qa-viewer@truevoice.com', { id: randomUUID() });
    if (reason === 'existing-organization') f.organizations.set('truevoice-testing', { id: randomUUID() });
    if (reason === 'missing-isolation') f.organizations.clear();
    await expect(executeRollout(f.approval, f.credentials, {}, f.dependencies)).rejects.toThrow();
    expect(f.tx.user.create).not.toHaveBeenCalled();
    expect(f.db.$disconnect).toHaveBeenCalledOnce();
  });
  it('rolls back all fixture writes if the final durable audit cannot commit', async () => {
    const f = await rolloutFixture();
    const original = f.tx.identityAuditEvent.create.getMockImplementation();
    f.tx.identityAuditEvent.create.mockImplementation(async input => {
      if (input.data.id === f.approval.provisionOperationId) throw new Error('Audit unavailable');
      return original(input);
    });
    await expect(executeRollout(f.approval, f.credentials, {}, f.dependencies)).rejects.toThrow();
    expect(f.users.size).toBe(2); expect(f.organizations.size).toBe(1);
  });
  it('refuses credential, tenant or role drift on rerun instead of repairing it', async () => {
    const f = await rolloutFixture();
    await executeRollout(f.approval, f.credentials, {}, f.dependencies);
    f.users.get('qa-viewer@truevoice.com').memberships.push({ organizationId: randomUUID(), role: 'OWNER' });
    await expect(executeRollout(f.approval, f.credentials, {}, f.dependencies)).rejects.toThrow();
    expect(f.tx.user.update).not.toHaveBeenCalled();
  });
  it('disables only provenance-bound users and revokes scoped support sessions, preserving owners and claim', async () => {
    const f = await rolloutFixture();
    await executeRollout(f.approval, f.credentials, {}, f.dependencies);
    f.approval.action = 'disable'; f.approval.operationId = randomUUID();
    f.tx.supportAccessSession.findMany.mockResolvedValue([{ organizationId: randomUUID(), id: randomUUID() }]);
    await executeRollout(f.approval, f.credentials, {}, f.dependencies);
    await executeRollout(f.approval, f.credentials, {}, f.dependencies);
    expect(f.tx.user.update).toHaveBeenCalledTimes(10);
    expect(f.tx.supportAccessSession.update).toHaveBeenCalledTimes(40);
    expect(f.users.get('admin@truevoice.com').status).toBe('ACTIVE');
    expect(f.users.get(f.approval.email).status).toBe('ACTIVE');
    expect(f.events.get(f.approval.operationId).action).toBe('test_rollout.disabled');
    f.approval.action = 'verify';
    await expect(executeRollout(f.approval, f.credentials, {}, f.dependencies)).rejects.toThrow();
  });
  it('binds owner initialization to the approved claim, token hash and matching initialized password', async () => {
    const f = await rolloutFixture();
    f.approval.action = 'initialize';
    const raw = randomBytes(32).toString('base64url');
    const artifact = { operationId: f.approval.bootstrapOperationId, email: f.approval.email, activationUrl: `${f.approval.applicationOrigin}/set-password?token=${raw}` };
    f.tx.passwordResetToken.findUnique.mockImplementation(async ({ where }) => {
      if (where.tokenHash !== hashToken(raw)) return null;
      return { userId: f.approval.actorUserId, usedAt: null, expiresAt: new Date(Date.now() + 60000) };
    });
    expect((await executeRollout(f.approval, f.credentials, { artifact }, f.dependencies)).initialized).toBe(false);
    f.tx.passwordResetToken.findUnique.mockResolvedValue({ userId: f.approval.actorUserId, usedAt: new Date(), expiresAt: new Date(0) });
    expect((await executeRollout(f.approval, f.credentials, { artifact }, f.dependencies)).initialized).toBe(true);
    const foreign = { ...artifact, email: 'admin@truevoice.com' };
    await expect(executeRollout(f.approval, f.credentials, { artifact: foreign }, f.dependencies)).rejects.toThrow();
    f.tx.passwordResetToken.findUnique.mockResolvedValue({ userId: randomUUID(), usedAt: null, expiresAt: new Date(Date.now() + 60000) });
    await expect(executeRollout(f.approval, f.credentials, { artifact }, f.dependencies)).rejects.toThrow();
  });
});
