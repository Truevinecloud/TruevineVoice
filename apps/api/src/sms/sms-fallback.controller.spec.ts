import { describe, expect, it, vi } from 'vitest';

import { SmsFallbackController } from './sms-fallback.controller.js';
import { SmsFallbackOrchestrationService } from './sms-fallback-orchestration.service.js';

const organizationId = 'org-1';
const campaignId = 'camp-1';
const voiceAttemptId = 'attempt-1';

interface MockDb {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  $queryRaw: any;
}

function makeDb(queries: Record<string, unknown[]>): MockDb {
  let callCount = 0;
  return {
    $queryRaw: vi.fn(() => {
      callCount += 1;
      if (callCount === 1) return Promise.resolve(queries['campaigns']);
      if (callCount === 2) return Promise.resolve(queries['attempts']);
      return Promise.resolve([]);
    }) as unknown,
  };
}

function makeFallback(result: unknown) {
  return { evaluateAndDispatch: vi.fn().mockResolvedValue(result) };
}

function expectHttpError(
  promise: Promise<unknown>,
  statusCode: number,
  code: string,
): Promise<void> {
  return promise.then(
    () => {
      throw new Error(`Expected HTTP ${statusCode} error but promise resolved`);
    },
    (err: { status?: number; response?: { error?: { code?: string } } }) => {
      expect(err.status).toBe(statusCode);
      expect(err.response?.error?.code).toBe(code);
    },
  );
}

describe('SmsFallbackController', () => {
  it('triggers eligible fallback and returns the outcome', async () => {
    const fallback = makeFallback({ status: 'eligible_pending', fallbackId: 'fb-1' });
    const db = makeDb({
      campaigns: [{ id: campaignId }],
      attempts: [{ id: voiceAttemptId }],
    });
    const controller = new SmsFallbackController(
      fallback as unknown as SmsFallbackOrchestrationService,
      db,
    );

    const result = await controller.triggerFallback(
      { organizationId },
      campaignId,
      { voiceAttemptId },
    );

    expect(result).toEqual({ status: 'eligible_pending', fallbackId: 'fb-1' });
    expect(fallback.evaluateAndDispatch).toHaveBeenCalledWith({
      organizationId,
      campaignId,
      voiceAttemptId,
    });
  });

  it('rejects missing voiceAttemptId', async () => {
    const fallback = makeFallback(null);
    const db = makeDb({});
    const controller = new SmsFallbackController(
      fallback as unknown as SmsFallbackOrchestrationService,
      db,
    );

    await expectHttpError(
      controller.triggerFallback(
        { organizationId },
        campaignId,
        {},
      ),
      403,
      'sms_fallback_invalid_request',
    );
  });

  it('returns 404 when campaign does not belong to organization', async () => {
    const fallback = makeFallback(null);
    const db = makeDb({ campaigns: [] });
    const controller = new SmsFallbackController(
      fallback as unknown as SmsFallbackOrchestrationService,
      db,
    );

    await expectHttpError(
      controller.triggerFallback(
        { organizationId },
        campaignId,
        { voiceAttemptId },
      ),
      404,
      'campaign_not_found',
    );
    expect(fallback.evaluateAndDispatch).not.toHaveBeenCalled();
  });

  it('returns 404 when voice attempt does not belong to campaign', async () => {
    const fallback = makeFallback(null);
    const db = makeDb({ campaigns: [{ id: campaignId }], attempts: [] });
    const controller = new SmsFallbackController(
      fallback as unknown as SmsFallbackOrchestrationService,
      db,
    );

    await expectHttpError(
      controller.triggerFallback(
        { organizationId },
        campaignId,
        { voiceAttemptId },
      ),
      404,
      'voice_attempt_not_found',
    );
    expect(fallback.evaluateAndDispatch).not.toHaveBeenCalled();
  });

  it('returns already_sent for duplicate trigger', async () => {
    const fallback = makeFallback({
      status: 'already_sent',
      fallbackId: 'fb-1',
      providerReference: 'synthetic:org-1:camp-1:recipient-1:attempt-1',
    });
    const db = makeDb({
      campaigns: [{ id: campaignId }],
      attempts: [{ id: voiceAttemptId }],
    });
    const controller = new SmsFallbackController(
      fallback as unknown as SmsFallbackOrchestrationService,
      db,
    );

    const result = await controller.triggerFallback(
      { organizationId },
      campaignId,
      { voiceAttemptId },
    );

    expect(result).toEqual({
      status: 'already_sent',
      fallbackId: 'fb-1',
      providerReference: 'synthetic:org-1:camp-1:recipient-1:attempt-1',
    });
  });

  it('returns already_uncertain for uncertain prior outcome', async () => {
    const fallback = makeFallback({
      status: 'already_uncertain',
      fallbackId: 'fb-1',
    });
    const db = makeDb({
      campaigns: [{ id: campaignId }],
      attempts: [{ id: voiceAttemptId }],
    });
    const controller = new SmsFallbackController(
      fallback as unknown as SmsFallbackOrchestrationService,
      db,
    );

    const result = await controller.triggerFallback(
      { organizationId },
      campaignId,
      { voiceAttemptId },
    );

    expect(result).toEqual({ status: 'already_uncertain', fallbackId: 'fb-1' });
  });

  it('returns ineligible when eligibility check fails', async () => {
    const fallback = makeFallback({
      status: 'ineligible',
      reason: 'Recipient is suppressed or opted out of SMS.',
    });
    const db = makeDb({
      campaigns: [{ id: campaignId }],
      attempts: [{ id: voiceAttemptId }],
    });
    const controller = new SmsFallbackController(
      fallback as unknown as SmsFallbackOrchestrationService,
      db,
    );

    const result = await controller.triggerFallback(
      { organizationId },
      campaignId,
      { voiceAttemptId },
    );

    expect(result).toEqual({
      status: 'ineligible',
      reason: 'Recipient is suppressed or opted out of SMS.',
    });
  });
});
