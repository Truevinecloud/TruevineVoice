import { describe, expect, it, vi } from 'vitest';

import { CampaignExecutionProcessor } from './campaign-execution.processor.js';

function makePrisma(
  execution: unknown,
  campaign: Record<string, unknown> = {
    status: 'ACTIVE',
    dispatchState: 'RUNNING',
    dispatchEpoch: 1,
    emergencyStoppedAt: null,
  },
) {
  return {
    campaignExecution: {
      findUnique: async () => execution,
    },
    campaign: {
      findUnique: async () => campaign,
    },
  } as never;
}

describe('CampaignExecutionProcessor', () => {
  it('returns missing for absent execution', async () => {
    const processor = new CampaignExecutionProcessor({} as never, makePrisma(null));
    await expect(processor.process({ organizationId: 'org', campaignId: 'camp' })).resolves.toEqual({ status: 'missing' });
  });

  it('returns already_completed for completed execution', async () => {
    const processor = new CampaignExecutionProcessor({} as never, makePrisma({ status: 'COMPLETED', completedAt: new Date() }));
    await expect(processor.process({ organizationId: 'org', campaignId: 'camp' })).resolves.toEqual({ status: 'already_completed' });
  });

  it('returns cancelled for cancelled execution', async () => {
    const processor = new CampaignExecutionProcessor({} as never, makePrisma({ status: 'CANCELLED' }));
    await expect(processor.process({ organizationId: 'org', campaignId: 'camp' })).resolves.toEqual({ status: 'cancelled' });
  });

  it('returns paused for paused execution', async () => {
    const processor = new CampaignExecutionProcessor({} as never, makePrisma({ status: 'PAUSED' }));
    await expect(processor.process({ organizationId: 'org', campaignId: 'camp' })).resolves.toEqual({ status: 'paused' });
  });

  it('returns eligible for valid execution', async () => {
    const processor = new CampaignExecutionProcessor({} as never, makePrisma({ status: 'QUEUED' }));
    await expect(processor.process({ organizationId: 'org', campaignId: 'camp' })).resolves.toEqual({ status: 'eligible' });
  });

  it('keeps initiation disabled in the application processor by default', async () => {
    const callInitiation = { initiate: vi.fn() };
    const processor = new CampaignExecutionProcessor(
      {} as never,
      makePrisma({ status: 'QUEUED' }),
      undefined,
      callInitiation as never,
    );

    await expect(processor.process({ organizationId: 'org', campaignId: 'camp' })).resolves.toEqual({
      status: 'eligible',
    });
    expect(callInitiation.initiate).not.toHaveBeenCalled();
  });

  it('refuses W402 execution unless all isolated targets and the unique queue are configured', async () => {
    const callInitiation = { initiate: vi.fn() };
    const processor = new CampaignExecutionProcessor(
      {} as never,
      makePrisma(null),
      {
        environment: 'test',
        databaseUrl: 'postgresql://localhost:55432/truevine_voice',
        redisUrl: 'redis://localhost:56379',
      } as never,
      callInitiation as never,
      'w402-test',
    );

    await expect(processor.process({ organizationId: 'org', campaignId: 'camp' })).rejects.toThrow(
      'w402-test execution requires the local truevine_w402_integration_test database, Redis on port 56379, and a unique w402-* queue.',
    );
    expect(callInitiation.initiate).not.toHaveBeenCalled();
  });

  it('refuses W6-01 execution unless the dedicated database, Redis and queue are configured', async () => {
    const callInitiation = { initiate: vi.fn() };
    const processor = new CampaignExecutionProcessor(
      {} as never,
      makePrisma(null),
      {
        environment: 'test',
        databaseUrl: 'postgresql://localhost:55432/truevine_w402_integration_test',
        redisUrl: 'redis://localhost:56379',
      } as never,
      callInitiation as never,
      'w601-test',
    );

    await expect(processor.process({ organizationId: 'org', campaignId: 'camp' })).rejects.toThrow(
      'w601-test execution requires the local truevine_w601_qa database, Redis on port 56382, and a unique w601-* queue.',
    );
    expect(callInitiation.initiate).not.toHaveBeenCalled();
  });

  it('throws on invalid payload', async () => {
    const processor = new CampaignExecutionProcessor({} as never, makePrisma(null));
    await expect(processor.process({ organizationId: '', campaignId: 'camp' })).rejects.toThrow();
  });
});