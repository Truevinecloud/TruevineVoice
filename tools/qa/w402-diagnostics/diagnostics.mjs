const JOB_STATES = [
  ['waiting', 'wait'],
  ['active', 'active'],
  ['completed', 'completed'],
  ['delayed', 'delayed'],
  ['failed', 'failed'],
];

const RECONCILIATION_STATES = [
  'NOT_STARTED',
  'INVOKING',
  'CONFIRMED',
  'FAILED_BEFORE_PROVIDER',
  'UNKNOWN',
];

const ERROR_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'EHOSTUNREACH',
  'ENOTFOUND',
  'NOAUTH',
  'WRONGPASS',
  'P1000',
  'P1001',
  'P2021',
  '42501',
]);

export function safeErrorCode(error) {
  const code = error?.code ?? error?.cause?.code;
  return typeof code === 'string' && ERROR_CODES.has(code) ? code : 'operation_failed';
}

function isCount(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

export function summarizeQueueCounts(counts) {
  const values = Object.fromEntries(
    JOB_STATES.map(([label, key]) => [label, isCount(counts?.[key]) ? counts[key] : null]),
  );
  return {
    status: Object.values(values).every((value) => value !== null) ? 'available' : 'partial',
    values,
  };
}

export function summarizeWorkers(workers) {
  if (!Array.isArray(workers)) {
    return { status: 'unavailable', registeredCount: null };
  }
  if (workers.some((worker) => worker?.name === 'GCP does not support client list')) {
    return { status: 'unsupported', registeredCount: null };
  }
  return { status: 'available', registeredCount: workers.length };
}

export function summarizeFailedJobs(jobs, limit) {
  if (!Array.isArray(jobs)) {
    return { status: 'unavailable', sampleLimit: limit, sampledCount: null };
  }

  const distribution = new Map();
  let retriedCount = 0;
  let exhaustedAttemptsCount = 0;
  let comparableAttemptsCount = 0;

  for (const job of jobs.slice(0, limit)) {
    const attemptsMade = job?.attemptsMade;
    if (isCount(attemptsMade)) {
      distribution.set(attemptsMade, (distribution.get(attemptsMade) ?? 0) + 1);
      if (attemptsMade > 1) retriedCount += 1;
    }

    const configuredAttempts = job?.opts?.attempts;
    if (isCount(attemptsMade) && Number.isSafeInteger(configuredAttempts) && configuredAttempts > 0) {
      comparableAttemptsCount += 1;
      if (attemptsMade >= configuredAttempts) exhaustedAttemptsCount += 1;
    }
  }

  return {
    status: 'available',
    sampleLimit: limit,
    sampledCount: Math.min(jobs.length, limit),
    sampledJobsWithRetries: retriedCount,
    sampledJobsAtConfiguredAttemptLimit:
      comparableAttemptsCount === 0 ? null : exhaustedAttemptsCount,
    attemptsMadeDistribution: [...distribution.entries()]
      .sort(([left], [right]) => left - right)
      .map(([attemptsMade, count]) => ({ attemptsMade, count })),
    rawJobDataAndFailureReasons: 'withheld',
  };
}

export function summarizeReconciliationRows(rows) {
  if (!Array.isArray(rows)) {
    return {
      status: 'unavailable',
      totalCount: null,
      requiredCount: null,
      byStatus: null,
    };
  }

  const byStatus = Object.fromEntries(
    RECONCILIATION_STATES.map((status) => [status, { total: 0, required: 0 }]),
  );

  for (const row of rows) {
    const entry = byStatus[row?.status];
    const count = row?._count?._all;
    if (!entry || !Number.isSafeInteger(count) || count < 0) {
      return {
        status: 'unavailable',
        totalCount: null,
        requiredCount: null,
        byStatus: null,
      };
    }
    entry.total += count;
    if (row.reconciliationRequired === true) entry.required += count;
  }

  const entries = Object.values(byStatus);
  return {
    status: 'available',
    totalCount: entries.reduce((sum, entry) => sum + entry.total, 0),
    requiredCount: entries.reduce((sum, entry) => sum + entry.required, 0),
    byStatus,
  };
}

function unavailableQueue(name, status) {
  return {
    name,
    counts: { status, values: { waiting: null, active: null, completed: null, delayed: null, failed: null } },
    workers: { status, registeredCount: null, readinessSignal: 'not_exposed' },
    failures: { status, sampleLimit: 20, sampledCount: null },
  };
}

function acceptanceGaps(report) {
  const gaps = [];
  if (report.queue.counts.status !== 'available') {
    gaps.push('BullMQ job-state counts are unavailable or incomplete.');
  }
  if (report.queue.workers.status !== 'available') {
    gaps.push('BullMQ worker registration could not be verified.');
  } else if (report.queue.workers.registeredCount === 0) {
    gaps.push('No BullMQ worker is registered for the configured queue.');
  }
  if (report.queue.workers.readinessSignal === 'not_exposed') {
    gaps.push('The worker process readiness signal is not externally exposed.');
  }
  if (report.queue.failures.status !== 'available') {
    gaps.push('Failed-job retry information is unavailable.');
  }
  if (report.reconciliation.status !== 'available') {
    gaps.push('Persisted reconciliation-required state counts are unavailable.');
  }
  if (report.technicalAdminApi.queueInventoryStatus !== 'integrated') {
    gaps.push(
      `Technical Admin queue inventory is ${report.technicalAdminApi.queueInventoryStatus}.`,
    );
  }
  gaps.push('Read-only queue data cannot prove one logical CallAttempt per idempotency identity.');
  gaps.push('Controlled worker termination and replacement require a BullMQ recovery integration test.');
  gaps.push('Queue data cannot prove exactly one fake-provider invocation.');
  return gaps;
}

async function attempt(action) {
  try {
    return { ok: true, value: await action() };
  } catch (error) {
    return { ok: false, code: safeErrorCode(error) };
  }
}

export async function collectDiagnostics({
  queueName,
  redis,
  redisUnavailableStatus = 'not_configured',
  createQueue,
  readReconciliation,
  inspectTechnicalApi,
  generatedAt = () => new Date(),
  failedJobSampleLimit = 20,
}) {
  const ping = redis
    ? await attempt(async () => {
        const startedAt = Date.now();
        const response = await redis.ping();
        if (response !== 'PONG') {
          throw Object.assign(new Error(), { code: 'UNEXPECTED_RESPONSE' });
        }
        return Date.now() - startedAt;
      })
    : { ok: false, code: redisUnavailableStatus };

  const redisReport = ping.ok
    ? { status: 'available', latencyMs: ping.value }
    : {
        status:
          !redis || redisUnavailableStatus === 'blocked_non_local'
            ? redisUnavailableStatus
            : 'unavailable',
        errorCode: ping.code,
      };

  let queueReport = unavailableQueue(
    queueName,
    ping.ok ? 'unavailable' : 'not_checked',
  );

  if (ping.ok && typeof createQueue === 'function') {
    const created = await attempt(createQueue);
    if (created.ok) {
      const queue = created.value;
      const [countsResult, workersResult] = await Promise.all([
        attempt(() => queue.getJobCounts('wait', 'active', 'completed', 'delayed', 'failed')),
        attempt(() => queue.getWorkers()),
      ]);

      const counts = countsResult.ok
        ? summarizeQueueCounts(countsResult.value)
        : { status: 'unavailable', values: { waiting: null, active: null, completed: null, delayed: null, failed: null } };
      const workers = workersResult.ok
        ? summarizeWorkers(workersResult.value)
        : { status: 'unavailable', registeredCount: null };

      let failures;
      if (!countsResult.ok || counts.values.failed === null) {
        failures = { status: 'not_checked', sampleLimit: failedJobSampleLimit, sampledCount: null };
      } else if (counts.values.failed === 0) {
        failures = summarizeFailedJobs([], failedJobSampleLimit);
      } else {
        const jobsResult = await attempt(() =>
          queue.getJobs(['failed'], 0, failedJobSampleLimit - 1, true),
        );
        failures = jobsResult.ok
          ? summarizeFailedJobs(jobsResult.value, failedJobSampleLimit)
          : { status: 'unavailable', sampleLimit: failedJobSampleLimit, sampledCount: null };
      }

      queueReport = {
        name: queueName,
        counts,
        workers: { ...workers, readinessSignal: 'not_exposed' },
        failures,
      };
    } else {
      queueReport = {
        ...unavailableQueue(queueName, 'unavailable'),
        errorCode: created.code,
      };
    }
  } else if (ping.ok) {
    queueReport = unavailableQueue(queueName, 'not_configured');
  }

  const [reconciliationResult, technicalApiResult] = await Promise.all([
    attempt(readReconciliation),
    attempt(inspectTechnicalApi),
  ]);
  const reconciliation = reconciliationResult.ok
    ? reconciliationResult.value
    : {
        status: 'unavailable',
        totalCount: null,
        requiredCount: null,
        byStatus: null,
        errorCode: reconciliationResult.code,
      };
  const technicalAdminApi = technicalApiResult.ok
    ? technicalApiResult.value
    : {
        status: 'unavailable',
        httpStatus: null,
        queueInventoryStatus: 'unavailable',
        errorCode: technicalApiResult.code,
      };

  const report = {
    tool: 'W4-02 Diagnostics',
    generatedAt: generatedAt().toISOString(),
    readOnly: true,
    redis: redisReport,
    queue: queueReport,
    reconciliation,
    technicalAdminApi,
    limitations: [
      'BullMQ worker registration is a Redis client-list signal, not the worker process readiness probe.',
      'Delayed jobs may be scheduled work or retries; this report does not classify them.',
      'Job identifiers, payloads, destinations, and raw failure reasons are withheld.',
      'Reconciliation counts are aggregated by organization and organization identifiers are withheld.',
    ],
  };

  report.acceptanceGaps = acceptanceGaps(report);
  return report;
}
