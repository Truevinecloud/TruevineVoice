import { randomBytes } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { hashPassword, verifyPassword } from '@truevine/auth/passwords';
import { NullEmailSender } from '@truevine/messaging';
import { AuthService } from '../../apps/api/src/auth/auth.service.js';
import { FakeAuthStore, FakeAuditStore, FakeOrganizationStore, FakeSecurityTransaction, aUser } from '../../apps/api/test/fakes/auth.fakes.js';
const modulePath = './test-account-seeder.mjs';
const { runTestAccountSeeder, validateSeederConfiguration } = await import(modulePath);
const inventoryPath = './qa-role-test-kit.mjs';
const { INVENTORY } = await import(inventoryPath);
const environment = { NODE_ENV: 'test', TEST_ACCOUNT_SEEDER_ENABLED: '1', DATABASE_URL: 'postgresql://127.0.0.1/truevine_bootstrap_test_0123456789abcdef', WEB_PUBLIC_URL: 'https://localhost:3000' };
function configuration() {
  return { version: 1, action: 'seed', passwords: Object.fromEntries(INVENTORY.map(item => [item.email, randomBytes(24).toString('base64url')])) };
}
async function fixture() {
  const config = configuration();
  const users = new Map();
  const events = [];
  let organization = null;
  const owner = { id: 'bootstrap-owner', email: 'qa-platform-owner@example.invalid', status: 'ACTIVE',
    passwordHash: await hashPassword(config.passwords['qa-platform-owner@example.invalid']), memberships: [], platformRole: { role: 'PLATFORM_OWNER', revokedAt: null } };
  users.set(owner.email, owner);
  const tx = {
    $queryRaw: vi.fn().mockResolvedValue([{ name: 'truevine_bootstrap_test_0123456789abcdef' }]),
    user: {
      findUnique: vi.fn(async ({ where }) => users.get(where.email) ?? null),
      create: vi.fn(async ({ data }) => users.set(data.email, { ...data, status: 'ACTIVE', memberships: [], platformRole: null })),
      update: vi.fn(async ({ where, data }) => Object.assign([...users.values()].find(user => user.id === where.id), data)),
    },
    organization: {
      findUnique: vi.fn(async () => organization),
      create: vi.fn(async ({ data }) => { organization = { id: 'test-org', suspendedAt: null, ...data }; return organization; }),
    },
    platformOwnerBootstrap: { findUnique: vi.fn().mockResolvedValue({ userId: owner.id }) },
    membership: { create: vi.fn(async ({ data }) => [...users.values()].find(user => user.id === data.userId).memberships.push(data)) },
    platformRoleAssignment: { create: vi.fn(async ({ data }) => { [...users.values()].find(user => user.id === data.userId).platformRole = { ...data, revokedAt: null }; }) },
    identityAuditEvent: {
      create: vi.fn(async ({ data }) => events.push(data)),
      findFirst: vi.fn(async ({ where }) => events.find(event => event.action === where.action && event.metadata[where.metadata.path[0]] === where.metadata.equals) ?? null),
    },
    session: { updateMany: vi.fn() }, passwordResetToken: { updateMany: vi.fn() },
  };
  const db = { $transaction: vi.fn(work => work(tx)), $disconnect: vi.fn() };
  return { config, users, owner, tx, db, dependencies: { environment, createClient: () => db } };
}

