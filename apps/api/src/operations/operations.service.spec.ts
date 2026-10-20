import { describe, expect, it, vi } from 'vitest';

import { OperationsService } from './operations.service.js';
import type { OperationsStore } from './operations.store.js';

const campaign = {
  organizationId: 'org-1',
  organizationName: 'Synthetic org',
  organizationSlug: 'synthetic-org',
  id: 'campaign-1',
  name: 'Synthetic campaign',
  status: 'PAUSED' as const,
  emergencyStoppedAt: new Date('2026-10-20T00:00:00Z'),
  updatedAt: new Date('2026-10-20T00:00:00Z'),
};

function service(storeOverrides: Partial<OperationsStore> = {}) {
  const store: OperationsStore = {
    listOrganizations: vi.fn(async () => []),
    listCampaigns: vi.fn(async () => []),
    emergencyStop: vi.fn(async () => ({ kind: 'stopped' as const, campaign })),
    ...storeOverrides,
  };
  const health = { check: vi.fn(async () => ({ status: 'ok', dependencies: {} })) };
  return { operations: new OperationsService(store, health as never), store, health };
}

describe('OperationsService', () => {
  it('accepts only allowlisted reason codes and records actor and tenant scope', async () => {
    const state = service();
    await expect(
      state.operations.emergencyStop('org-1', 'campaign-1', 'operator-1', 'free text'),
    ).rejects.toMatchObject({ status: 400 });
    expect(state.store.emergencyStop).not.toHaveBeenCalled();

    const result = await state.operations.emergencyStop(
      'org-1',
      'campaign-1',
      'operator-1',
      'provider_incident',
    );
    expect(state.store.emergencyStop).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: 'org-1',
        campaignId: 'campaign-1',
        actorUserId: 'operator-1',
        reasonCode: 'provider_incident',
      }),
    );
    expect(result).toMatchObject({
      status: 'PAUSED',
      stopResult: 'stopped',
      voiceDispatchStopped: false,
    });
  });

  it('reports provider integration as unavailable instead of inventing call health', async () => {
    const state = service();
    const report = await state.operations.healthReport();
    expect(report.voiceProvider).toEqual({ status: 'not_integrated', activeCalls: null });
  });
});
