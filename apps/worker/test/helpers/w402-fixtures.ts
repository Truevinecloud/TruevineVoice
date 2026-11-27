import type { PrismaClient } from '@truevine/database';
import { randomUUID } from 'node:crypto';

export interface W402FixtureGraph {
  organizationId: string;
  userId: string;
  campaignId: string;
  recipientId: string;
  executionId: string;
}

export async function createW402Fixtures(prisma: PrismaClient): Promise<W402FixtureGraph> {
  const suffix = randomUUID();

  const user = await prisma.user.create({
    data: {
      id: randomUUID(),
      email: `w402-${suffix}@example.test`,
      passwordHash: 'test-hash',
    },
  });

  const organization = await prisma.organization.create({
    data: {
      id: randomUUID(),
      slug: `w402-${suffix}`,
      name: 'W402 Integration Test Org',
      memberships: {
        create: {
          userId: user.id,
          role: 'OWNER',
        },
      },
    },
  });

  const campaign = await prisma.campaign.create({
    data: {
      organizationId: organization.id,
      id: randomUUID(),
      name: 'W402 Test Campaign',
      status: 'ACTIVE',
      createdById: user.id,
    },
  });

  const contact = await prisma.contact.create({
    data: {
      organizationId: organization.id,
      id: randomUUID(),
      destination: '+12025550123',
      createdById: user.id,
    },
  });

  const recipient = await prisma.campaignRecipient.create({
    data: {
      organizationId: organization.id,
      id: randomUUID(),
      campaignId: campaign.id,
      contactId: contact.id,
      destination: '+12025550123',
    },
  });

  const execution = await prisma.campaignExecution.create({
    data: {
      organizationId: organization.id,
      id: randomUUID(),
      campaignId: campaign.id,
    },
  });

  return {
    organizationId: organization.id,
    userId: user.id,
    campaignId: campaign.id,
    recipientId: recipient.id,
    executionId: execution.id,
  };
}

export async function cleanupW402Fixtures(_prisma: PrismaClient, _graph: W402FixtureGraph): Promise<void> {
  // Call history and tenant campaign data are append-only/protected by database
  // triggers. Integration fixtures are uniquely identified and left in place.
}