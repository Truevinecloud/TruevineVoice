import { describe, expect, it } from 'vitest';
import { createW402Fixtures } from './helpers/w402-fixtures.js';
import { createW402TestDatabaseClient } from './helpers/w402-test-database.js';

describe('w402 fixture smoke', () => {
  it('persists a campaign execution graph in the isolated database', async () => {
    const prisma = await createW402TestDatabaseClient();
    try {
      const graph = await createW402Fixtures(prisma);
      const execution = await prisma.campaignExecution.findUnique({ where: { organizationId_id: { organizationId: graph.organizationId, id: graph.executionId } } });
      expect(execution).not.toBeNull();
    } finally {
      await prisma.$disconnect();
    }
  });
});