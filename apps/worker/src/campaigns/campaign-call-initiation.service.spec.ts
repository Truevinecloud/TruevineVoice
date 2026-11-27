import { describe, expect, it, vi } from 'vitest';

import { CALLBACK_SOURCES, canonicalCampaignCallInitiation, FakeVoiceAdapter } from '@truevine/telephony';

import { DispatchGuard } from '../reliability/dispatch-guard.service.js';
import { CampaignExecutionClaimService } from './campaign-execution-claim.service.js';
import { CampaignCallInitiationService } from './campaign-call-initiation.service.js';
import { CallInitiationReconciliationService } from './call-initiation-reconciliation.service.js';

const orgId = '00000000-0000-4000-8000-000000000001';
const attemptId = '00000000-0000-4000-8000-000000000002';
const campaignId = '00000000-0000-4000-8000-000000000003';
const recipientId = '00000000-0000-4000-8000-000000000004';
const callDestination = '+15550001111';
const source = CALLBACK_SOURCES.fake;
const input = { organizationId: orgId, campaignId, recipientId };

function operationRequest() {
  return canonicalCampaignCallInitiation({
    organizationId: orgId,
    campaignId,
    recipientId,
    attemptId,
    attemptNumber: 1,
    destination: callDestination,
    bindingSource: source,
  });
}

function makeClaimService(result: unknown) {
  return { claim: async () => result } as unknown as CampaignExecutionClaimService;
}

function makePrisma(existingOperation: Record<string, unknown> | null = null) {
  const tx = {
    callOperation: {
      findUnique: async () => existingOperation,
      create: async () => ({ id: 'op-1' }),
    },
    callAttempt: {
      findUnique: async () => ({ destination: callDestination, attemptNumber: 1 }),
      updateMany: vi.fn(async (_input: unknown) => ({ count: 1 })),
    },
    callInitiationReconciliation: {
      findMany: vi.fn(async () => []),
      findUnique: vi.fn(async () => null),
      updateMany: vi.fn(async (_input: unknown) => ({ count: 1 })),
    },
    $executeRaw: vi.fn(async (_sql: TemplateStringsArray, ..._values: unknown[]) => 1),
    $queryRaw: async <T>() => [{ organization_id: orgId, attempt_id: attemptId }] as T,
  };
  return { ...tx, $transaction: async <T>(work: (client: typeof tx) => Promise<T>) => work(tx) };
}

function makeReconciliation(
  status: 'CONFIRMED' | 'FAILED_BEFORE_PROVIDER' | 'UNKNOWN' = 'UNKNOWN',
) {
  return {
    beginProviderInvocation: vi.fn(async () => true),
    reconcileAttempt: vi.fn(async () => ({
      status,
      outcome:
        status === 'CONFIRMED'
          ? 'confirmed_initiation'
          : status === 'FAILED_BEFORE_PROVIDER'
            ? 'confirmed_failure_before_provider'
            : 'unknown_provider_outcome',
      reconciliationRequired: status === 'UNKNOWN',
    })),
  } as unknown as CallInitiationReconciliationService;
}

function makeDispatchGuard(
  authorization: Awaited<ReturnType<DispatchGuard['authorize']>> = {
    ok: true,
    reservationId: '00000000-0000-4000-8000-000000000005',
    amountMinor: 1_000n,
    policyVersion: 'unit-test',
  },
): DispatchGuard {
  return { authorize: vi.fn(async () => authorization) } as unknown as DispatchGuard;
}

