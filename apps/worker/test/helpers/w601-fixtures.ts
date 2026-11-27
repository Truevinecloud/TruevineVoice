import { randomUUID } from 'node:crypto';

import type { PrismaClient } from '@truevine/database';

import {
  createW402Fixtures,
  type W402FixtureGraph,
} from './w402-fixtures.js';

/** Synthetic, non-production reserve injected only into the isolated child. */
export const W601_RESERVE_MINOR = 1_000n;

export interface W601FixtureGraph extends W402FixtureGraph {
  readonly dispatchEpoch: number;
}

export interface W601FixtureOptions {
  /** Integer minor units credited before any dispatch decision. */
  readonly balanceMinor?: bigint;
  readonly dispatchState?: 'RUNNING' | 'PAUSED' | 'CANCELLED';
}

export async function createW601Fixtures(
  prisma: PrismaClient,
  options: W601FixtureOptions = {},
): Promise<W601FixtureGraph> {
  const graph = await createW402Fixtures(prisma);
  const dispatchState = options.dispatchState ?? 'RUNNING';

  await prisma.campaign.update({
    where: {
      organizationId_id: {
        organizationId: graph.organizationId,
        id: graph.campaignId,
      },
    },
    data: { dispatchState, dispatchEpoch: 1 },
  });

  await prisma.walletEntry.create({
    data: {
      organizationId: graph.organizationId,
      amountMinor: options.balanceMinor ?? 10_000n,
      currency: 'UGX',
      reference: `w601-credit-${randomUUID()}`,
      description: 'W6-01 synthetic test credit',
    },
  });

  return { ...graph, dispatchEpoch: 1 };
}

export async function setCampaignDispatch(
  prisma: PrismaClient,
  graph: W601FixtureGraph,
  input: {
    readonly dispatchState?: 'RUNNING' | 'PAUSED' | 'CANCELLED';
    readonly emergencyStoppedAt?: Date | null;
    readonly dispatchStopReason?: string | null;
  },
): Promise<void> {
  await prisma.campaign.update({
    where: {
      organizationId_id: {
        organizationId: graph.organizationId,
        id: graph.campaignId,
      },
    },
    data: {
      ...(input.dispatchState ? { dispatchState: input.dispatchState } : {}),
      ...('emergencyStoppedAt' in input
        ? { emergencyStoppedAt: input.emergencyStoppedAt ?? null }
        : {}),
      ...('dispatchStopReason' in input
        ? { dispatchStopReason: input.dispatchStopReason ?? null }
        : {}),
      dispatchEpoch: { increment: 1 },
    },
  });
}

export async function addW601Recipient(
  prisma: PrismaClient,
  graph: W601FixtureGraph,
  destination: string,
): Promise<string> {
  const contact = await prisma.contact.create({
    data: {
      organizationId: graph.organizationId,
      id: randomUUID(),
      destination,
      createdById: graph.userId,
    },
  });
  const recipient = await prisma.campaignRecipient.create({
    data: {
      organizationId: graph.organizationId,
      id: randomUUID(),
      campaignId: graph.campaignId,
      contactId: contact.id,
      destination,
    },
  });
  return recipient.id;
}

/**
 * Adds a second running campaign in the same tenant so two workers can contend
 * on the same organization/currency wallet advisory lock.
 */
export async function addW601Campaign(
  prisma: PrismaClient,
  graph: W601FixtureGraph,
  destination: string,
): Promise<W601FixtureGraph> {
  const campaign = await prisma.campaign.create({
    data: {
      organizationId: graph.organizationId,
      id: randomUUID(),
      name: 'W601 concurrent campaign',
      status: 'ACTIVE',
      createdById: graph.userId,
      dispatchState: 'RUNNING',
      dispatchEpoch: 1,
    },
  });
  const contact = await prisma.contact.create({
    data: {
      organizationId: graph.organizationId,
      id: randomUUID(),
      destination,
      createdById: graph.userId,
    },
  });
  const recipient = await prisma.campaignRecipient.create({
    data: {
      organizationId: graph.organizationId,
      id: randomUUID(),
      campaignId: campaign.id,
      contactId: contact.id,
      destination,
    },
  });
  const execution = await prisma.campaignExecution.create({
    data: {
      organizationId: graph.organizationId,
      id: randomUUID(),
      campaignId: campaign.id,
    },
  });

  return {
    organizationId: graph.organizationId,
    userId: graph.userId,
    campaignId: campaign.id,
    recipientId: recipient.id,
    executionId: execution.id,
    dispatchEpoch: 1,
  };
}
