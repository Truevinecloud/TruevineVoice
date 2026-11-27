/**
 * W6-01 isolated acceptance.
 *
 * This suite proves the paid-provider boundary, not merely campaign status.
 * Every paid-work scenario asserts the synthetic adapter's invocation ledger.
 * It is gated by the W6-01 database/Redis allowlist and never uses the W5-03E
 * or W402 environments.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

import { lockCampaignDispatch, type PrismaClient } from '@truevine/database';
import type { Queue } from 'bullmq';
import type { CallSql } from '@truevine/telephony';
import {
  createBullConnectionOptions,
  createCampaignExecutionQueue,
  createRedisClient,
  type Redis,
} from '@truevine/queue';
import {
  CALLBACK_SOURCES,
  CALL_OPERATION_TYPES,
  CallbackReceipts,
  canonicalCampaignCallInitiation,
} from '@truevine/telephony';

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { loadWorkerConfig } from '../src/config/worker.config.js';
import { CampaignExecutionClaimService } from '../src/campaigns/campaign-execution-claim.service.js';
import { UsageSettlement } from '../src/usage-settlement/usage-settlement.js';
import {
  addW601Campaign,
  createW601Fixtures,
  setCampaignDispatch,
  W601_RESERVE_MINOR,
  type W601FixtureGraph,
} from './helpers/w601-fixtures.js';
import { createW601TestDatabaseClient } from './helpers/w601-test-database.js';

const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const CHILD_SCRIPT = fileURLToPath(new URL('./w601-dispatch-child.mjs', import.meta.url));
type CrashCheckpoint =
  | 'before-claim-commit'
  | 'after-claim-commit'
  | 'before-provider-invocation'
  | 'after-provider-invocation-before-operation-persistence'
  | 'after-operation-commit';
type FaultMode = '' | 'db-before-provider' | 'db-after-provider';
type ChildMessage =
  | { readonly type: 'ready'; readonly pid: number; readonly queueName: string }
  | {
      readonly type: 'checkpoint';
      readonly pid: number;
      readonly checkpoint: string;
      readonly gated?: boolean;
    };
type ChildExit = {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly error?: Error;
};
type InvocationEvidence = {
  readonly organizationId: string;
  readonly attemptId: string;
  readonly idempotencyKey: string;
  readonly providerCallId: string;
  readonly pid: number;
};
type ChildRun = {
  readonly child: ChildProcess;
  readonly ready: Promise<ChildMessage>;
  readonly checkpoint: Promise<ChildMessage>;
  readonly exit: Promise<ChildExit>;
  readonly output: () => { stdout: string; stderr: string };
  readonly stdoutInvocations: () => InvocationEvidence[];
};
type PersistedState = {
  readonly attempts: Array<{
    readonly id: string;
    readonly recipientId: string;
    readonly state: string;
    readonly attemptNumber: number;
  }>;
  readonly operations: Array<{
    readonly operation: string;
    readonly key: string;
    readonly attemptId: string;
    readonly result: unknown;
  }>;
  readonly callbackBindingCount: number;
  readonly reconciliations: Array<{
    readonly attemptId: string;
    readonly status: string;
    readonly reconciliationRequired: boolean;
  }>;
  readonly reservations: Array<{
    readonly attemptId: string;
    readonly state: string;
    readonly amountMinor: string;
  }>;
  readonly invocations: InvocationEvidence[];
};
type Scenario = {
  readonly queueName: string;
  readonly runId: string;
  readonly invocationKey: string;
  readonly gateKey: string;
  readonly startsKey: string;
  readonly activeKey: string;
  readonly maximumActiveKey: string;
  readonly failuresKey: string;
  readonly keys: string[];
  readonly queue: Queue<{
    organizationId: string;
    campaignId: string;
    dispatchEpoch?: number;
  }>;
  readonly environment: NodeJS.ProcessEnv;
  readonly children: Set<ChildRun>;
};
type WorkerOverrides = {
  readonly concurrency?: number;
  readonly failFirst?: number;
  readonly maxAttempts?: number;
  readonly delayMs?: number;
  readonly faultMode?: FaultMode;
  readonly redisFailure?: boolean;
};

let prisma: PrismaClient;
let redis: Redis;
let databaseUrl: string;
let redisUrl: string;
const scenarios: Scenario[] = [];

function assertEnvironment(): void {
  if (process.env['NODE_ENV'] !== 'test') {
    throw new Error('W6-01 dispatch tests require NODE_ENV=test.');
  }
  databaseUrl = process.env['DATABASE_URL'] ?? '';
  redisUrl = process.env['REDIS_URL'] ?? '';
  if (!databaseUrl || !redisUrl) {
    throw new Error('W6-01 dispatch tests require DATABASE_URL and REDIS_URL.');
  }

  const database = new URL(databaseUrl);
  if (
    !['postgres:', 'postgresql:'].includes(database.protocol) ||
    !['localhost', '127.0.0.1', '::1', '[::1]'].includes(database.hostname) ||
    database.port !== '55434' ||
    database.pathname !== '/truevine_w601_qa' ||
    ['host', 'hostaddr', 'port', 'database', 'dbname'].some((key) => database.searchParams.has(key))
  ) {
    throw new Error('W6-01 tests refuse every database except local truevine_w601_qa.');
  }

  const redisTarget = new URL(redisUrl);
  if (
    redisTarget.protocol !== 'redis:' ||
    !['localhost', '127.0.0.1', '::1', '[::1]'].includes(redisTarget.hostname) ||
    redisTarget.port !== '56382'
  ) {
    throw new Error('W6-01 tests require local Redis on port 56382.');
  }
  if (!existsSync(CHILD_SCRIPT)) throw new Error('W6-01 child process script is missing.');
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: Error) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function parseInvocation(line: string, prefix: string): InvocationEvidence {
  const value = JSON.parse(line.slice(prefix.length)) as Partial<InvocationEvidence>;
  if (
    typeof value.organizationId !== 'string' ||
    typeof value.attemptId !== 'string' ||
    typeof value.idempotencyKey !== 'string' ||
    typeof value.providerCallId !== 'string' ||
    typeof value.pid !== 'number'
  ) {
    throw new Error('Malformed W6-01 invocation evidence.');
  }
  return value as InvocationEvidence;
}

function startChild(
  environment: NodeJS.ProcessEnv,
  scenario: Scenario,
  options: { crashCheckpoint?: CrashCheckpoint | ''; gateCheckpoint?: CrashCheckpoint | '' } = {},
): ChildRun {
  let stdout = '';
  let stderr = '';
  let bufferedLine = '';
  const ready = deferred<ChildMessage>();
  const checkpoint = deferred<ChildMessage>();
  const exit = deferred<ChildExit>();
  const child = spawn(process.execPath, [CHILD_SCRIPT], {
    cwd: REPO_ROOT,
    env: {
      ...environment,
      W601_CRASH_CHECKPOINT: options.crashCheckpoint ?? '',
      W601_GATE_CHECKPOINT: options.gateCheckpoint ?? '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const run: ChildRun = {
    child,
    ready: ready.promise,
    checkpoint: checkpoint.promise,
    exit: exit.promise,
    output: () => ({ stdout, stderr }),
    stdoutInvocations: () =>
      stdout
        .split(/\r?\n/)
        .filter((line) => line.startsWith('W601_INVOCATION '))
        .map((line) => parseInvocation(line, 'W601_INVOCATION ')),
  };
  scenario.children.add(run);

  const consumeLine = (line: string) => {
    try {
      if (line.startsWith('W601_READY ')) {
        const message = JSON.parse(line.slice('W601_READY '.length)) as {
          pid?: unknown;
          queueName?: unknown;
        };
        if (typeof message.pid === 'number' && typeof message.queueName === 'string') {
          ready.resolve({ type: 'ready', pid: message.pid, queueName: message.queueName });
        } else {
          ready.reject(new Error('Malformed W6-01 worker readiness message.'));
        }
      } else if (line.startsWith('W601_CHECKPOINT ')) {
        const message = JSON.parse(line.slice('W601_CHECKPOINT '.length)) as {
          checkpoint?: unknown;
          pid?: unknown;
          gated?: unknown;
        };
        if (typeof message.pid === 'number' && typeof message.checkpoint === 'string') {
          checkpoint.resolve({
            type: 'checkpoint',
            pid: message.pid,
            checkpoint: message.checkpoint,
            gated: message.gated === true,
          });
        } else {
          checkpoint.reject(new Error('Malformed W6-01 checkpoint message.'));
        }
      }
    } catch (error) {
      const description = error instanceof Error ? error.message : String(error);
      ready.reject(new Error(description));
      checkpoint.reject(new Error(description));
    }
  };

  child.stdout?.setEncoding('utf8');
  child.stderr?.setEncoding('utf8');
  child.stdout?.on('data', (chunk: string) => {
    stdout += chunk;
    bufferedLine += chunk;
    const lines = bufferedLine.split(/\r?\n/);
    bufferedLine = lines.pop() ?? '';
    lines.forEach(consumeLine);
  });
  child.stderr?.on('data', (chunk: string) => {
    stderr += chunk;
  });
  child.once('error', (error) => exit.resolve({ code: null, signal: null, error }));
  child.once('close', (code, signal) => {
    scenario.children.delete(run);
    exit.resolve({ code, signal });
  });
  return run;
}

async function within<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms.`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

async function waitForChildMessage(
  message: Promise<ChildMessage>,
  run: ChildRun,
  label: string,
  timeoutMs = 30_000,
): Promise<ChildMessage> {
  try {
    return await within(
      Promise.race([
        message,
        run.exit.then((result) => {
          const output = run.output();
          throw new Error(
            `${label}: child exited early (code=${result.code}, signal=${result.signal}). ` +
              `stdout=${output.stdout} stderr=${output.stderr}`,
          );
        }),
      ]),
      timeoutMs,
      label,
    );
  } catch (error) {
    if (error instanceof Error && error.message.includes('timed out')) {
      const output = run.output();
      throw new Error(
        `${error.message} Worker PID ${run.child.pid} state ` +
          `(code=${run.child.exitCode}, signal=${run.child.signalCode}). ` +
          `stdout=${output.stdout} stderr=${output.stderr}`,
        { cause: error },
      );
    }
    throw error;
  }
}

async function waitForExit(run: ChildRun, label: string): Promise<ChildExit> {
  return within(run.exit, 10_000, `${label} exit`);
}

async function killChild(run: ChildRun): Promise<ChildExit> {
  if (run.child.exitCode === null && run.child.signalCode === null && !run.child.kill('SIGKILL')) {
    throw new Error(`Could not terminate worker PID ${run.child.pid}.`);
  }
  const result = await waitForExit(run, `terminated worker PID ${run.child.pid}`);
  if (result.code === 0 && result.signal === null) {
    throw new Error(`Worker PID ${run.child.pid} exited successfully instead of being terminated.`);
  }
  return result;
}

async function stopChild(run: ChildRun): Promise<ChildExit> {
  if (run.child.exitCode === null && run.child.signalCode === null && !run.child.kill('SIGKILL')) {
    throw new Error(`Could not terminate worker PID ${run.child.pid}.`);
  }
  return waitForExit(run, `terminated worker PID ${run.child.pid}`);
}

async function createScenario(overrides: WorkerOverrides = {}): Promise<Scenario> {
  const runId = randomUUID();
  const queueName = `w601-${runId}`;
  const keyPrefix = `w601:bullmq:${runId}`;
  const invocationKey = `${keyPrefix}:invocations`;
  const gateKey = `${keyPrefix}:gate`;
  const startsKey = `${keyPrefix}:starts`;
  const activeKey = `${keyPrefix}:active`;
  const maximumActiveKey = `${keyPrefix}:maximum-active`;
  const failuresKey = `${keyPrefix}:failures`;
  const keys = [invocationKey, gateKey, startsKey, activeKey, maximumActiveKey, failuresKey];
  await redis.del(...keys);

  const maxAttempts = overrides.maxAttempts ?? 3;
  const environment: NodeJS.ProcessEnv = {
    ...process.env,
    NODE_ENV: 'test',
    DATABASE_URL: databaseUrl,
    REDIS_URL: overrides.redisFailure ? 'redis://localhost:56383/0' : redisUrl,
    CAMPAIGN_EXECUTION_MODE: 'w601-test',
    CAMPAIGN_EXECUTION_QUEUE_NAME: queueName,
    W601_RUN_ID: runId,
    W601_INVOCATION_KEY: invocationKey,
    W601_GATE_KEY: gateKey,
    W601_STARTS_KEY: startsKey,
    W601_ACTIVE_KEY: activeKey,
    W601_MAX_ACTIVE_KEY: maximumActiveKey,
    W601_FAILURES_KEY: failuresKey,
    W601_FAULT_MODE: overrides.faultMode ?? '',
    W601_REDIS_FAILURE: overrides.redisFailure ? '1' : '0',
    W601_FAIL_FIRST_N: String(overrides.failFirst ?? 0),
    W601_PROCESS_DELAY_MS: String(overrides.delayMs ?? 0),
    WORKER_CONCURRENCY: String(overrides.concurrency ?? 4),
    WORKER_MAX_RETRY_ATTEMPTS: String(maxAttempts),
    WORKER_RETRY_BACKOFF_MS: '1000',
  };
  const config = loadWorkerConfig(environment);
  const queue = createCampaignExecutionQueue(createBullConnectionOptions(redisUrl), {
    queueName,
    maxAttempts,
    retryBackoffMs: config.retryBackoffMs,
  });
  const scenario: Scenario = {
    queueName,
    runId,
    invocationKey,
    gateKey,
    startsKey,
    activeKey,
    maximumActiveKey,
    failuresKey,
    keys,
    queue,
    environment,
    children: new Set(),
  };
  scenarios.push(scenario);
  return scenario;
}

async function disposeScenario(scenario: Scenario): Promise<void> {
  for (const run of [...scenario.children]) {
    if (run.child.exitCode === null && run.child.signalCode === null) {
      try {
        await stopChild(run);
      } catch {
        await killChild(run);
      }
    }
  }
  await scenario.queue.obliterate({ force: true });
  await scenario.queue.close();
  await redis.del(...scenario.keys);
}

function startWorker(
  scenario: Scenario,
  options: { crashCheckpoint?: CrashCheckpoint | ''; gateCheckpoint?: CrashCheckpoint | '' } = {},
): ChildRun {
  return startChild(scenario.environment, scenario, options);
}

async function startReadyWorker(scenario: Scenario): Promise<ChildRun> {
  const worker = startWorker(scenario);
  const ready = await waitForChildMessage(worker.ready, worker, 'W6-01 worker readiness');
  expect(ready).toMatchObject({ type: 'ready', pid: worker.child.pid, queueName: scenario.queueName });
  return worker;
}

async function enqueueJob(
  scenario: Scenario,
  graph: W601FixtureGraph,
  options: { dispatchEpoch?: number; delay?: number } = {},
): Promise<{
  id: string;
  getState: () => Promise<string>;
  getReturnValue: () => Promise<unknown>;
  retry: () => Promise<void>;
}> {
  const id = `w601-${randomUUID()}`;
  const job = await scenario.queue.add(
    'execute',
    {
      organizationId: graph.organizationId,
      campaignId: graph.campaignId,
      ...(typeof options.dispatchEpoch === 'number'
        ? { dispatchEpoch: options.dispatchEpoch }
        : {}),
    },
    { jobId: id, delay: options.delay ?? 0 },
  );
  return {
    id,
    getState: () => job.getState(),
    getReturnValue: async () => {
      const current = await scenario.queue.getJob(id);
      return current?.returnvalue;
    },
    retry: async () => {
      const current = await scenario.queue.getJob(id);
      if (!current) throw new Error(`BullMQ job ${id} disappeared before retry.`);
      await current.retry();
    },
  };
}

function hasCompletedResult(value: unknown): value is { readonly status: string } {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { readonly status?: unknown }).status === 'string'
  );
}

async function waitForJobState(
  scenario: Scenario,
  jobId: string,
  expectedState: 'completed' | 'failed' | 'waiting' | 'delayed',
  timeoutMs = 20_000,
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const job = await scenario.queue.getJob(jobId);
    if (job) {
      const state = await job.getState();
      // BullMQ can briefly expose `completed` before the processor result is
      // visible. Wait for a real result object so tests never assert on null.
      if (
        state === expectedState &&
        (expectedState !== 'completed' || hasCompletedResult(job.returnvalue))
      ) {
        return job;
      }
    }
    await sleep(50);
  }
  const job = await scenario.queue.getJob(jobId);
  const state = job ? await job.getState() : 'missing';
  throw new Error(`BullMQ job ${jobId} stayed in ${state}; expected ${expectedState}.`);
}

async function readCampaign(graph: W601FixtureGraph) {
  const campaign = await prisma.campaign.findUnique({
    where: {
      organizationId_id: { organizationId: graph.organizationId, id: graph.campaignId },
    },
    select: {
      status: true,
      dispatchState: true,
      dispatchEpoch: true,
      dispatchStopReason: true,
      emergencyStoppedAt: true,
    },
  });
  if (!campaign) throw new Error('W6-01 campaign fixture is missing.');
  return campaign;
}

async function readPersistedState(
  graph: W601FixtureGraph,
  invocationKey: string,
): Promise<PersistedState> {
  const attempts = await prisma.callAttempt.findMany({
    where: {
      organizationId: graph.organizationId,
      campaignId: graph.campaignId,
      executionId: graph.executionId,
    },
    orderBy: [{ recipientId: 'asc' }, { attemptNumber: 'asc' }],
    select: { id: true, recipientId: true, state: true, attemptNumber: true },
  });
  const attemptIds = attempts.map((attempt) => attempt.id);
  const [operations, bindings, reconciliations, reservations, rawInvocations] = await Promise.all([
    prisma.callOperation.findMany({
      where: {
        organizationId: graph.organizationId,
        operation: CALL_OPERATION_TYPES.campaignCallInitiation,
        attemptId: { in: attemptIds },
      },
      select: { operation: true, key: true, attemptId: true, result: true },
    }),
    prisma.voiceCallbackBinding.findMany({
      where: { organizationId: graph.organizationId, attemptId: { in: attemptIds } },
      select: { attemptId: true },
    }),
    prisma.callInitiationReconciliation.findMany({
      where: { organizationId: graph.organizationId, attemptId: { in: attemptIds } },
      select: { attemptId: true, status: true, reconciliationRequired: true },
    }),
    prisma.campaignDispatchReservation.findMany({
      where: { organizationId: graph.organizationId, attemptId: { in: attemptIds } },
      select: { attemptId: true, state: true, amountMinor: true },
    }),
    redis.lrange(invocationKey, 0, -1),
  ]);
  return {
    attempts,
    operations,
    callbackBindingCount: bindings.length,
    reconciliations,
    reservations: reservations.map((row) => ({
      attemptId: row.attemptId,
      state: row.state,
      amountMinor: row.amountMinor.toString(),
    })),
    invocations: rawInvocations
      .map((entry) => JSON.parse(entry) as InvocationEvidence)
      .filter((entry) => attemptIds.includes(entry.attemptId)),
  };
}

function evidence(name: string, payload: unknown): void {
  process.stdout.write(`W601_EVIDENCE ${JSON.stringify({ scenario: name, ...(payload as object) })}\n`);
}

function jobOutcome(result: unknown) {
  return result as {
    status: string;
    recipientCount?: number;
    outcomes?: Array<{
      recipientId: string;
      result: {
        status: string;
        reason?: string;
        replayed?: boolean;
      };
    }>;
  };
}

describe('W6-01 campaign dispatch reliability on isolated PostgreSQL and Redis', () => {
  beforeAll(async () => {
    assertEnvironment();
    prisma = await createW601TestDatabaseClient();
    redis = createRedisClient(redisUrl);
    await redis.ping();
  }, 30_000);

  afterEach(async () => {
    for (const scenario of scenarios.splice(0)) await disposeScenario(scenario);
  }, 30_000);

  afterAll(async () => {
    try {
      for (const scenario of scenarios.splice(0)) await disposeScenario(scenario);
    } finally {
      if (typeof redis !== 'undefined') redis.disconnect();
      if (typeof prisma !== 'undefined') await prisma.$disconnect();
    }
  }, 30_000);

  it('starts no paid work while the campaign is paused', async () => {
    const graph = await createW601Fixtures(prisma, { balanceMinor: 10_000n });
    await setCampaignDispatch(prisma, graph, {
      dispatchState: 'PAUSED',
      dispatchStopReason: 'customer_pause',
    });
    const scenario = await createScenario();
    const worker = await startReadyWorker(scenario);
    const job = await enqueueJob(scenario, graph);
    const completed = await waitForJobState(scenario, job.id, 'completed');
    const state = await readPersistedState(graph, scenario.invocationKey);

    expect(jobOutcome(completed.returnvalue).status).toBe('paused');
    expect(state.invocations).toHaveLength(0);
    expect(state.attempts).toHaveLength(0);
    expect(state.operations).toHaveLength(0);
    expect(state.reservations).toHaveLength(0);
    expect(await readCampaign(graph)).toMatchObject({
      dispatchState: 'PAUSED',
      dispatchStopReason: 'customer_pause',
    });
    evidence('paused', {
      queueName: scenario.queueName,
      status: jobOutcome(completed.returnvalue).status,
      fakeProviderInvocations: state.invocations.length,
    });
    await stopChild(worker);
  });

  it('starts no paid work after cancellation', async () => {
    const graph = await createW601Fixtures(prisma, { balanceMinor: 10_000n });
    await setCampaignDispatch(prisma, graph, {
      dispatchState: 'CANCELLED',
      dispatchStopReason: 'customer_cancel',
    });
    const scenario = await createScenario();
    const worker = await startReadyWorker(scenario);
    const job = await enqueueJob(scenario, graph);
    const completed = await waitForJobState(scenario, job.id, 'completed');
    const state = await readPersistedState(graph, scenario.invocationKey);

    expect(jobOutcome(completed.returnvalue).status).toBe('cancelled');
    expect(state.invocations).toHaveLength(0);
    expect(state.attempts).toHaveLength(0);
    expect(state.operations).toHaveLength(0);
    evidence('cancelled', {
      queueName: scenario.queueName,
      status: jobOutcome(completed.returnvalue).status,
      fakeProviderInvocations: state.invocations.length,
    });
    await stopChild(worker);
  });

  it('starts no paid work after an emergency stop marker', async () => {
    const graph = await createW601Fixtures(prisma, { balanceMinor: 10_000n });
    await setCampaignDispatch(prisma, graph, {
      dispatchState: 'CANCELLED',
      dispatchStopReason: 'emergency_stop',
      emergencyStoppedAt: new Date(),
    });
    const scenario = await createScenario();
    const worker = await startReadyWorker(scenario);
    const job = await enqueueJob(scenario, graph);
    const completed = await waitForJobState(scenario, job.id, 'completed');
    const state = await readPersistedState(graph, scenario.invocationKey);

    expect(jobOutcome(completed.returnvalue).status).toBe('cancelled');
    expect(state.invocations).toHaveLength(0);
    expect(state.attempts).toHaveLength(0);
    expect(await readCampaign(graph)).toMatchObject({
      dispatchState: 'CANCELLED',
      dispatchStopReason: 'emergency_stop',
    });
    evidence('emergency-stop', {
      queueName: scenario.queueName,
      status: jobOutcome(completed.returnvalue).status,
      fakeProviderInvocations: state.invocations.length,
    });
    await stopChild(worker);
  });

  it('blocks on insufficient balance, pauses the campaign and starts no paid work', async () => {
    const graph = await createW601Fixtures(prisma, { balanceMinor: W601_RESERVE_MINOR - 500n });
    const scenario = await createScenario();
    const worker = await startReadyWorker(scenario);
    const job = await enqueueJob(scenario, graph);
    const completed = await waitForJobState(scenario, job.id, 'completed');
    const state = await readPersistedState(graph, scenario.invocationKey);
    const outcome = jobOutcome(completed.returnvalue).outcomes?.[0]?.result;

    expect(outcome).toMatchObject({ status: 'blocked', reason: 'insufficient_balance' });
    expect(state.invocations).toHaveLength(0);
    expect(state.reservations).toHaveLength(0);
    expect(await readCampaign(graph)).toMatchObject({
      dispatchState: 'PAUSED',
      dispatchStopReason: 'insufficient_balance',
    });
    evidence('insufficient-balance', {
      queueName: scenario.queueName,
      blockReason: outcome?.reason,
      campaign: await readCampaign(graph),
      fakeProviderInvocations: state.invocations.length,
    });
    await stopChild(worker);
  });

  it('permits only one paid call when concurrent recipients share one wallet', async () => {
    const graph = await createW601Fixtures(prisma, {
      balanceMinor: W601_RESERVE_MINOR + 500n,
    });
    const second = await addW601Campaign(prisma, graph, '+12025550124');
    const scenario = await createScenario({ concurrency: 2 });
    const worker = await startReadyWorker(scenario);
    const [firstJob, secondJob] = await Promise.all([
      enqueueJob(scenario, graph),
      enqueueJob(scenario, second),
    ]);
    const [firstCompleted, secondCompleted] = await Promise.all([
      waitForJobState(scenario, firstJob.id, 'completed'),
      waitForJobState(scenario, secondJob.id, 'completed'),
    ]);
    const [firstState, secondState] = await Promise.all([
      readPersistedState(graph, scenario.invocationKey),
      readPersistedState(second, scenario.invocationKey),
    ]);
    const totalInvocations = firstState.invocations.length + secondState.invocations.length;
    const outcomes = [
      ...(jobOutcome(firstCompleted.returnvalue).outcomes ?? []),
      ...(jobOutcome(secondCompleted.returnvalue).outcomes ?? []),
    ].map((entry) => entry.result);

    expect(totalInvocations).toBe(1);
    expect(outcomes.filter((result) => result.status === 'initiated')).toHaveLength(1);
    expect(outcomes.filter((result) => result.reason === 'insufficient_balance')).toHaveLength(1);
    expect(firstState.reservations.length + secondState.reservations.length).toBe(1);
    evidence('concurrent-overspend', {
      queueName: scenario.queueName,
      walletMinor: (W601_RESERVE_MINOR + 500n).toString(),
      reserveMinor: W601_RESERVE_MINOR.toString(),
      fakeProviderInvocations: totalInvocations,
      outcomes,
    });
    await stopChild(worker);
  });

  it('refuses a delayed job whose dispatch epoch was replaced before delivery', async () => {
    const graph = await createW601Fixtures(prisma, { balanceMinor: 10_000n });
    const scenario = await createScenario();
    const worker = await startReadyWorker(scenario);
    const staleJob = await enqueueJob(scenario, graph, { dispatchEpoch: 1, delay: 1_000 });
    expect(await waitForJobState(scenario, staleJob.id, 'delayed')).toBeTruthy();

    await setCampaignDispatch(prisma, graph, { dispatchState: 'PAUSED' });
    await setCampaignDispatch(prisma, graph, { dispatchState: 'RUNNING' });
    const staleCompleted = await waitForJobState(scenario, staleJob.id, 'completed', 20_000);
    const staleState = await readPersistedState(graph, scenario.invocationKey);
    expect(jobOutcome(staleCompleted.returnvalue).status).toBe('stale_epoch');
    expect(staleState.invocations).toHaveLength(0);

    const freshCampaign = await readCampaign(graph);
    const freshJob = await enqueueJob(scenario, graph, {
      dispatchEpoch: freshCampaign.dispatchEpoch,
    });
    const freshCompleted = await waitForJobState(scenario, freshJob.id, 'completed');
    const freshState = await readPersistedState(graph, scenario.invocationKey);
    expect(jobOutcome(freshCompleted.returnvalue).status).toBe('processed');
    expect(freshState.invocations).toHaveLength(1);

    evidence('delayed-stale-job', {
      queueName: scenario.queueName,
      staleStatus: jobOutcome(staleCompleted.returnvalue).status,
      freshStatus: jobOutcome(freshCompleted.returnvalue).status,
      fakeProviderInvocations: freshState.invocations.length,
    });
    await stopChild(worker);
  });

  it('uses BullMQ retries without invoking the provider more than once', async () => {
    const graph = await createW601Fixtures(prisma, { balanceMinor: 10_000n });
    const scenario = await createScenario({ failFirst: 2 });
    const worker = await startReadyWorker(scenario);
    const job = await enqueueJob(scenario, graph);
    const completed = await waitForJobState(scenario, job.id, 'completed', 20_000);
    const starts = (await redis.lrange(scenario.startsKey, 0, -1)).map(
      (entry) => JSON.parse(entry) as { at: number; pid: number },
    );
    const state = await readPersistedState(graph, scenario.invocationKey);

    expect(starts).toHaveLength(3);
    expect(completed.attemptsMade).toBe(3);
    expect(state.invocations).toHaveLength(1);
    expect(state.operations).toHaveLength(1);
    evidence('retry-jobs', {
      queueName: scenario.queueName,
      attemptsMade: completed.attemptsMade,
      fakeProviderInvocations: state.invocations.length,
    });
    await stopChild(worker);
  });

  it('replays an idempotent initiation after a worker restart without a second provider call', async () => {
    const graph = await createW601Fixtures(prisma, { balanceMinor: 10_000n });
    const scenario = await createScenario();
    const workerA = startWorker(scenario, { crashCheckpoint: 'after-operation-commit' });
    await waitForChildMessage(workerA.ready, workerA, 'worker A readiness');
    const job = await enqueueJob(scenario, graph);
    const marker = await waitForChildMessage(
      workerA.checkpoint,
      workerA,
      'after-operation-commit checkpoint',
    );
    expect(marker).toMatchObject({ checkpoint: 'after-operation-commit' });
    expect(await job.getState()).toBe('active');
    await killChild(workerA);

    const workerB = await startReadyWorker(scenario);
    const completed = await waitForJobState(scenario, job.id, 'completed');
    const state = await readPersistedState(graph, scenario.invocationKey);
    expect(state.invocations).toHaveLength(1);
    expect(state.operations).toHaveLength(1);
    expect(jobOutcome(completed.returnvalue).outcomes?.[0]?.result).toMatchObject({
      status: 'initiated',
      replayed: true,
    });
    evidence('worker-restart', {
      queueName: scenario.queueName,
      fakeProviderInvocations: state.invocations.length,
      replayed: true,
    });
    await stopChild(workerB);
  });

  it('does not resume twice and refuses an old epoch job after a real resume', async () => {
    const graph = await createW601Fixtures(prisma, { balanceMinor: 10_000n });
    const scenario = await createScenario();
    const worker = await startReadyWorker(scenario);
    const firstJob = await enqueueJob(scenario, graph, { dispatchEpoch: 1 });
    await waitForJobState(scenario, firstJob.id, 'completed');
    const beforeResume = await readCampaign(graph);

    await setCampaignDispatch(prisma, graph, { dispatchState: 'PAUSED' });
    await setCampaignDispatch(prisma, graph, { dispatchState: 'RUNNING' });
    const afterResume = await readCampaign(graph);
    expect(afterResume.dispatchEpoch).toBeGreaterThan(beforeResume.dispatchEpoch + 1);

    const staleJob = await enqueueJob(scenario, graph, { dispatchEpoch: beforeResume.dispatchEpoch });
    const staleCompleted = await waitForJobState(scenario, staleJob.id, 'completed');
    expect(jobOutcome(staleCompleted.returnvalue).status).toBe('stale_epoch');

    const replayJob = await enqueueJob(scenario, graph, {
      dispatchEpoch: afterResume.dispatchEpoch,
    });
    const replayCompleted = await waitForJobState(scenario, replayJob.id, 'completed');
    const state = await readPersistedState(graph, scenario.invocationKey);
    expect(jobOutcome(replayCompleted.returnvalue).status).toBe('processed');
    expect(jobOutcome(replayCompleted.returnvalue).outcomes?.[0]?.result).toMatchObject({
      status: 'initiated',
      replayed: true,
    });
    expect(state.invocations).toHaveLength(1);

    evidence('no-duplicate-resume', {
      queueName: scenario.queueName,
      epochBeforePause: beforeResume.dispatchEpoch,
      epochAfterResume: afterResume.dispatchEpoch,
      fakeProviderInvocations: state.invocations.length,
    });
    await stopChild(worker);
  });

  it('reconciles an uncertain prior provider call without calling the provider again', async () => {
    const graph = await createW601Fixtures(prisma, { balanceMinor: 10_000n });
    const scenario = await createScenario();

    // Model a prior worker that invoked the fake adapter but crashed before the
    // durable operation was written. Only the conservative reconciliation marker
    // survives; the recovery worker must never re-invoke the adapter.
    const claimService = new CampaignExecutionClaimService(prisma as never);
    const claim = await claimService.claim({
      organizationId: graph.organizationId,
      campaignId: graph.campaignId,
      recipientId: graph.recipientId,
    });
    if (claim.status !== 'claimed') throw new Error('prior call claim failed');
    const attempt = await prisma.callAttempt.findUniqueOrThrow({
      where: {
        organizationId_id: {
          organizationId: graph.organizationId,
          id: claim.attemptId,
        },
      },
      select: { id: true, attemptNumber: true, destination: true },
    });
    const request = canonicalCampaignCallInitiation({
      organizationId: graph.organizationId,
      campaignId: graph.campaignId,
      recipientId: graph.recipientId,
      attemptId: attempt.id,
      attemptNumber: attempt.attemptNumber,
      destination: attempt.destination,
      bindingSource: CALLBACK_SOURCES.fake,
    });
    const providerCallId = `fake-${attempt.id}`;
    await redis.rpush(
      scenario.invocationKey,
      JSON.stringify({
        organizationId: graph.organizationId,
        attemptId: attempt.id,
        idempotencyKey: request.idempotencyKey,
        providerCallId,
        pid: process.pid,
      } satisfies InvocationEvidence),
    );
    await prisma.callInitiationReconciliation.updateMany({
      where: {
        organizationId: graph.organizationId,
        attemptId: attempt.id,
        status: 'NOT_STARTED',
      },
      data: { status: 'INVOKING' },
    });
    await prisma.callInitiationReconciliation.updateMany({
      where: {
        organizationId: graph.organizationId,
        attemptId: attempt.id,
        status: 'INVOKING',
      },
      data: { status: 'UNKNOWN', reconciliationRequired: true },
    });

    const worker = await startReadyWorker(scenario);
    const recoveryJob = await enqueueJob(scenario, graph);
    const recovered = await waitForJobState(scenario, recoveryJob.id, 'completed');
    const finalState = await readPersistedState(graph, scenario.invocationKey);

    expect(jobOutcome(recovered.returnvalue).status).toBe('reconciliation_required');
    expect(jobOutcome(recovered.returnvalue).outcomes?.[0]?.result).toMatchObject({
      status: 'uncertain',
      reconciliationRequired: true,
    });
    expect(finalState.invocations).toHaveLength(1);
    expect(finalState.operations).toHaveLength(0);
    expect(worker.stdoutInvocations()).toHaveLength(0);
    evidence('reconcile-prior-calls', {
      recoveryQueue: scenario.queueName,
      reconciliationStatus: finalState.reconciliations[0]?.status,
      fakeProviderInvocations: finalState.invocations.length,
      recoveryWorkerInvocations: worker.stdoutInvocations().length,
    });
    await stopChild(worker);
  });

  it('settles duplicate callbacks once without double charging or a second provider call', async () => {
    const graph = await createW601Fixtures(prisma, { balanceMinor: 10_000n });
    const scenario = await createScenario();
    const worker = await startReadyWorker(scenario);
    const job = await enqueueJob(scenario, graph);
    const completed = await waitForJobState(scenario, job.id, 'completed');
    const state = await readPersistedState(graph, scenario.invocationKey);
    expect(state.invocations).toHaveLength(1);
    const session = state.invocations[0]!.providerCallId;

    const receipts = new CallbackReceipts(prisma, { settlement: new UsageSettlement() });
    const eventKey = randomBytes(32).toString('hex');
    const receive = async (key: string, callbackState: 'ANSWERED' | 'COMPLETED') => {
      await receipts.receive({
        source: CALLBACK_SOURCES.fake,
        sessionId: session,
        eventKey: key,
        state: callbackState,
        receivedAt: new Date(),
        occurredAt: new Date(),
      });
      const [row] = await prisma.$queryRaw<Array<{ id: string }>>`
        SELECT id::text FROM voice_callback_receipts
        WHERE source = ${CALLBACK_SOURCES.fake} AND event_key = ${key}`;
      if (!row) throw new Error('Synthetic receipt was not persisted.');
      return row.id;
    };

    await prisma.$transaction((tx) =>
      settlementQuote(tx as unknown as CallSql, graph.organizationId, state.attempts[0]!.id, session),
    );
    // A legal terminal callback requires the answered state first; DIALING ->
    // COMPLETED is rejected by the domain transition graph.
    const answered = await receive(randomBytes(32).toString('hex'), 'ANSWERED');
    await receipts.process(answered);

    const receiptId = await receive(eventKey, 'COMPLETED');
    await receipts.process(receiptId);
    await receive(eventKey, 'COMPLETED');
    await receipts.process(receiptId);
    const duplicateReceipt = await receive(randomBytes(32).toString('hex'), 'COMPLETED');
    await receipts.process(duplicateReceipt);

    const debits = await prisma.$queryRaw<Array<{ amount_minor: string }>>`
      SELECT amount_minor::text FROM wallet_entries
      WHERE organization_id = ${graph.organizationId}::uuid
        AND reference LIKE ${`voice-usage:${graph.organizationId}:%`}`;
    const usage = await prisma.voiceUsageEvent.count({
      where: { organizationId: graph.organizationId, receiptEventKey: eventKey },
    });
    const settled = await prisma.campaignDispatchReservation.count({
      where: {
        organizationId: graph.organizationId,
        attemptId: state.attempts[0]!.id,
        state: 'SETTLED',
      },
    });

    expect(debits).toHaveLength(1);
    expect(usage).toBe(1);
    expect(settled).toBe(1);
    expect(jobOutcome(completed.returnvalue).status).toBe('processed');
    evidence('duplicate-callbacks', {
      queueName: scenario.queueName,
      walletDebits: debits.length,
      usageEvents: usage,
      settledReservations: settled,
      fakeProviderInvocations: state.invocations.length,
    });
    await stopChild(worker);
  });

  it('serializes an in-flight provider call against a concurrent stop and blocks later work', async () => {
    const graph = await createW601Fixtures(prisma, { balanceMinor: 10_000n });
    const scenario = await createScenario();
    const worker = startWorker(scenario, { gateCheckpoint: 'before-provider-invocation' });
    await waitForChildMessage(worker.ready, worker, 'gated worker readiness');
    const job = await enqueueJob(scenario, graph);
    const marker = await waitForChildMessage(worker.checkpoint, worker, 'provider gate checkpoint');
    expect(marker).toMatchObject({ type: 'checkpoint', gated: true });

    const stoppedAt = new Date();
    const stop = prisma.$transaction(async (tx) => {
      await lockCampaignDispatch(tx, graph.organizationId, graph.campaignId);
      const result = await tx.campaign.updateMany({
        where: {
          organizationId: graph.organizationId,
          id: graph.campaignId,
          status: 'ACTIVE',
          emergencyStoppedAt: null,
        },
        data: {
          status: 'COMPLETED',
          emergencyStoppedAt: stoppedAt,
          dispatchState: 'CANCELLED',
          cancelledAt: stoppedAt,
          dispatchStopReason: 'emergency_stop',
          dispatchEpoch: { increment: 1 },
        },
      });
      if (result.count !== 1) throw new Error('concurrent_stop_failed');
    });

    await sleep(250);
    expect((await readCampaign(graph)).dispatchState).toBe('RUNNING');
    expect((await redis.lrange(scenario.invocationKey, 0, -1)).length).toBe(0);
    await redis.set(scenario.gateKey, 'release');
    await within(stop, 10_000, 'concurrent stop');
    await waitForJobState(scenario, job.id, 'completed');
    const state = await readPersistedState(graph, scenario.invocationKey);
    expect(state.invocations).toHaveLength(1);
    expect(await readCampaign(graph)).toMatchObject({
      dispatchState: 'CANCELLED',
      dispatchStopReason: 'emergency_stop',
    });

    const laterJob = await enqueueJob(scenario, graph);
    const laterCompleted = await waitForJobState(scenario, laterJob.id, 'completed');
    const finalState = await readPersistedState(graph, scenario.invocationKey);
    expect(jobOutcome(laterCompleted.returnvalue).status).toBe('cancelled');
    expect(finalState.invocations).toHaveLength(1);

    evidence('concurrent-stop-dispatch', {
      queueName: scenario.queueName,
      providerInvocationsBeforeStopCommit: 0,
      fakeProviderInvocationsAfterStop: finalState.invocations.length,
      laterJobStatus: jobOutcome(laterCompleted.returnvalue).status,
    });
    await stopChild(worker);
  });

  it('fails closed on database and Redis faults without unbounded provider work', async () => {
    const beforeGraph = await createW601Fixtures(prisma, { balanceMinor: 10_000n });
    const beforeScenario = await createScenario({ faultMode: 'db-before-provider', maxAttempts: 1 });
    const beforeWorker = await startReadyWorker(beforeScenario);
    const beforeJob = await enqueueJob(beforeScenario, beforeGraph);
    const beforeCompleted = await waitForJobState(beforeScenario, beforeJob.id, 'completed');
    const beforeState = await readPersistedState(beforeGraph, beforeScenario.invocationKey);
    expect(jobOutcome(beforeCompleted.returnvalue).status).toBe('reconciliation_required');
    expect(jobOutcome(beforeCompleted.returnvalue).outcomes?.[0]?.result).toMatchObject({
      status: 'uncertain',
      reconciliationRequired: true,
    });
    expect(beforeState.invocations).toHaveLength(0);
    expect(beforeState.operations).toHaveLength(0);
    expect(beforeState.reservations).toHaveLength(0);

    const afterGraph = await createW601Fixtures(prisma, { balanceMinor: 10_000n });
    const afterScenario = await createScenario({
      faultMode: 'db-after-provider',
      maxAttempts: 1,
    });
    const afterWorker = await startReadyWorker(afterScenario);
    const afterJob = await enqueueJob(afterScenario, afterGraph);
    const afterCompleted = await waitForJobState(afterScenario, afterJob.id, 'completed');
    const afterState = await readPersistedState(afterGraph, afterScenario.invocationKey);
    expect(jobOutcome(afterCompleted.returnvalue).status).toBe('reconciliation_required');
    expect(afterState.invocations).toHaveLength(1);
    expect(afterState.operations).toHaveLength(0);
    expect(afterState.reconciliations[0]).toMatchObject({
      status: 'UNKNOWN',
      reconciliationRequired: true,
    });

    const redisGraph = await createW601Fixtures(prisma, { balanceMinor: 10_000n });
    const redisScenario = await createScenario({ redisFailure: true });
    const redisWorker = startWorker(redisScenario);
    const redisExit = await within(redisWorker.exit, 15_000, 'Redis failure child exit');
    expect(redisExit.code).not.toBe(0);
    expect(redisWorker.stdoutInvocations()).toHaveLength(0);
    const redisJob = await enqueueJob(redisScenario, redisGraph);
    expect(await waitForJobState(redisScenario, redisJob.id, 'waiting')).toBeTruthy();

    evidence('db-redis-failure', {
      dbFailureBeforeProviderInvocations: beforeState.invocations.length,
      dbFailureAfterProviderInvocations: afterState.invocations.length,
      redisUnavailableExitCode: redisExit.code,
      redisUnavailableInvocations: redisWorker.stdoutInvocations().length,
    });
    await stopChild(beforeWorker);
    await stopChild(afterWorker);
    await stopChild(redisWorker);
  });
});

const settlement = new UsageSettlement();

async function settlementQuote(
  tx: CallSql,
  organizationId: string,
  attemptId: string,
  session: string,
): Promise<void> {
  await settlement.quote(tx, {
    organizationId,
    attemptId,
    source: CALLBACK_SOURCES.fake,
    sessionId: session,
    billedSeconds: 50,
    ratePerSecondMinor: '5',
    customerChargeMinor: '250',
    providerCostMinor: '900',
    providerCostCurrency: 'UGX',
    pricingVersion: 'w601-test-v1',
  });
}
