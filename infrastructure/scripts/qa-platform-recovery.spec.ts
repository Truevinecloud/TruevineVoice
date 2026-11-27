import { describe, expect, it, vi } from 'vitest';
import { hashToken, isSafeAuditMetadata, PASSWORD_RESET_TTL_MS } from '@truevine/auth';
import { checkPassword } from '@truevine/auth/passwords';

const modulePath = './qa-platform-recovery.mjs';
const { ACCOUNTS, DATABASE, parseArguments, validateTarget, issueRecovery, completeRecovery, guardedDatabase, main } = await import(modulePath);
const operationId = 'c4f1bdce-80b6-468b-994e-77491fbb923e';
const options = { operationId, approved: true, operator: 'test-operator' };
const environment = {
  NODE_ENV: 'test', DATABASE_URL: `postgresql://test:test@127.0.0.1:55432/${DATABASE}`,
  EXPECTED_DATABASE_NAME: DATABASE, REDIS_URL: 'redis://127.0.0.1:56379',
};

function fixture() {
  const users = ACCOUNTS.map((account: { id: string; email: string; role: string }) => ({
    id: account.id, email: account.email, status: 'ACTIVE', platformRole: { role: account.role, revokedAt: null as Date | null },
  }));
  const tx = {
    $queryRaw: vi.fn().mockResolvedValue([{ name: DATABASE, port: 5432 }]),
    user: { findUnique: vi.fn(async ({ where }: { where: { id: string } }) => users.find((user: { id: string }) => user.id === where.id)) },
    passwordResetToken: { updateMany: vi.fn(), create: vi.fn(), findUnique: vi.fn() },
    identityAuditEvent: { create: vi.fn(), findFirst: vi.fn().mockResolvedValue(null) },
  };
  let committed = false;
  const database = { $transaction: vi.fn(async (work: (value: typeof tx) => Promise<unknown>) => {
    const result = await work(tx); committed = true; return result;
  }), $disconnect: vi.fn() };
  const store = vi.fn().mockResolvedValue('C:\\private\\encrypted.dpapi');
  return { users, tx, database, store, committed: () => committed };
}

describe('local QA platform recovery approval and target guards', () => {
  it('requires an exact action, explicit approval and a v4 UUID; accepts no email override', () => {
    expect(parseArguments(['issue', '--approve-local-qa-recovery', '--operation-id', operationId])).toEqual({ action: 'issue', operationId });
    expect(parseArguments(['complete', '--approve-local-qa-recovery', '--operation-id', operationId]).action).toBe('complete');
    for (const args of [[], ['issue'], ['issue', '--approve-local-qa-recovery=false', '--operation-id', operationId],
      ['issue', '--approve-local-qa-recovery', '--operation-id', '../outside'],
      ['issue', '--approve-local-qa-recovery', '--operation-id', operationId, '--email', 'other@example.invalid']]) {
      expect(() => parseArguments(args)).toThrow();
    }
  });
  it('accepts only the named loopback QA target on Windows with local Redis', () => {
    expect(() => validateTarget(environment, 'win32')).not.toThrow();
    expect(() => validateTarget(environment, 'linux')).toThrow();
  });
  it.each([
    { NODE_ENV: 'production' }, { NODE_ENV: undefined }, { EXPECTED_DATABASE_NAME: 'truevine_voice' },
    { DATABASE_URL: 'postgresql://test:test@localhost:55432/truevine_voice' },
    { DATABASE_URL: `postgresql://test:test@remote.invalid:55432/${DATABASE}` },
    { DATABASE_URL: `postgresql://test:test@localhost:5432/${DATABASE}` },
    { DATABASE_URL: `${environment.DATABASE_URL}?host=remote.invalid` },
    { DATABASE_URL: `${environment.DATABASE_URL}#fragment` },
    { DATABASE_URL: `https://localhost:55432/${DATABASE}` }, { DATABASE_URL: 'invalid' },
    { REDIS_URL: 'redis://remote.invalid:56379' },
  ])('rejects unsafe environment %j', (change) => {
    expect(() => validateTarget({ ...environment, ...change }, 'win32')).toThrow();
  });
});

