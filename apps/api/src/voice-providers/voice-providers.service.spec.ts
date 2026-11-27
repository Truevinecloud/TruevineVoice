import { canActAsPlatform, PLATFORM_ROLES } from '@truevine/auth';
import { describe, expect, it, vi } from 'vitest';

import { decryptKey, encryptKey, VoiceProvidersService } from './voice-providers.service.js';

const key = Buffer.alloc(32, 1);

function fixture() {
  const ciphertext = encryptKey(key, 'SANDBOX', 'example-api-key');
  const row = {
    environment: 'SANDBOX', username: 'sandbox', voiceNumber: '+256700000000',
    ciphertext, enabled: true, checkedAt: new Date(), checkResult: 'verified', version: 1,
  };
  const audit = vi.fn();
  const write = vi.fn(async () => 1);
  const query = vi.fn(async () => [row]);
  const request = vi.fn<typeof fetch>();
  const service = new VoiceProvidersService({
    $queryRaw: query,
    $transaction: async (work: (tx: unknown) => Promise<unknown>) =>
      work({ $executeRaw: write, identityAuditEvent: { create: audit } }),
  } as unknown as ConstructorParameters<typeof VoiceProvidersService>[0], key, request);
  return { service, request, write, audit, row };
}

describe('Voice provider configuration', () => {
  it('uses an existing Platform Owner-only permission', () => {
    expect(PLATFORM_ROLES.filter((role) => canActAsPlatform(role, 'platform:technical:write')))
      .toEqual(['PLATFORM_OWNER']);
  });

  it('uses authenticated encryption scoped to the environment', () => {
    const ciphertext = encryptKey(key, 'SANDBOX', 'example-api-key');
    expect(ciphertext).not.toContain('example-api-key');
    expect(decryptKey(key, 'SANDBOX', ciphertext)).toBe('example-api-key');
    expect(() => decryptKey(key, 'PRODUCTION', ciphertext)).toThrow();
  });

  it('returns separate environments without ciphertext or the key', async () => {
    const { service, row } = fixture();
    const list = await service.list();
    expect(list).toMatchObject([
      { environment: 'SANDBOX', keyPresent: true },
      { environment: 'PRODUCTION', keyPresent: false },
    ]);
    expect(JSON.stringify(list)).not.toContain(row.ciphertext);
  });

  it('invalidates verification and deactivates on replacement, with a sanitized audit', async () => {
    const { service, audit } = fixture();
    expect(await service.save('actor', 'SANDBOX', {
      username: 'sandbox', voiceNumber: '+256700000000', apiKey: 'replacement-secret',
    })).toMatchObject({ enabled: false, checkResult: null, keyPresent: true });
    expect(audit).toHaveBeenCalledOnce();
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ action: 'platform.voice_provider.configured' }),
    }));
    expect(JSON.stringify(audit.mock.calls)).not.toContain('replacement-secret');
  });

  it('allows sandbox credential-only configuration without a voice number', async () => {
    const { service, audit } = fixture();
    expect(await service.save('actor', 'SANDBOX', {
      username: 'sandbox', voiceNumber: '', apiKey: 'sandbox-secret',
    })).toMatchObject({ environment: 'SANDBOX', keyPresent: true, enabled: false });
    expect(audit).toHaveBeenCalledOnce();
  });

  it('still requires a provider-issued voice number in production', async () => {
    const { service } = fixture();
    await expect(service.save('actor', 'PRODUCTION', {
      username: 'prodapp', voiceNumber: '', apiKey: 'production-secret',
    })).rejects.toMatchObject({ status: 400 });
  });

  it('tests credentials through Application Data and leaves voice readiness false', async () => {
    const { service, request } = fixture();
    request.mockResolvedValue(Response.json({ UserData: { balance: 'UGX 0' } }));
    expect(await service.testConnection('actor', 'SANDBOX')).toMatchObject({
      checkResult: 'verified', voiceReady: false,
    });
    expect(String(request.mock.calls[0]?.[0]))
      .toBe('https://api.sandbox.africastalking.com/version1/user?username=sandbox');
    expect(request.mock.calls[0]?.[1]).toMatchObject({ method: 'GET', redirect: 'error' });
  });

  it('requires verification for activation and supports deactivation', async () => {
    const { service, row } = fixture();
    expect(await service.activate('actor', 'SANDBOX', { enabled: false })).toMatchObject({ enabled: false });
    expect(await service.activate('actor', 'SANDBOX', { enabled: true })).toMatchObject({ enabled: true });
    row.checkResult = 'rejected';
    await expect(service.activate('actor', 'SANDBOX', { enabled: true })).rejects.toMatchObject({ status: 409 });
  });

  it('rejects stale verification after a concurrent update without a success audit', async () => {
    const { service, request, write, audit } = fixture();
    request.mockResolvedValue(Response.json({ UserData: { balance: 'UGX 0' } }));
    write.mockResolvedValueOnce(0);
    await expect(service.testConnection('actor', 'SANDBOX')).rejects.toMatchObject({ status: 409 });
    expect(audit).not.toHaveBeenCalled();
  });

  it('does not return success when the mandatory audit insert fails', async () => {
    const { service, audit, write } = fixture();
    audit.mockRejectedValueOnce(new Error('audit unavailable'));
    await expect(service.activate('actor', 'SANDBOX', { enabled: false })).rejects.toThrow('audit unavailable');
    expect(write).toHaveBeenCalledOnce();
  });
});
