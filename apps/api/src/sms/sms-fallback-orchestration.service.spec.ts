import { describe, expect, it, vi } from 'vitest';

import { SmsFallbackEligibilityService } from './sms-fallback-eligibility.service.js';
import { SmsPort, SmsSendResult } from './sms-port.js';
import { SmsFallbackOrchestrationService, type Tx } from './sms-fallback-orchestration.service.js';

function makeSmsPort(overrides: Partial<SmsPort> = {}): SmsPort {
  return {
    provider: 'SYNTHETIC',
    environment: 'SANDBOX',
    isReady: vi.fn().mockResolvedValue({
      provider: 'SYNTHETIC',
      environment: 'SANDBOX',
      configured: true,
      enabled: true,
      ready: true,
      checkedAt: new Date(),
      checkResult: 'verified',
    }),
    send: vi.fn().mockResolvedValue({
      providerReference: 'synthetic:msg-1',
      accepted: true,
      rejected: false,
      uncertain: false,
    } as SmsSendResult),
    ...overrides,
  } as SmsPort;
}

/**
 * Builds a mock transactional client. The `$queryRaw` mock returns data based
 * on the SQL template string, simulating server-side database records:
 *
 *   1. call_attempts      -> voice attempt state
 *   2. organizations      -> SMS entitlement + suspension
 *   3. campaigns          -> SMS fallback enabled + approved message
 *   4. contacts           -> phone number + suppression
 *   5. wallet_entries     -> billing balance
 *   6. pg_advisory_xact_lock -> lock acquisition (inside transaction)
 *
 * Missing columns default to deny (fail closed).
 */
function makeTx(overrides: Partial<{
  smsFallbackOperation: {
    findUnique: ReturnType<typeof vi.fn>;
    create: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
  };
  $transaction: ReturnType<typeof vi.fn>;
  queryResults?: Record<string, unknown[]>;
}> = {}) {
  const smsFallbackOperation = {
    findUnique: vi.fn().mockResolvedValue(null),
    create: vi.fn().mockResolvedValue({ id: 'fallback-1' }),
    update: vi.fn().mockResolvedValue({ id: 'fallback-1' }),
    ...overrides.smsFallbackOperation,
  };

  const defaultResults: Record<string, unknown[]> = {
    call_attempts: [{ state: 'FAILED', recipient_id: 'recipient-1' }],
    organizations: [{ sms_entitled: true, suspended_at: null }],
    campaigns: [{ sms_fallback_enabled: true, sms_fallback_message: 'Your voice call failed. Please call back.', emergency_stopped_at: null }],
    contacts: [{ phone_e164: '+256700000000', suppressed_at: null, sms_consent: true }],
    wallet_entries: [{ balance: '1000' }],
  };
  const results = { ...defaultResults, ...overrides.queryResults };

  const $queryRaw = vi.fn((_strings: TemplateStringsArray, ..._values: unknown[]) => {
    const sql = String(_strings[0]);

    // Advisory lock inside the transaction.
    if (sql.includes('pg_advisory_xact_lock')) {
      return Promise.resolve([{ lock: 1 }]);
    }

    // Route by table name for eligibility queries (outside the transaction).
    // Check more specific queries first: contacts JOIN references call_attempts.
    if (sql.includes('contacts')) return Promise.resolve(results['contacts']);
    if (sql.includes('call_attempts')) return Promise.resolve(results['call_attempts']);
    if (sql.includes('organizations')) return Promise.resolve(results['organizations']);
    if (sql.includes('campaigns')) return Promise.resolve(results['campaigns']);
    if (sql.includes('wallet_entries')) return Promise.resolve(results['wallet_entries']);
    if (sql.includes('sms_fallback_operations')) return Promise.resolve(results['smsFallbackOperations'] ?? []);

    return Promise.resolve([]);
  }) as ReturnType<typeof vi.fn>;

  const $transaction = vi.fn(async (work: (innerTx: { smsFallbackOperation: typeof smsFallbackOperation; $queryRaw: typeof $queryRaw }) => Promise<unknown>) => {
    return await work({ smsFallbackOperation, $queryRaw });
  }) as unknown as ReturnType<typeof vi.fn>;
  const finalTransaction = overrides.$transaction ?? $transaction;

  return { tx: { smsFallbackOperation, $transaction: finalTransaction, $queryRaw } as unknown, smsFallbackOperation, $transaction: finalTransaction, $queryRaw };
}