describe('issuance uses the existing reset-token and audit contract', () => {
  it('issues exactly two tokens and distinct policy-valid passwords, encrypted before commit', async () => {
    const f = fixture(); const started = Date.now();
    f.store.mockImplementation(async () => { expect(f.committed()).toBe(false); return 'encrypted-location'; });
    const result = await issueRecovery(f.database, options, f.store);
    expect(f.tx.passwordResetToken.create).toHaveBeenCalledTimes(2);
    expect(f.tx.identityAuditEvent.create).toHaveBeenCalledTimes(2);
    const bundle = f.store.mock.calls[0][2];
    expect(bundle.entries.map((entry: { id: string }) => entry.id)).toEqual(ACCOUNTS.map((entry: { id: string }) => entry.id));
    expect(new Set(bundle.entries.map((entry: { password: string }) => entry.password)).size).toBe(2);
    for (const [index, entry] of bundle.entries.entries()) {
      expect(checkPassword(entry.password)).toBeUndefined();
      expect(entry.password.length).toBeGreaterThanOrEqual(40);
      const data = f.tx.passwordResetToken.create.mock.calls[index][0].data;
      expect(data.tokenHash).toBe(hashToken(entry.token));
      expect(data.userId).toBe(entry.id);
      expect(data.expiresAt.getTime()).toBeGreaterThanOrEqual(started + PASSWORD_RESET_TTL_MS);
      expect(f.tx.passwordResetToken.updateMany.mock.calls[index][0]).toEqual({
        where: { userId: entry.id, usedAt: null }, data: { expiresAt: new Date(0) },
      });
      const audit = f.tx.identityAuditEvent.create.mock.calls[index][0].data;
      expect(audit).toMatchObject({ actorUserId: entry.id, action: 'auth.password_reset_requested', outcome: 'SUCCESS',
        metadata: { operationId, targetUserId: entry.id, actorKind: 'local_operator', operatorReference: 'test-operator' } });
      expect(isSafeAuditMetadata(audit.metadata)).toBe(true);
      expect(JSON.stringify(audit)).not.toContain(entry.token);
      expect(JSON.stringify(audit)).not.toContain(entry.password);
      expect(JSON.stringify(result)).not.toContain(entry.token);
      expect(JSON.stringify(result)).not.toContain(entry.password);
    }
    expect(f.committed()).toBe(true);
    expect(f.tx.user.findUnique).toHaveBeenCalledTimes(2);
  });
  it.each(['id', 'email', 'role', 'revoked', 'suspended', 'missing'])('refuses %s mismatch before any mutation', async (condition) => {
    const f = fixture();
    if (condition === 'id') f.users[0].id = 'different-id';
    if (condition === 'email') f.users[0].email = 'unauthorized@example.invalid';
    if (condition === 'role') f.users[0].platformRole.role = 'SUPPORT_ADMIN';
    if (condition === 'revoked') f.users[0].platformRole.revokedAt = new Date();
    if (condition === 'suspended') f.users[0].status = 'SUSPENDED';
    if (condition === 'missing') f.users.pop();
    await expect(issueRecovery(f.database, options, f.store)).rejects.toThrow();
    expect(f.tx.passwordResetToken.updateMany).not.toHaveBeenCalled();
    expect(f.tx.identityAuditEvent.create).not.toHaveBeenCalled();
    expect(f.store).not.toHaveBeenCalled();
  });
  it('rejects connected target mismatch, reused operations and absent approval', async () => {
    const f = fixture();
    f.tx.$queryRaw.mockResolvedValueOnce([{ name: 'truevine_voice', port: 5432 }]);
    await expect(issueRecovery(f.database, options, f.store)).rejects.toThrow();
    f.tx.identityAuditEvent.findFirst.mockResolvedValue({ id: 'prior' });
    await expect(issueRecovery(f.database, options, f.store)).rejects.toThrow();
    await expect(issueRecovery(f.database, { ...options, approved: false }, f.store)).rejects.toThrow();
    expect(f.tx.passwordResetToken.create).not.toHaveBeenCalled();
  });
  it('fails the transaction when auditing or secure storage fails', async () => {
    for (const failure of ['audit', 'vault']) {
      const f = fixture();
      if (failure === 'audit') f.tx.identityAuditEvent.create.mockRejectedValue(new Error('audit failure'));
      else f.store.mockRejectedValue(new Error('vault failure'));
      await expect(issueRecovery(f.database, options, f.store)).rejects.toThrow();
      expect(f.committed()).toBe(false);
      if (failure === 'audit') expect(f.store).not.toHaveBeenCalled();
    }
  });
});

