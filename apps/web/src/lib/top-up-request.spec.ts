import { describe, expect, it, vi } from 'vitest';
import { submitTopUpRequest } from './top-up-request';
function storage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
    removeItem: (key: string) => {
      values.delete(key);
    },
  };
}
const result = {
  id: 'request',
  status: 'PENDING' as const,
  currency: 'UGX' as const,
  amountMinor: '1000',
  createdAt: '2026-10-19',
};
describe('top-up retry identity', () => {
  it('reuses the persisted key after an ambiguous network result and reload', async () => {
    const saved = storage();
    const send = vi.fn().mockRejectedValueOnce(new Error('timeout')).mockResolvedValue(result);
    await expect(submitTopUpRequest('org', '1000', saved, send)).rejects.toThrow('timeout');
    await expect(submitTopUpRequest('org', '1000', saved, send)).resolves.toEqual(result);
    expect(send.mock.calls[0]).toEqual(send.mock.calls[1]);
    expect(saved.getItem('tv:top-up:org')).toBeNull();
  });
  it('refuses changed payload after an ambiguous result and isolates tenants', async () => {
    const saved = storage();
    const send = vi.fn().mockRejectedValueOnce(new Error('timeout')).mockResolvedValue(result);
    await expect(submitTopUpRequest('a', '1000', saved, send)).rejects.toThrow('timeout');
    await expect(submitTopUpRequest('a', '2000', saved, send)).rejects.toThrow(
      'Retry the previous amount',
    );
    await submitTopUpRequest('b', '1000', saved, send);
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[0]?.[1].idempotencyKey).not.toBe(send.mock.calls[1]?.[1].idempotencyKey);
  });
  it.each(['1.5', '-1', '0', '9223372036854775808'])(
    'does not send invalid amount %s',
    async (amount) => {
      const send = vi.fn();
      await expect(submitTopUpRequest('a', amount, storage(), send)).rejects.toThrow(
        'positive whole UGX',
      );
      expect(send).not.toHaveBeenCalled();
    },
  );
});
