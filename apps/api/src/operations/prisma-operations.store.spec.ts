import { beforeEach, describe, expect, it, vi } from 'vitest';

import { PrismaOperationsStore } from './prisma-operations.store.js';

const ORGANIZATION_ID = '00000000-0000-4000-8000-000000000001';
const CAMPAIGN_ID = '00000000-0000-4000-8000-000000000002';
const ACTOR_ID = '00000000-0000-4000-8000-000000000003';

function fixture(status: 'ACTIVE' | 'COMPLETED' = 'ACTIVE', emergencyStopped = false) {
  let campaign: Record<string, unknown> | null = {
    organizationId: ORGANIZATION_ID,
    id: CAMPAIGN_ID,
    name: 'Synthetic campaign',
    status,
    emergencyStoppedAt: emergencyStopped ? new Date('2026-10-20T00:00:00Z') : null,
    updatedAt: new Date('2026-10-20T00:00:00Z'),
    organization: { name: 'Synthetic org', slug: 'synthetic-org' },
  };
  const auditEvents: Record<string, unknown>[] = [];
  const auditFailure = { enabled: false };
  const updateWhere: Record<string, unknown>[] = [];

  const database = {
    organization: { findMany: vi.fn(async () => []) },
    campaign: { findMany: vi.fn(async () => []) },
    securityAuditEvent: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        if (auditFailure.enabled) throw new Error('audit unavailable');
        auditEvents.push(data);
        return data;
      }),
    },
    $transaction: vi.fn(async (work: (tx: Record<string, unknown>) => Promise<unknown>) => {
      const nextCampaign = campaign ? { ...campaign } : null;
      const nextEvents: Record<string, unknown>[] = [];
      const tx = {
        $queryRaw: vi.fn().mockResolvedValue([{ role: 'PLATFORM_OWNER' }]),
        campaign: {
          updateMany: async ({
            where,
            data,
          }: {
            where: Record<string, unknown>;
            data: Record<string, unknown>;
          }) => {
            updateWhere.push(where);
            if (
              !nextCampaign ||
              Object.entries(where).some(([key, value]) => nextCampaign[key] !== value)
            )
              return { count: 0 };
            Object.assign(nextCampaign, data);
            return { count: 1 };
          },
          findUnique: async ({
            where,
          }: {
            where: { organizationId_id: { organizationId: string; id: string } };
          }) =>
            nextCampaign &&
            nextCampaign.organizationId === where.organizationId_id.organizationId &&
            nextCampaign.id === where.organizationId_id.id
              ? nextCampaign
              : null,
          findUniqueOrThrow: async () => nextCampaign,
        },
        securityAuditEvent: {
          create: async ({ data }: { data: Record<string, unknown> }) => {
            if (auditFailure.enabled) throw new Error('audit unavailable');
            nextEvents.push(data);
            return data;
          },
        },
      };
      const result = await work(tx);
      campaign = nextCampaign;
      auditEvents.push(...nextEvents);
      return result;
    }),
  };

  return {
    store: new PrismaOperationsStore(database as never),
    getCampaign: () => campaign,
    auditEvents,
    auditFailure,
    updateWhere,
  };
}

describe('PrismaOperationsStore emergency stop', () => {
  let state: ReturnType<typeof fixture>;

  beforeEach(() => {
    state = fixture();
  });

  it('stops only the active campaign in the requested organization and writes a platform audit event', async () => {
    const result = await state.store.emergencyStop({
      organizationId: ORGANIZATION_ID,
      campaignId: CAMPAIGN_ID,
      actorUserId: ACTOR_ID,
      reasonCode: 'provider_incident',
      stoppedAt: new Date('2026-10-20T01:00:00Z'),
    });

    expect(result.kind).toBe('stopped');
    expect(state.getCampaign()).toMatchObject({
      status: 'COMPLETED',
      emergencyStoppedAt: new Date('2026-10-20T01:00:00Z'),
    });
    expect(state.updateWhere[0]).toMatchObject({
      organizationId: ORGANIZATION_ID,
      id: CAMPAIGN_ID,
      status: 'ACTIVE',
      emergencyStoppedAt: null,
    });
    expect(state.auditEvents).toEqual([
      expect.objectContaining({
        organizationId: ORGANIZATION_ID,
        actorUserId: ACTOR_ID,
        action: 'platform.campaign.emergency_stopped',
        scope: 'PLATFORM',
        outcome: 'SUCCESS',
        targetType: 'campaign',
        targetId: CAMPAIGN_ID,
        metadata: expect.objectContaining({
          reasonCode: 'provider_incident',
          auditVersion: 1,
          before: { status: 'ACTIVE', emergencyStoppedAt: null },
          after: { status: 'COMPLETED', emergencyStoppedAt: '2026-10-20T01:00:00.000Z' },
        }),
      }),
    ]);
  });

  it('returns not found for a campaign addressed through another organization', async () => {
    const result = await state.store.emergencyStop({
      organizationId: '00000000-0000-4000-8000-000000000099',
      campaignId: CAMPAIGN_ID,
      actorUserId: ACTOR_ID,
      reasonCode: 'provider_incident',
      stoppedAt: new Date(),
    });

    expect(result).toEqual({ kind: 'not_found' });
    expect(state.getCampaign()).toMatchObject({ status: 'ACTIVE' });
    expect(state.auditEvents).toHaveLength(0);
  });

  it('keeps emergency stop and its audit atomic when audit storage fails', async () => {
    state.auditFailure.enabled = true;
    await expect(
      state.store.emergencyStop({
        organizationId: ORGANIZATION_ID,
        campaignId: CAMPAIGN_ID,
        actorUserId: ACTOR_ID,
        reasonCode: 'provider_incident',
        stoppedAt: new Date(),
      }),
    ).rejects.toThrow('audit unavailable');

    expect(state.getCampaign()).toMatchObject({ status: 'ACTIVE', emergencyStoppedAt: null });
    expect(state.auditEvents).toHaveLength(0);
  });

  it('does not write another success audit for an already stopped campaign', async () => {
    state = fixture('COMPLETED', true);
    const result = await state.store.emergencyStop({
      organizationId: ORGANIZATION_ID,
      campaignId: CAMPAIGN_ID,
      actorUserId: ACTOR_ID,
      reasonCode: 'provider_incident',
      stoppedAt: new Date(),
    });

    expect(result.kind).toBe('already_stopped');
    expect(state.auditEvents).toHaveLength(0);
  });
});