describe('developer-controlled test account seeder', () => {
  it.each([
    { TEST_ACCOUNT_SEEDER_ENABLED: '0' }, { NODE_ENV: 'production' },
    { WEB_PUBLIC_URL: 'https://voice.truevinecloud.online' },
    { DATABASE_URL: 'postgresql://production/truevine_voice' },
    { DATABASE_URL: `${environment.DATABASE_URL}?host=production` },
  ])('rejects unsafe target before connecting', async override => {
    const createClient = vi.fn();
    await expect(runTestAccountSeeder(configuration(), { environment: { ...environment, ...override }, createClient })).rejects.toThrow();
    expect(createClient).not.toHaveBeenCalled();
  });
  it('enforces password policy, exact inventory and distinct passwords', () => {
    const config = configuration();
    config.passwords[INVENTORY[0].email] = 'short';
    expect(() => validateSeederConfiguration(config, environment)).toThrow('policy');
    const duplicate = configuration();
    duplicate.passwords[INVENTORY[0].email] = duplicate.passwords[INVENTORY[1].email];
    expect(() => validateSeederConfiguration(duplicate, environment)).toThrow('different password');
    delete duplicate.passwords[INVENTORY[0].email];
    expect(() => validateSeederConfiguration(duplicate, environment)).toThrow('inventory');
  });
  it('creates exact role assignments with real Argon2id passwords and preserves all existing credentials on rerun', async () => {
    const { config, tx, users, owner, dependencies } = await fixture();
    const originalOwnerHash = owner.passwordHash;
    const report = await runTestAccountSeeder(config, dependencies);
    expect(report.accounts).toHaveLength(11);
    expect(tx.organization.create).toHaveBeenCalledWith({ data: { slug: 'truevoice-testing', name: 'truevoice-testing' } });
    expect(tx.user.create).toHaveBeenCalledTimes(10);
    for (const account of INVENTORY) {
      const user = users.get(account.email);
      expect(user.passwordHash.startsWith('$argon2id$')).toBe(true);
      expect(await verifyPassword(user.passwordHash, config.passwords[account.email])).toBe(true);
      expect(await verifyPassword(user.passwordHash, randomBytes(24).toString('base64url'))).toBe(false);
      if (account.scope === 'organization') {
        expect(user.memberships).toEqual([{ userId: user.id, organizationId: 'test-org', role: account.role }]);
        expect(user.platformRole).toBeNull();
      } else { expect(user.memberships).toEqual([]); expect(user.platformRole.role).toBe(account.role); }
    }
    await runTestAccountSeeder(config, dependencies);
    expect(tx.user.create).toHaveBeenCalledTimes(10);
    expect(tx.user.update).not.toHaveBeenCalled();
    expect(owner.passwordHash === originalOwnerHash).toBe(true);
    expect(tx.passwordResetToken.updateMany).not.toHaveBeenCalled();
  });
  it.each(['password', 'role', 'other-tenant', 'unmanaged-account', 'missing-claim'])('rejects existing conflict before mutation: %s', async conflict => {
    const { config, tx, users, dependencies } = await fixture();
    await runTestAccountSeeder(config, dependencies);
    const viewer = users.get('qa-viewer@example.invalid');
    if (conflict === 'password') config.passwords[viewer.email] = randomBytes(24).toString('base64url');
    if (conflict === 'role') viewer.memberships[0].role = 'ADMIN';
    if (conflict === 'other-tenant') viewer.memberships.push({ organizationId: 'another-tenant', role: 'VIEWER' });
    if (conflict === 'unmanaged-account') tx.identityAuditEvent.findFirst.mockResolvedValue(null);
    if (conflict === 'missing-claim') tx.platformOwnerBootstrap.findUnique.mockResolvedValue(null);
    await expect(runTestAccountSeeder(config, dependencies)).rejects.toThrow();
    expect(tx.user.create).toHaveBeenCalledTimes(10);
    expect(tx.user.update).not.toHaveBeenCalled();
  });
  it('reads but never modifies the existing QA Owner', async () => {
    const { config, users, tx, dependencies } = await fixture();
    const original = { id: 'preserved', email: 'admin@truevoice.com', status: 'ACTIVE', memberships: [{ role: 'OWNER', organizationId: 'original-org' }] };
    users.set(original.email, structuredClone(original));
    const result = await runTestAccountSeeder(config, dependencies);
    expect(result.existingQaOwner.status).toBe('ACTIVE');
    expect(users.get(original.email)).toEqual(original);
    expect(tx.user.update).not.toHaveBeenCalled();
  });
  it('disables only seeder-owned accounts, revokes sessions and expires tokens without changing passwords or bootstrap', async () => {
    const { config, users, owner, tx, dependencies } = await fixture();
    await runTestAccountSeeder(config, dependencies);
    const hashes = [...users.values()].map(user => user.passwordHash);
    config.action = 'disable';
    const result = await runTestAccountSeeder(config, dependencies);
    expect(result.accounts.filter(account => account.status === 'disabled')).toHaveLength(10);
    expect(owner.status).toBe('ACTIVE');
    expect(tx.session.updateMany).toHaveBeenCalledTimes(10);
    expect(tx.passwordResetToken.updateMany).toHaveBeenCalledTimes(10);
    expect([...users.values()].map(user => user.passwordHash).every((hash, index) => hash === hashes[index])).toBe(true);
    await runTestAccountSeeder(config, dependencies);
    expect(tx.user.update).toHaveBeenCalledTimes(10);
    config.action = 'seed';
    await expect(runTestAccountSeeder(config, dependencies)).rejects.toThrow();
  });
  it('verification writes nothing and missing targets fail loudly', async () => {
    const { config, tx, dependencies, db } = await fixture();
    config.action = 'verify';
    await expect(runTestAccountSeeder(config, dependencies)).rejects.toThrow('Missing');
    expect(tx.organization.create).not.toHaveBeenCalled();
    expect(tx.user.create).not.toHaveBeenCalled();
    expect(db.$disconnect).toHaveBeenCalledOnce();
  });
  it('authenticates all eleven seeded identities through AuthService and denies wrong passwords and disabled users', async () => {
    const { config, users, dependencies } = await fixture();
    await runTestAccountSeeder(config, dependencies);
    const auth = new FakeAuthStore();
    const audit = new FakeAuditStore();
    const organizations = new FakeOrganizationStore();
    const service = new AuthService(auth, audit, { consume: async () => ({ allowed: true, retryAfterMs: 0, remaining: 99 }) },
      new NullEmailSender(), 'https://localhost:3000', 3, 60000, 30000, new FakeSecurityTransaction(auth, organizations, audit));
    for (const account of INVENTORY) {
      const seeded = users.get(account.email);
      auth.users.push(aUser({ id: seeded.id, email: seeded.email, passwordHash: seeded.passwordHash }));
      const result = await service.signIn(account.email, config.passwords[account.email], { ipPrefix: '127.0.0.0/24', userAgentHash: null });
      expect(Boolean(result.sessionToken)).toBe(true);
      await expect(service.signIn(account.email, randomBytes(24).toString('base64url'), { ipPrefix: '127.0.0.0/24', userAgentHash: null })).rejects.toMatchObject({ code: 'invalid_credentials' });
    }
    config.action = 'disable';
    await runTestAccountSeeder(config, dependencies);
    for (const user of auth.users) user.status = users.get(user.email).status;
    for (const account of INVENTORY.filter(item => item.role !== 'PLATFORM_OWNER')) {
      await expect(service.signIn(account.email, config.passwords[account.email], { ipPrefix: '127.0.0.0/24', userAgentHash: null })).rejects.toMatchObject({ code: 'invalid_credentials' });
    }
  });
});
