import { describe, expect, it, vi } from 'vitest';
import { PrismaSecurityTransaction, type SecurityDatabase } from './prisma-stores.js';

describe('PrismaSecurityTransaction isolation forwarding', () => {
  it('passes explicit ReadCommitted through to the outer Prisma transaction', async () => {
    const stop = new Error('No database is used by this fake');
    const transaction = vi.fn().mockRejectedValue(stop);
    const database = { $transaction: transaction } as unknown as SecurityDatabase;
    const adapter = new PrismaSecurityTransaction(database);

    await expect(
      adapter.run(async () => undefined, { isolationLevel: 'ReadCommitted' }),
    ).rejects.toBe(stop);
    expect(transaction).toHaveBeenCalledExactlyOnceWith(expect.any(Function), {
      isolationLevel: 'ReadCommitted',
    });
  });
});
