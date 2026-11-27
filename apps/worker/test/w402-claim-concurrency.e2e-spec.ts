import { describe, expect, it } from 'vitest';
import { CampaignExecutionClaimService } from '../src/campaigns/campaign-execution-claim.service.js';
import { createW402Fixtures } from './helpers/w402-fixtures.js';
import { createW402TestDatabaseClient } from './helpers/w402-test-database.js';

describe('w402 claim concurrency', () => {
  it('prevents duplicate claims for the same recipient', async () => {
    const prisma = await createW402TestDatabaseClient();
    try {
      const graph = await createW402Fixtures(prisma);
      const service = new CampaignExecutionClaimService(prisma as never);

      const [first, second] = await Promise.all([
        service.claim({ organizationId: graph.organizationId, campaignId: graph.campaignId, recipientId: graph.recipientId }),
        service.claim({ organizationId: graph.organizationId, campaignId: graph.campaignId, recipientId: graph.recipientId }),
      ]);

      const statuses = [first.status, second.status].sort();
      expect(statuses).toEqual(['already_claimed', 'claimed']);

      const attempts = await prisma.callAttempt.findMany({ where: { organizationId: graph.organizationId, executionId: graph.executionId, recipientId: graph.recipientId } });
      expect(attempts).toHaveLength(1);
    } finally {
      await prisma.$disconnect();
    }
  });

  it('returns already_claimed on repeated delivery', async () => {
    const prisma = await createW402TestDatabaseClient();
    try {
      const graph = await createW402Fixtures(prisma);
      const service = new CampaignExecutionClaimService(prisma as never);

      const first = await service.claim({ organizationId: graph.organizationId, campaignId: graph.campaignId, recipientId: graph.recipientId });
      const second = await service.claim({ organizationId: graph.organizationId, campaignId: graph.campaignId, recipientId: graph.recipientId });

      expect(first.status).toBe('claimed');
      expect(second.status).toBe('already_claimed');
    } finally {
      await prisma.$disconnect();
    }
  });

  it('returns organization_mismatch for a different organization', async () => {
    const prisma = await createW402TestDatabaseClient();
    try {
      const graph = await createW402Fixtures(prisma);
      const service = new CampaignExecutionClaimService(prisma as never);

      const result = await service.claim({ organizationId: '00000000-0000-0000-0000-000000000000', campaignId: graph.campaignId, recipientId: graph.recipientId });
      expect(result.status).toBe('missing_execution');
    } finally {
      await prisma.$disconnect();
    }
  });
});