import { describe, expect, it, vi } from 'vitest';

import {
  collectDiagnostics,
  summarizeFailedJobs,
  summarizeQueueCounts,
  summarizeReconciliationRows,
} from './diagnostics.mjs';

function baseDependencies(overrides = {}) {
  const readOnlyQueue = {
    getJobCounts: vi.fn().mockResolvedValue({
      wait: 0,
      active: 2,
      completed: 8,
      delayed: 1,
      failed: 2,
    }),
    getWorkers: vi.fn().mockResolvedValue([{ name: 'redacted-worker' }]),
    getJobs: vi.fn().mockResolvedValue([
      {
        id: 'sensitive-job-id',
        data: { destination: '+256700000000', apiKey: 'secret' },
        failedReason: 'failed for +256700000000 with secret',
        attemptsMade: 2,
        opts: { attempts: 3 },
      },
    ]),
    add: vi.fn(),
    retryJobs: vi.fn(),
    remove: vi.fn(),
    promote: vi.fn(),
  };

  return {
    queueName: 'w402-diagnostics-test',
    redis: { ping: vi.fn().mockResolvedValue('PONG') },
    createQueue: vi.fn().mockReturnValue(readOnlyQueue),
    readReconciliation: vi.fn().mockResolvedValue(
      summarizeReconciliationRows([
        {
          organizationId: 'private-organization-id',
          status: 'UNKNOWN',
          reconciliationRequired: true,
          _count: { _all: 1 },
        },
        {
          organizationId: 'private-organization-id',
          status: 'CONFIRMED',
          reconciliationRequired: false,
          _count: { _all: 2 },
        },
      ]),
    ),
    inspectTechnicalApi: vi.fn().mockResolvedValue({
      status: 'available',
      httpStatus: 200,
      queueInventoryStatus: 'not_integrated',
    }),
    generatedAt: () => new Date('2026-11-23T00:00:00.000Z'),
    readOnlyQueue,
    ...overrides,
  };
}

describe('W4-02 diagnostics report', () => {
  it('reports observed queue counts and worker registration without exposing job data', async () => {
    const dependencies = baseDependencies();
    const report = await collectDiagnostics(dependencies);
    const json = JSON.stringify(report);

    expect(report.queue.counts).toEqual({
      status: 'available',
      values: { waiting: 0, active: 2, completed: 8, delayed: 1, failed: 2 },
    });
    expect(report.queue.workers).toMatchObject({
      status: 'available',
      registeredCount: 1,
      readinessSignal: 'not_exposed',
    });
    expect(report.queue.failures).toMatchObject({
      status: 'available',
      sampledCount: 1,
      sampledJobsWithRetries: 1,
    });
    expect(report.reconciliation.requiredCount).toBe(1);
    expect(report.technicalAdminApi.queueInventoryStatus).toBe('not_integrated');
    expect(report.acceptanceGaps.join(' ')).toContain('worker process readiness');
    expect(json).not.toContain('sensitive-job-id');
    expect(json).not.toContain('+256700000000');
    expect(json).not.toContain('secret');
    expect(json).not.toContain('private-organization-id');
    for (const method of ['add', 'retryJobs', 'remove', 'promote']) {
      expect(dependencies.readOnlyQueue[method]).not.toHaveBeenCalled();
    }
  });

  it('marks unavailable queue data null rather than reporting false zeroes', async () => {
    const dependencies = baseDependencies({
      redis: { ping: vi.fn().mockRejectedValue(Object.assign(new Error(), { code: 'ECONNREFUSED' })) },
    });
    const report = await collectDiagnostics(dependencies);

    expect(report.redis).toMatchObject({ status: 'unavailable', errorCode: 'ECONNREFUSED' });
    expect(report.queue.counts).toEqual({
      status: 'not_checked',
      values: { waiting: null, active: null, completed: null, delayed: null, failed: null },
    });
    expect(report.queue.workers.registeredCount).toBeNull();
    expect(dependencies.createQueue).not.toHaveBeenCalled();
  });

  it('distinguishes an empty failed-job sample from unavailable failed-job data', async () => {
    expect(summarizeFailedJobs([], 20)).toMatchObject({
      status: 'available',
      sampledCount: 0,
      sampledJobsWithRetries: 0,
    });
    expect(summarizeFailedJobs(null, 20)).toMatchObject({
      status: 'unavailable',
      sampledCount: null,
    });
  });

  it('aggregates reconciliation counts without returning organization identifiers', () => {
    const summary = summarizeReconciliationRows([
      {
        organizationId: 'organization-a',
        status: 'UNKNOWN',
        reconciliationRequired: true,
        _count: { _all: 2 },
      },
      {
        organizationId: 'organization-b',
        status: 'UNKNOWN',
        reconciliationRequired: true,
        _count: { _all: 1 },
      },
      {
        organizationId: 'organization-b',
        status: 'CONFIRMED',
        reconciliationRequired: false,
        _count: { _all: 4 },
      },
    ]);

    expect(summary.requiredCount).toBe(3);
    expect(summary.totalCount).toBe(7);
    expect(JSON.stringify(summary)).not.toContain('organization-a');
    expect(JSON.stringify(summary)).not.toContain('organization-b');
  });

  it('distinguishes an observed zero count from a missing BullMQ count', () => {
    expect(summarizeQueueCounts({ wait: 0, active: 0, completed: 0, delayed: 0, failed: 0 })).toEqual({
      status: 'available',
      values: { waiting: 0, active: 0, completed: 0, delayed: 0, failed: 0 },
    });
    expect(summarizeQueueCounts({ wait: 0, active: 0, completed: 0, delayed: 0 })).toEqual({
      status: 'partial',
      values: { waiting: 0, active: 0, completed: 0, delayed: 0, failed: null },
    });
  });
});
