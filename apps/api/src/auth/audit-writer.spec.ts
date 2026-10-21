import { describe, expect, it, vi } from 'vitest';
import { PrismaAuditStore } from './prisma-stores.js';
describe('audit persistence boundary', () => {
  it('refuses nested secrets and unknown actions before sending SQL', async () => {
    const create = vi.fn();
    const store = new PrismaAuditStore({
      securityAuditEvent: { create },
      identityAuditEvent: { create },
    } as never);
    await expect(
      store.record({
        organizationId: 'org',
        actorUserId: 'actor',
        action: 'authorization.denied',
        scope: 'ORGANIZATION',
        outcome: 'DENIED',
        metadata: { before: { access_token: 'sensitive' } },
      }),
    ).rejects.toThrow('Unsafe audit');
    await expect(
      store.recordIdentity({ actorUserId: 'actor', action: 'made.up', outcome: 'SUCCESS' }),
    ).rejects.toThrow('Unknown audit action');
    expect(create).not.toHaveBeenCalled();
  });
});