describe('SmsFallbackOrchestrationService', () => {
  const eligibility = new SmsFallbackEligibilityService();

  // Enable billing authorization for synthetic test environment.
  process.env['W504_SMS_BILLING_AUTHORIZED'] = 'true';

  const baseInput = {
    organizationId: 'org-1',
    campaignId: 'camp-1',
    voiceAttemptId: 'attempt-1',
  };

  it('creates a fallback and dispatches to provider', async () => {
    const sms = makeSmsPort();
    const { tx } = makeTx();
    const service = new SmsFallbackOrchestrationService(eligibility, sms, tx as unknown as Tx);

    const result = await service.evaluateAndDispatch(baseInput);

    expect(result.status).toBe('eligible_pending');
    if (result.status === 'eligible_pending') {
      expect(result.fallbackId).toBe('fallback-1');
    }
    expect(sms.send).toHaveBeenCalledWith({
      to: '+256700000000',
      body: 'Your voice call failed. Please call back.',
      idempotencyKey: 'org-1:camp-1:recipient-1',
      organizationId: 'org-1',
      campaignId: 'camp-1',
      recipientId: 'recipient-1',
    });
  });

  it('denies when organization has no SMS entitlement', async () => {
    const sms = makeSmsPort();
    const { tx } = makeTx({
      queryResults: {
        organizations: [{ sms_entitled: false, suspended_at: null }],
      },
    });
    const service = new SmsFallbackOrchestrationService(eligibility, sms, tx as unknown as Tx);

    const result = await service.evaluateAndDispatch(baseInput);

    expect(result.status).toBe('ineligible');
    if (result.status === 'ineligible') {
      expect(result.reason).toContain('entitlement');
    }
    expect(sms.send).not.toHaveBeenCalled();
  });

  it('denies when campaign SMS fallback is not enabled', async () => {
    const sms = makeSmsPort();
    const { tx } = makeTx({
      queryResults: {
        campaigns: [{ sms_fallback_enabled: false, sms_fallback_message: null }],
      },
    });
    const service = new SmsFallbackOrchestrationService(eligibility, sms, tx as unknown as Tx);

    const result = await service.evaluateAndDispatch(baseInput);

    expect(result.status).toBe('ineligible');
    if (result.status === 'ineligible') {
      expect(result.reason).toContain('SMS fallback');
    }
    expect(sms.send).not.toHaveBeenCalled();
  });

  it('denies when recipient is suppressed', async () => {
    const sms = makeSmsPort();
    const { tx } = makeTx({
      queryResults: {
        contacts: [{ phone_e164: '+256700000000', suppressed_at: new Date() }],
      },
    });
    const service = new SmsFallbackOrchestrationService(eligibility, sms, tx as unknown as Tx);

    const result = await service.evaluateAndDispatch(baseInput);

    expect(result.status).toBe('ineligible');
    if (result.status === 'ineligible') {
      expect(result.reason).toContain('suppressed');
    }
    expect(sms.send).not.toHaveBeenCalled();
  });

  it('denies when voice call was answered successfully', async () => {
    const sms = makeSmsPort();
    const { tx } = makeTx({
      queryResults: {
        call_attempts: [{ state: 'ANSWERED' }],
      },
    });
    const service = new SmsFallbackOrchestrationService(eligibility, sms, tx as unknown as Tx);

    const result = await service.evaluateAndDispatch(baseInput);

    expect(result.status).toBe('ineligible');
    if (result.status === 'ineligible') {
      expect(result.reason).toContain('terminal');
    }
    expect(sms.send).not.toHaveBeenCalled();
  });

  it('denies when billing authorization is not enabled', async () => {
    const original = process.env['W504_SMS_BILLING_AUTHORIZED'];
    delete process.env['W504_SMS_BILLING_AUTHORIZED'];
    try {
      const sms = makeSmsPort();
      const { tx } = makeTx();
      const service = new SmsFallbackOrchestrationService(eligibility, sms, tx as unknown as Tx);

      const result = await service.evaluateAndDispatch(baseInput);

      expect(result.status).toBe('ineligible');
      if (result.status === 'ineligible') {
        expect(result.reason).toContain('authorization');
      }
      expect(sms.send).not.toHaveBeenCalled();
    } finally {
      if (original !== undefined) process.env['W504_SMS_BILLING_AUTHORIZED'] = original;
      else delete process.env['W504_SMS_BILLING_AUTHORIZED'];
    }
  });

  it('returns already_pending for duplicate fallback', async () => {
    const sms = makeSmsPort();
    const { tx } = makeTx({
      queryResults: {
        smsFallbackOperations: [{ id: 'fallback-1', status: 'PENDING', provider_reference: null }],
      },
    });
    const service = new SmsFallbackOrchestrationService(eligibility, sms, tx as unknown as Tx);

    const result = await service.evaluateAndDispatch(baseInput);

    expect(result.status).toBe('already_pending');
    if (result.status === 'already_pending') {
      expect(result.fallbackId).toBe('fallback-1');
    }
    expect(sms.send).not.toHaveBeenCalled();
  });

  it('returns already_sent when fallback already sent', async () => {
    const sms = makeSmsPort();
    const { tx } = makeTx({
      queryResults: {
        smsFallbackOperations: [{ id: 'fallback-1', status: 'SENT', provider_reference: 'synthetic:msg-1' }],
      },
    });
    const service = new SmsFallbackOrchestrationService(eligibility, sms, tx as unknown as Tx);

    const result = await service.evaluateAndDispatch(baseInput);

    expect(result.status).toBe('already_sent');
    if (result.status === 'already_sent') {
      expect(result.fallbackId).toBe('fallback-1');
      expect(result.providerReference).toBe('synthetic:msg-1');
    }
    expect(sms.send).not.toHaveBeenCalled();
  });

  it('returns already_failed when fallback already failed', async () => {
    const sms = makeSmsPort();
    const { tx } = makeTx({
      queryResults: {
        smsFallbackOperations: [{ id: 'fallback-1', status: 'FAILED', provider_reference: null }],
      },
    });
    const service = new SmsFallbackOrchestrationService(eligibility, sms, tx as unknown as Tx);

    const result = await service.evaluateAndDispatch(baseInput);

    expect(result.status).toBe('already_failed');
    if (result.status === 'already_failed') {
      expect(result.fallbackId).toBe('fallback-1');
    }
    expect(sms.send).not.toHaveBeenCalled();
  });

  it('returns already_uncertain when fallback outcome is uncertain', async () => {
    const sms = makeSmsPort();
    const { tx } = makeTx({
      queryResults: {
        smsFallbackOperations: [{ id: 'fallback-1', status: 'UNCERTAIN', provider_reference: null }],
      },
    });
    const service = new SmsFallbackOrchestrationService(eligibility, sms, tx as unknown as Tx);

    const result = await service.evaluateAndDispatch(baseInput);

    expect(result.status).toBe('already_uncertain');
    if (result.status === 'already_uncertain') {
      expect(result.fallbackId).toBe('fallback-1');
    }
    expect(sms.send).not.toHaveBeenCalled();
  });

  it('returns ineligible when eligibility check fails', async () => {
    const sms = makeSmsPort();
    const { tx } = makeTx({
      queryResults: {
        call_attempts: [], // voice attempt not found -> voiceTerminal = false
      },
    });
    const service = new SmsFallbackOrchestrationService(eligibility, sms, tx as unknown as Tx);

    const result = await service.evaluateAndDispatch(baseInput);

    expect(result.status).toBe('ineligible');
    if (result.status === 'ineligible') {
      expect(result.reason).toContain('terminal');
    }
    expect(sms.send).not.toHaveBeenCalled();
  });

  it('marks uncertain when provider times out', async () => {
    const sms = makeSmsPort({
      send: vi.fn().mockRejectedValue(new Error('sms_provider_timeout')),
    });
    const { tx } = makeTx();
    const service = new SmsFallbackOrchestrationService(eligibility, sms, tx as unknown as Tx);

    const result = await service.evaluateAndDispatch(baseInput);

    expect(result.status).toBe('already_uncertain');
    if (result.status === 'already_uncertain') {
      expect(result.fallbackId).toBe('fallback-1');
    }
  });

  it('marks failed when provider rejects', async () => {
    const sms = makeSmsPort({
      send: vi.fn().mockResolvedValue({
        providerReference: 'synthetic:msg-1',
        accepted: false,
        rejected: true,
        uncertain: false,
      } as SmsSendResult),
    });
    const { tx } = makeTx();
    const service = new SmsFallbackOrchestrationService(eligibility, sms, tx as unknown as Tx);

    const result = await service.evaluateAndDispatch(baseInput);

    expect(result.status).toBe('already_failed');
    if (result.status === 'already_failed') {
      expect(result.fallbackId).toBe('fallback-1');
    }
  });

  it('marks uncertain when provider returns uncertain outcome', async () => {
    const sms = makeSmsPort({
      send: vi.fn().mockResolvedValue({
        providerReference: 'synthetic:msg-1',
        accepted: false,
        rejected: false,
        uncertain: true,
      } as SmsSendResult),
    });
    const { tx } = makeTx();
    const service = new SmsFallbackOrchestrationService(eligibility, sms, tx as unknown as Tx);

    const result = await service.evaluateAndDispatch(baseInput);

    expect(result.status).toBe('already_uncertain');
    if (result.status === 'already_uncertain') {
      expect(result.fallbackId).toBe('fallback-1');
    }
  });

  it('returns retryable_conflict on database error', async () => {
    const sms = makeSmsPort();
    const { tx } = makeTx({
      $transaction: vi.fn().mockRejectedValue(new Error('database error')),
    });
    const service = new SmsFallbackOrchestrationService(eligibility, sms, tx as unknown as Tx);

    const result = await service.evaluateAndDispatch(baseInput);

    expect(result.status).toBe('retryable_conflict');
  });

  it('returns fallback status', async () => {
    const sms = makeSmsPort();
    const { tx } = makeTx({
      queryResults: {
        smsFallbackOperations: [{ id: 'fallback-1', status: 'SENT' }],
      },
    });
    const service = new SmsFallbackOrchestrationService(eligibility, sms, tx as unknown as Tx);

    const result = await service.getFallbackStatus('org-1', 'camp-1', 'recipient-1', 'attempt-1');

    expect(result).toEqual({ status: 'SENT', fallbackId: 'fallback-1' });
  });

  it('returns null for missing fallback', async () => {
    const sms = makeSmsPort();
    const { tx } = makeTx({
      queryResults: {
        smsFallbackOperations: [],
      },
    });
    const service = new SmsFallbackOrchestrationService(eligibility, sms, tx as unknown as Tx);

    const result = await service.getFallbackStatus('org-1', 'camp-1', 'recipient-1', 'attempt-1');

    expect(result).toBeNull();
  });
});
