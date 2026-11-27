import { describe, expect, it, vi } from 'vitest';

import { CallInitiationReconciliationService } from './call-initiation-reconciliation.service.js';

const organizationId = '00000000-0000-4000-8000-000000000001';
const attemptId = '00000000-0000-4000-8000-000000000002';

function makeService(status: string, updates: number[]) {
  const updateMany = vi.fn(async () => ({ count: updates.shift() ?? 0 }));
  const findUnique = vi.fn(async () => ({
    attemptId,
    status,
    reconciliationRequired: status === 'UNKNOWN' || status === 'INVOKING' || status === 'NOT_STARTED',
  }));
  const findMany = vi.fn(async () => []);
  const service = new CallInitiationReconciliationService({
    callInitiationReconciliation: { updateMany, findUnique, findMany },
  } as never);
  return { service, updateMany, findUnique, findMany };
}

describe('CallInitiationReconciliationService', () => {
  it('classifies a not-started claim without making a provider request', async () => {
    const { service, updateMany } = makeService('FAILED_BEFORE_PROVIDER', [1]);

    await expect(service.reconcileAttempt(organizationId, attemptId)).resolves.toEqual({
      status: 'FAILED_BEFORE_PROVIDER',
      outcome: 'confirmed_failure_before_provider',
      reconciliationRequired: false,
    });
    expect(updateMany).toHaveBeenCalledWith({
      where: {
        organizationId,
        attemptId,
        status: 'NOT_STARTED',
        reconciliationRequired: true,
      },
      data: { status: 'FAILED_BEFORE_PROVIDER', reconciliationRequired: false },
    });
    expect(updateMany).toHaveBeenCalledTimes(1);
  });

  it('classifies an interrupted provider invocation as unknown and reconciliation-required', async () => {
    const { service, updateMany } = makeService('UNKNOWN', [0, 1]);

    const first = await service.reconcileAttempt(organizationId, attemptId);
    const second = await service.reconcileAttempt(organizationId, attemptId);

    expect(first).toEqual({
      status: 'UNKNOWN',
      outcome: 'unknown_provider_outcome',
      reconciliationRequired: true,
    });
    expect(second).toEqual(first);
    expect(updateMany).toHaveBeenCalledTimes(4);
  });

  it('claims provider invocation with a tenant- and attempt-scoped compare-and-set', async () => {
    const { service, updateMany } = makeService('INVOKING', [1]);

    await expect(service.beginProviderInvocation(organizationId, attemptId)).resolves.toBe(true);
    expect(updateMany).toHaveBeenCalledWith({
      where: {
        organizationId,
        attemptId,
        status: 'NOT_STARTED',
        reconciliationRequired: true,
      },
      data: { status: 'INVOKING', reconciliationRequired: true },
    });
  });

  it('lists only the requested organization’s required records with a bounded page size', async () => {
    const { service, findMany } = makeService('UNKNOWN', []);

    await expect(service.listRequired(organizationId, 20)).resolves.toEqual([]);
    expect(findMany).toHaveBeenCalledWith({
      where: { organizationId, reconciliationRequired: true },
      orderBy: [{ updatedAt: 'asc' }, { attemptId: 'asc' }],
      take: 20,
      select: { attemptId: true, status: true, reconciliationRequired: true },
    });
    await expect(service.listRequired(organizationId, 501)).rejects.toThrow(
      'call_initiation_reconciliation_invalid_limit',
    );
  });
});
