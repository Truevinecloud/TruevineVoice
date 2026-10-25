import { describe, expect, it, vi } from 'vitest';

import { PrismaCampaignStore } from './prisma-campaign.store.js';

function database(campaign: object) {
  const tx = {
    campaign,
    securityAuditEvent: { create: vi.fn().mockResolvedValue({}) },
    $queryRaw: vi.fn().mockResolvedValue([{ role: 'OWNER' }]),
  };
  return {
    ...tx,
    $transaction: async (work: (client: typeof tx) => Promise<unknown>) => work(tx),
  } as never;
}

describe('PrismaCampaignStore draft-only preparation lock', () => {
  it('refuses lifecycle mutation of a completed or emergency-stopped campaign', async () => {
    const updateMany = vi.fn(async () => ({ count: 0 }));
    const findUnique = vi.fn().mockResolvedValue({
      name: 'Synthetic',
      status: 'COMPLETED',
      emergencyStoppedAt: new Date(),
    });
    const store = new PrismaCampaignStore(database({ updateMany, findUnique }));

    await expect(
      store.updateCampaign('org-id', 'campaign-id', { name: 'Changed' }, 'actor-id'),
    ).rejects.toThrow('Only draft campaigns can be edited.');
    expect(updateMany).not.toHaveBeenCalled();
    expect(findUnique).toHaveBeenCalledWith({
      where: { organizationId_id: { organizationId: 'org-id', id: 'campaign-id' } },
      include: { audienceGroups: { select: { groupId: true } } },
    });
  });

  it('refuses customer deletion of an emergency-stopped campaign', async () => {
    const deleteMany = vi.fn(async () => ({ count: 0 }));
    const store = new PrismaCampaignStore(
      database({
        deleteMany,
        findUnique: vi.fn().mockResolvedValue({
          name: 'Synthetic',
          status: 'COMPLETED',
          emergencyStoppedAt: new Date(),
        }),
      }),
    );

    await expect(store.deleteCampaign('org-id', 'campaign-id', 'actor-id')).rejects.toThrow(
      'Only draft campaigns can be edited.',
    );

    expect(deleteMany).not.toHaveBeenCalled();
  });
});
