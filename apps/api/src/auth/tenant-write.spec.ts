import { describe, expect, it, vi } from 'vitest';
import { authorizeTenantWrite } from './tenant-write.js';

describe('tenant write authorization', () => {
  it.each([{ rows: [] }, { rows: [{ role: 'VIEWER' }] }, { rows: [{ role: 'BILLING' }] }])(
    'refuses missing or unauthorized membership before writing (%j)',
    async ({ rows }) => {
      const query = vi.fn().mockResolvedValueOnce([]).mockResolvedValueOnce(rows);
      await expect(
        authorizeTenantWrite({ $queryRaw: query }, 'org-a', 'user-a', 'campaign:update'),
      ).rejects.toMatchObject({ status: 403 });
      expect(query).toHaveBeenNthCalledWith(1, expect.any(Array), 'org-a');
      expect(query).toHaveBeenNthCalledWith(2, expect.any(Array), 'org-a', 'user-a');
    },
  );
  it('allows a permitted role only after the lock and propagates transaction errors', async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ role: 'OWNER' }]);
    await expect(
      authorizeTenantWrite({ $queryRaw: query }, 'a', 'user', 'billing:update'),
    ).resolves.toBeUndefined();
    const failure = new Error('transaction failure');
    const failed = vi.fn().mockRejectedValue(failure);
    await expect(
      authorizeTenantWrite({ $queryRaw: failed }, 'a', 'user', 'billing:update'),
    ).rejects.toBe(failure);
    expect(failed).toHaveBeenCalledTimes(1);
  });
});
