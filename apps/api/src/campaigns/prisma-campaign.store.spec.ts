import { describe, expect, it, vi } from 'vitest';

import { PrismaCampaignStore } from './prisma-campaign.store.js';

function database(campaign: object) {
  const tx = { campaign, $queryRaw: vi.fn().mockResolvedValue([{ role: 'OWNER' }]) };
  return {
    ...tx,
    $transaction: async (work: (client: typeof tx) => Promise<unknown>) => work(tx),
  } as never;
}

describe('PrismaCampaignStore emergency-stop lock', () => {
  it('refuses customer reactivation when a campaign has an emergency-stop marker', async () => {
    const updateMany = vi.fn(async () => ({ count: 0 }));
    const findUnique = vi.fn();
    const store = new PrismaCampaignStore(database({ updateMany, findUnique }));

    const result = await store.updateCampaign(
      'org-id',
      'campaign-id',
      { status: 'ACTIVE' },
      'actor-id',
    );

    expect(result).toBeUndefined();
    expect(updateMany).toHaveBeenCalledWith({
      where: { organizationId: 'org-id', id: 'campaign-id', emergencyStoppedAt: null },
      data: { status: 'ACTIVE' },
    });
    expect(findUnique).not.toHaveBeenCalled();
  });

  it('refuses customer deletion of an emergency-stopped campaign', async () => {
    const deleteMany = vi.fn(async () => ({ count: 0 }));
    const store = new PrismaCampaignStore(database({ deleteMany }));

    await expect(store.deleteCampaign('org-id', 'campaign-id', 'actor-id')).resolves.toBe(false);

    expect(deleteMany).toHaveBeenCalledWith({
      where: { organizationId: 'org-id', id: 'campaign-id', emergencyStoppedAt: null },
    });
  });
});
