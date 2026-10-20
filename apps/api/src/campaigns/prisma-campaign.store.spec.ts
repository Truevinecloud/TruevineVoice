import { describe, expect, it, vi } from 'vitest';

import { PrismaCampaignStore } from './prisma-campaign.store.js';

describe('PrismaCampaignStore emergency-stop lock', () => {
  it('refuses customer reactivation when a campaign has an emergency-stop marker', async () => {
    const updateMany = vi.fn(async () => ({ count: 0 }));
    const findUnique = vi.fn();
    const store = new PrismaCampaignStore({ campaign: { updateMany, findUnique } } as never);

    const result = await store.updateCampaign('org-id', 'campaign-id', { status: 'ACTIVE' });

    expect(result).toBeUndefined();
    expect(updateMany).toHaveBeenCalledWith({
      where: { organizationId: 'org-id', id: 'campaign-id', emergencyStoppedAt: null },
      data: { status: 'ACTIVE' },
    });
    expect(findUnique).not.toHaveBeenCalled();
  });
});
