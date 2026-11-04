import { beforeEach, describe, expect, it, vi } from 'vitest';
import { hashToken, PASSWORD_RESET_TTL_MS } from '@truevine/auth';

const fs = vi.hoisted(() => ({
  openSync: vi.fn().mockReturnValue(42), closeSync: vi.fn(), fsyncSync: vi.fn(),
  writeFileSync: vi.fn(), unlinkSync: vi.fn(),
  fstatSync: vi.fn(() => ({ mode: 0o600, uid: process.getuid?.() })),
}));
vi.mock('node:fs', async (original) => ({ ...await original<object>(), ...fs }));
const modulePath = './recover-qa-viewer.mjs';
const { recoverQaViewer, parseRecoveryArguments, main } = await import(modulePath);

function fixture() {
  const tx = {
    $queryRaw: vi.fn(),
    organization: { findUnique: vi.fn().mockResolvedValue({ id: 'org', slug: 'truevoice-testing', suspendedAt: null }) },
    user: { findUnique: vi.fn().mockResolvedValue({ id: 'user', email: 'qa-viewer@truevoice.com', status: 'ACTIVE' }) },
    membership: { findUnique: vi.fn().mockResolvedValue({ role: 'VIEWER' }) },
    platformRoleAssignment: { findUnique: vi.fn().mockResolvedValue(null) },
    passwordResetToken: { updateMany: vi.fn(), create: vi.fn() },
    identityAuditEvent: { create: vi.fn(async (input: { data: { actorUserId: string | null } }) => {
      if (!input.data.actorUserId) throw new Error('Audit identity reference is required.');
    }) },
  };
  const database = { $transaction: vi.fn(async (work) => work(tx)), $disconnect: vi.fn() };
  return { tx, database };
}
const options = { directory: '/private', baseUrl: 'https://voice.example.invalid' };

describe('QA Viewer recovery', () => {
  beforeEach(() => vi.clearAllMocks());
  it('requires explicit production confirmation and an absolute directory', () => {
    expect(() => parseRecoveryArguments([])).toThrow();
    expect(() => parseRecoveryArguments(['--confirm-production=false', '--activation-directory', '/private'])).toThrow();
    expect(() => parseRecoveryArguments(['--confirm-production', '--activation-directory', 'relative'])).toThrow();
  });
  it('replaces tokens with a shared hash/expiry, audits, and writes the link privately', async () => {
    const { tx, database } = fixture();
    const before = Date.now();
    await recoverQaViewer(database, options, vi.fn());
    expect(tx.passwordResetToken.updateMany).toHaveBeenCalledWith({ where: { userId: 'user', usedAt: null }, data: { expiresAt: new Date(0) } });
    const data = tx.passwordResetToken.create.mock.calls[0]![0].data;
    const contents = String(fs.writeFileSync.mock.calls[0]![1]);
    const raw = /token=([^\n]+)/.exec(contents)![1]!;
    expect(data.tokenHash).toBe(hashToken(raw));
    expect(data.expiresAt.getTime()).toBeGreaterThanOrEqual(before + PASSWORD_RESET_TTL_MS);
    expect(fs.openSync.mock.calls[0]![2]).toBe(0o600);
    expect(JSON.stringify(tx.identityAuditEvent.create.mock.calls)).not.toContain(raw);
  });
  it.each(['missing-user', 'wrong-email', 'suspended', 'wrong-role', 'platform', 'missing-org', 'suspended-org'])('refuses %s before mutations', async (condition) => {
    const { tx, database } = fixture();
    if (condition === 'missing-user') tx.user.findUnique.mockResolvedValue(null);
    if (condition === 'wrong-email') tx.user.findUnique.mockResolvedValue({ id: 'user', email: 'other', status: 'ACTIVE' });
    if (condition === 'suspended') tx.user.findUnique.mockResolvedValue({ id: 'user', email: 'qa-viewer@truevoice.com', status: 'SUSPENDED' });
    if (condition === 'wrong-role') tx.membership.findUnique.mockResolvedValue({ role: 'ADMIN' });
    if (condition === 'platform') tx.platformRoleAssignment.findUnique.mockResolvedValue({ role: 'PLATFORM_OWNER' });
    if (condition === 'missing-org') tx.organization.findUnique.mockResolvedValue(null);
    if (condition === 'suspended-org') tx.organization.findUnique.mockResolvedValue({ id: 'org', slug: 'truevoice-testing', suspendedAt: new Date() });
    await expect(recoverQaViewer(database, options, vi.fn())).rejects.toThrow();
    expect(tx.passwordResetToken.updateMany).not.toHaveBeenCalled();
    expect(fs.openSync).not.toHaveBeenCalled();
  });
  it('CLI never echoes exception details or secrets', async () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    const stdout = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    const old = process.exitCode;
    await main(['secret-token-and-database-url']);
    expect(stderr.mock.calls.flat().join('')).not.toContain('secret-token-and-database-url');
    expect(stdout).not.toHaveBeenCalled();
    process.exitCode = old;
    stderr.mockRestore(); stdout.mockRestore();
  });
});