describe('CampaignCallInitiationService', () => {
  it('initiates successfully', async () => {
    const claim = { status: 'claimed', attemptId };
    const prisma = makePrisma();
    const operation = vi.spyOn(prisma.callOperation, 'create');
    const voice = new FakeVoiceAdapter();
    const invoke = vi.spyOn(voice, 'initiateCall');
    const request = operationRequest();
    const reconciliation = makeReconciliation();
    const service = new CampaignCallInitiationService(
      makeClaimService(claim), voice, prisma, source, reconciliation, makeDispatchGuard(),
    );
    const result = await service.initiate(input);
    expect(result).toMatchObject({
      status: 'initiated', attemptId, providerCallId: 'fake-1',
    });
    expect(invoke).toHaveBeenCalledWith({
      to: callDestination,
      callId: attemptId,
      organizationId: orgId,
      idempotencyKey: request.idempotencyKey,
    });
    const bindingCall = prisma.$executeRaw.mock.calls.find(([sql]) =>
      sql.join(' ').includes('voice_callback_bindings'),
    );
    expect(bindingCall?.slice(1)).toEqual([source, 'fake-1', orgId, attemptId]);
    expect(prisma.$executeRaw).toHaveBeenCalledBefore(prisma.callAttempt.updateMany);
    expect(prisma.callAttempt.updateMany).toHaveBeenCalledWith({
      where: { organizationId: orgId, id: attemptId, state: 'QUEUED' }, data: { state: 'DIALING' },
    });
    expect(reconciliation.beginProviderInvocation).toHaveBeenCalledWith(
      orgId,
      attemptId,
      expect.objectContaining({ callOperation: prisma.callOperation }),
    );
    expect(operation).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        organizationId: orgId,
        operation: request.operation,
        key: request.idempotencyKey,
        fingerprintVersion: request.fingerprintVersion,
        fingerprint: request.fingerprint,
        attemptId,
        result: { providerCallId: 'fake-1', bindingSource: source },
      }),
    }));
  });

  it('persists an uncertain operation when the provider omits its session ID', async () => {
    const claim = { status: 'claimed', attemptId };
    const voice = new FakeVoiceAdapter();
    vi.spyOn(voice, 'initiateCall').mockResolvedValue({
      callId: attemptId, state: 'DIALING', replayed: false,
    });
    const prisma = makePrisma();
    const operation = vi.spyOn(prisma.callOperation, 'create');
    const request = operationRequest();
    const service = new CampaignCallInitiationService(
      makeClaimService(claim), voice, prisma, source, makeReconciliation(), makeDispatchGuard(),
    );
    await expect(service.initiate(input)).resolves.toEqual({
      status: 'uncertain',
      attemptId,
      outcome: 'unknown_provider_outcome',
      reconciliationRequired: true,
    });
    expect(operation).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        organizationId: orgId,
        operation: request.operation,
        key: request.idempotencyKey,
        fingerprintVersion: request.fingerprintVersion,
        fingerprint: request.fingerprint,
        attemptId,
        result: { uncertain: true },
      }),
    }));
    expect(prisma.callAttempt.updateMany).not.toHaveBeenCalled();
  });

  it('fails closed before any attempt update when the binding cannot be written', async () => {
    const prisma = makePrisma();
    prisma.$executeRaw.mockRejectedValueOnce(new Error('database offline'));
    const service = new CampaignCallInitiationService(
      makeClaimService({ status: 'claimed', attemptId }),
      new FakeVoiceAdapter(),
      prisma,
      source,
      makeReconciliation(),
      makeDispatchGuard(),
    );
    await expect(service.initiate(input)).resolves.toEqual({
      status: 'uncertain',
      attemptId,
      outcome: 'unknown_provider_outcome',
      reconciliationRequired: true,
    });
    expect(prisma.callAttempt.updateMany).not.toHaveBeenCalled();
  });

  it('does not call the provider again when a prior attempt has no committed operation', async () => {
    const voice = new FakeVoiceAdapter();
    const initiate = vi.spyOn(voice, 'initiateCall');
    const reconciliation = makeReconciliation('FAILED_BEFORE_PROVIDER');
    const service = new CampaignCallInitiationService(
      makeClaimService({ status: 'already_claimed', attemptId }),
      voice,
      makePrisma(),
      source,
      reconciliation,
      makeDispatchGuard(),
    );
    await expect(service.initiate(input)).resolves.toEqual({
      status: 'failed_before_provider',
      attemptId,
      reconciliationRequired: false,
    });
    expect(initiate).not.toHaveBeenCalled();
    expect(reconciliation.reconcileAttempt).toHaveBeenCalledWith(orgId, attemptId);
  });

  it('replays existing operation', async () => {
    const claim = { status: 'already_claimed', attemptId };
    const request = operationRequest();
    const existing = {
      attemptId,
      fingerprintVersion: request.fingerprintVersion,
      fingerprint: request.fingerprint,
      result: { providerCallId: 'call-1', bindingSource: source },
    };
    const voice = new FakeVoiceAdapter();
    const invoke = vi.spyOn(voice, 'initiateCall');
    const service = new CampaignCallInitiationService(
      makeClaimService(claim), voice, makePrisma(existing), source, makeReconciliation(), makeDispatchGuard(),
    );
    const result = await service.initiate(input);
    expect(result).toMatchObject({ status: 'initiated', replayed: true, providerCallId: 'call-1' });
    expect(invoke).not.toHaveBeenCalled();
  });

  it('does not replay an operation with a different canonical fingerprint', async () => {
    const request = operationRequest();
    const existing = {
      attemptId,
      fingerprintVersion: request.fingerprintVersion,
      fingerprint: '0'.repeat(64),
      result: { providerCallId: 'call-1', bindingSource: source },
    };
    const voice = new FakeVoiceAdapter();
    const invoke = vi.spyOn(voice, 'initiateCall');
    const service = new CampaignCallInitiationService(
      makeClaimService({ status: 'already_claimed', attemptId }),
      voice,
      makePrisma(existing),
      source,
      makeReconciliation(),
      makeDispatchGuard(),
    );
    await expect(service.initiate(input)).rejects.toThrow(
      'campaign_call_initiation_idempotency_conflict',
    );
    expect(invoke).not.toHaveBeenCalled();
  });

  it('does not invoke the provider when the authoritative guard blocks', async () => {
    const voice = new FakeVoiceAdapter();
    const invoke = vi.spyOn(voice, 'initiateCall');
    const prisma = makePrisma();
    const operation = vi.spyOn(prisma.callOperation, 'create');
    const reconciliation = makeReconciliation('FAILED_BEFORE_PROVIDER');
    const service = new CampaignCallInitiationService(
      makeClaimService({ status: 'claimed', attemptId }),
      voice,
      prisma,
      source,
      reconciliation,
      makeDispatchGuard({ ok: false, reason: 'campaign_paused' }),
    );

    await expect(service.initiate(input)).resolves.toEqual({
      status: 'blocked',
      reason: 'campaign_paused',
      attemptId,
      reconciliationRequired: false,
    });
    expect(invoke).not.toHaveBeenCalled();
    expect(operation).not.toHaveBeenCalled();
    expect(reconciliation.reconcileAttempt).toHaveBeenCalledWith(
      orgId,
      attemptId,
      expect.anything(),
    );
  });

  it('propagates non-claimable status', async () => {
    const claim = { status: 'cancelled' };
    const service = new CampaignCallInitiationService(
      makeClaimService(claim), new FakeVoiceAdapter(), makePrisma(), source, makeReconciliation(), makeDispatchGuard(),
    );
    await expect(service.initiate(input)).resolves.toEqual({ status: 'cancelled' });
  });
});