async function completionFixture() {
  const f = fixture();
  await issueRecovery(f.database, options, f.store);
  const bundle = f.store.mock.calls[0][2];
  f.store.mockResolvedValue(bundle);
  f.tx.identityAuditEvent.findFirst.mockResolvedValue({ metadata: { source: 'operator_local_qa_platform_recovery' } });
  f.tx.passwordResetToken.findUnique.mockImplementation(async ({ where }: { where: { tokenHash: string } }) => {
    const entry = bundle.entries.find((entry: { token: string }) => hashToken(entry.token) === where.tokenHash);
    return entry ? { userId: entry.id, usedAt: null, expiresAt: new Date(bundle.expiresAt) } : null;
  });
  const service = { completePasswordReset: vi.fn() };
  return { ...f, bundle, service };
}

describe('completion delegates policy, consumption, revocation and success audit to AuthService', () => {
  it('delegates the two validated capabilities without editing hashes', async () => {
    const f = await completionFixture();
    await completeRecovery(f.database, options, f.service, f.store);
    expect(f.service.completePasswordReset.mock.calls).toEqual(f.bundle.entries.map((entry: { token: string; password: string }) => [entry.token, entry.password]));
  });
  it.each(['database', 'operation', 'account', 'password', 'expired', 'token', 'audit', 'used', 'role'])('refuses invalid %s before completing either account', async (condition) => {
    const f = await completionFixture();
    if (condition === 'database') f.bundle.database = 'truevine_voice';
    if (condition === 'operation') f.bundle.operationId = 'different';
    if (condition === 'account') f.bundle.entries[1].id = 'different';
    if (condition === 'password') f.bundle.entries[1].password = 'weak';
    if (condition === 'expired') f.bundle.expiresAt = new Date(0).toISOString();
    if (condition === 'token') f.bundle.entries[1].token = '';
    if (condition === 'audit') f.tx.identityAuditEvent.findFirst.mockResolvedValue(null);
    if (condition === 'used') f.tx.passwordResetToken.findUnique.mockResolvedValue({ userId: ACCOUNTS[0].id, usedAt: new Date(), expiresAt: new Date(Date.now() + 60000) });
    if (condition === 'role') f.users[1].platformRole.role = 'TECHNICAL_ADMIN';
    await expect(completeRecovery(f.database, options, f.service, f.store)).rejects.toThrow();
    expect(f.service.completePasswordReset).not.toHaveBeenCalled();
  });
  it('rechecks roles under the application mutation transaction', async () => {
    const f = fixture(); const work = vi.fn();
    f.users[1].status = 'SUSPENDED';
    await expect(guardedDatabase(f.database).$transaction(work)).rejects.toThrow();
    expect(work).not.toHaveBeenCalled();
  });
  it('redacts CLI errors and performs no work without explicit arguments', async () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    const stdout = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    const prior = process.exitCode;
    try {
      await main([]);
      expect(process.exitCode).toBe(1);
      expect(stderr).toHaveBeenCalledWith(expect.stringContaining('Diagnostics withheld'));
      expect(stdout).not.toHaveBeenCalled();
    } finally { process.exitCode = prior; stderr.mockRestore(); stdout.mockRestore(); }
  });
});
