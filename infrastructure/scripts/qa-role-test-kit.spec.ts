import { describe, expect, it, vi } from 'vitest';
import { hashToken } from '@truevine/auth';
const modulePath = './qa-role-test-kit.mjs';
const { validateTarget, provisionRoleKit, INVENTORY } = await import(modulePath);
const environment = { NODE_ENV: 'test', QA_ROLE_KIT_ENABLED: '1', DATABASE_URL: 'postgresql://127.0.0.1/truevine_bootstrap_test_0123456789abcdef', WEB_PUBLIC_URL: 'https://localhost:3000' };

describe('isolated QA kit', () => {
  function fixture() {
    const users = new Map();
    const owner = { id: 'platform-owner', email: 'qa-platform-owner@example.invalid', status: 'ACTIVE', memberships: [], platformRole: { role: 'PLATFORM_OWNER', revokedAt: null } };
    users.set(owner.email, owner);
    const tx = {
      $queryRaw: vi.fn().mockResolvedValue([{ name: validateTarget(environment).name }]),
      platformOwnerBootstrap: { findUnique: vi.fn().mockResolvedValue({ userId: owner.id }) },
      organization: { upsert: vi.fn().mockResolvedValue({ id: 'org', suspendedAt: null }) },
      user: { findUnique: vi.fn(async ({ where }) => users.get(where.email) ?? null),
        create: vi.fn(async ({ data }) => { users.set(data.email, { ...data, status: 'ACTIVE', memberships: [], platformRole: null }); }) },
      membership: { create: vi.fn(async ({ data }) => { [...users.values()].find(user => user.id === data.userId).memberships.push(data); }) },
      platformRoleAssignment: { create: vi.fn(async ({ data }) => { [...users.values()].find(user => user.id === data.userId).platformRole = { ...data, revokedAt: null }; }) },
      passwordResetToken: { create: vi.fn() }, identityAuditEvent: { create: vi.fn() },
    };
    const db = { $transaction: vi.fn(work => work(tx)), $disconnect: vi.fn() };
    const prepareArtifact = vi.fn(() => ({ path: '/private/artifact' }));
    return { tx, users, dependencies: { environment, createClient: () => db, prepareArtifact, hashPassword: vi.fn().mockResolvedValue('test-hash') }, prepareArtifact };
  }
  it('creates ten separate activation hashes and reruns without changing credentials or tokens', async () => {
    const { tx, dependencies, prepareArtifact } = fixture();
    const result = await provisionRoleKit({ directory: '/private' }, dependencies);
    expect(result.filter(item => item.status === 'created')).toHaveLength(10);
    expect(tx.user.create).toHaveBeenCalledTimes(10);
    expect(tx.membership.create).toHaveBeenCalledTimes(5);
    expect(tx.platformRoleAssignment.create).toHaveBeenCalledTimes(5);
    expect(new Set(tx.passwordResetToken.create.mock.calls.map(call => call[0].data.tokenHash)).size).toBe(10);
    expect(tx.identityAuditEvent.create).toHaveBeenCalledTimes(10);
    for (let index = 0; index < 10; index += 1) {
      const payload = prepareArtifact.mock.calls[index][2];
      const token = new URL(payload.activationUrl).searchParams.get('token');
      expect(tx.passwordResetToken.create.mock.calls[index][0].data.tokenHash === hashToken(token)).toBe(true);
    }
    const rerun = await provisionRoleKit({ directory: '/private' }, dependencies);
    expect(rerun.every(item => item.status === 'unchanged')).toBe(true);
    expect(tx.user.create).toHaveBeenCalledTimes(10);
    expect(tx.passwordResetToken.create).toHaveBeenCalledTimes(10);
    expect(prepareArtifact).toHaveBeenCalledTimes(10);
  });
  it('never reads or modifies the preserved QA Owner identity', async () => {
    const { tx, dependencies, users } = fixture();
    const preserved = { id: 'preserved-owner', email: 'admin@truevoice.com', passwordHash: 'unchanged-test-hash', memberships: [{ organizationId: 'existing-org', role: 'OWNER' }] };
    users.set(preserved.email, structuredClone(preserved));
    await provisionRoleKit({ directory: '/private' }, dependencies);
    expect(users.get(preserved.email)).toEqual(preserved);
    expect(tx.user.findUnique.mock.calls.some(call => call[0].where.email === preserved.email)).toBe(false);
    expect(tx.passwordResetToken.create.mock.calls.some(call => call[0].data.userId === preserved.id)).toBe(false);
  });
  it.each(['revoked-owner', 'extra-membership', 'platform-on-customer', 'inactive-user'])('refuses conflicting state: %s', async conflict => {
    const { dependencies, users, tx } = fixture();
    await provisionRoleKit({ directory: '/private' }, dependencies);
    const viewer = users.get('qa-viewer@example.invalid');
    if (conflict === 'revoked-owner') users.get('qa-platform-owner@example.invalid').platformRole.revokedAt = new Date();
    if (conflict === 'extra-membership') viewer.memberships.push({ organizationId: 'another-org', role: 'VIEWER' });
    if (conflict === 'platform-on-customer') viewer.platformRole = { role: 'AUDITOR', revokedAt: null };
    if (conflict === 'inactive-user') viewer.status = 'INACTIVE';
    await expect(provisionRoleKit({ directory: '/private' }, dependencies)).rejects.toThrow();
    expect(tx.user.create).toHaveBeenCalledTimes(10);
    expect(tx.passwordResetToken.create).toHaveBeenCalledTimes(10);
  });
  it('refuses a changed assignment instead of repairing it', async () => {
    const { dependencies, users } = fixture();
    await provisionRoleKit({ directory: '/private' }, dependencies);
    users.get('qa-viewer@example.invalid').memberships[0].role = 'OWNER';
    await expect(provisionRoleKit({ directory: '/private' }, dependencies)).rejects.toThrow('refusing changes');
  });
  it('lists eleven unique identities, excluding the existing production owner', () => {
    expect(INVENTORY).toHaveLength(11);
    expect(new Set(INVENTORY.map(item => item.email)).size).toBe(11);
    expect(INVENTORY.map(item => item.email)).not.toContain('admin@truevoice.com');
  });
  it.each([
    { NODE_ENV: 'production' }, { QA_ROLE_KIT_ENABLED: '0' },
    { DATABASE_URL: 'postgresql://production/truevine_bootstrap_test_0123456789abcdef' },
    { DATABASE_URL: 'postgresql://localhost/truevine_voice' },
    { DATABASE_URL: `${environment.DATABASE_URL}?host=production` },
    { WEB_PUBLIC_URL: 'https://voice.truevinecloud.online' },
  ])('rejects unsafe configuration before connecting: %j', async override => {
    const createClient = vi.fn();
    await expect(provisionRoleKit({ directory: '/private' }, { environment: { ...environment, ...override }, createClient })).rejects.toThrow();
    expect(createClient).not.toHaveBeenCalled();
  });
  it('accepts only the dedicated isolated target', () => {
    expect(validateTarget(environment).name).toBe('truevine_bootstrap_test_0123456789abcdef');
  });
  it('fails closed on a mismatched connected database and disconnects', async () => {
    const tx = { $queryRaw: vi.fn().mockResolvedValue([{ name: 'production' }]) };
    const db = { $transaction: vi.fn(work => work(tx)), $disconnect: vi.fn() };
    await expect(provisionRoleKit({}, { environment, createClient: () => db })).rejects.toThrow('Connected database mismatch');
    expect(db.$disconnect).toHaveBeenCalledOnce();
  });
  it('requires the immutable bootstrap claim before creating any account', async () => {
    const tx = { $queryRaw: vi.fn().mockResolvedValue([{ name: validateTarget(environment).name }]),
      platformOwnerBootstrap: { findUnique: vi.fn().mockResolvedValue(null) },
      user: { findUnique: vi.fn().mockResolvedValue(null), create: vi.fn() } };
    const db = { $transaction: vi.fn(work => work(tx)), $disconnect: vi.fn() };
    await expect(provisionRoleKit({}, { environment, createClient: () => db })).rejects.toThrow('Bootstrap');
    expect(tx.user.create).not.toHaveBeenCalled();
  });
});
