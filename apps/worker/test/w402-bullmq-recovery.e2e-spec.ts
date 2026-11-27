import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Queue } from 'bullmq';
import type { PrismaClient } from '@truevine/database';
import {
  createBullConnectionOptions,
  createCampaignExecutionQueue,
  createRedisClient,
  type Redis,
} from '@truevine/queue';
import { CALL_OPERATION_TYPES } from '@truevine/telephony';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { loadWorkerConfig } from '../src/config/worker.config.js';
import { createW402TestDatabaseClient } from './helpers/w402-test-database.js';
import { createW402Fixtures, type W402FixtureGraph } from './helpers/w402-fixtures.js';

const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const CHILD_SCRIPT = fileURLToPath(new URL('./w402-bullmq-child.mjs', import.meta.url));
const crashCheckpoints = [
  'before-claim-commit',
  'after-claim-commit',
  'before-provider-invocation',
  'after-provider-invocation-before-operation-persistence',
  'after-operation-commit',
] as const;

type CrashCheckpoint = (typeof crashCheckpoints)[number];
type ChildMessage =
  | { readonly type: 'ready'; readonly pid: number; readonly queueName: string }
  | { readonly type: 'checkpoint'; readonly pid: number; readonly checkpoint: string };
type ChildExit = { readonly code: number | null; readonly signal: NodeJS.Signals | null; readonly error?: Error };
type ChildRun = {
  readonly child: ChildProcess;
  readonly ready: Promise<ChildMessage>;
  readonly checkpoint: Promise<ChildMessage>;
  readonly exit: Promise<ChildExit>;
  readonly output: () => { stdout: string; stderr: string };
};
type InvocationEvidence = {
  readonly organizationId: string;
  readonly attemptId: string;
  readonly idempotencyKey: string;
  readonly providerCallId: string;
  readonly pid: number;
};
type PersistedState = {
  readonly attempts: Array<{
    id: string;
    recipientId: string;
    state: string;
    attemptNumber: number;
  }>;
  readonly operations: Array<{
    operation: string;
    key: string;
    attemptId: string;
    result: unknown;
  }>;
  readonly callbackBindingCount: number;
  readonly reconciliations: Array<{
    attemptId: string;
    status: string;
    reconciliationRequired: boolean;
  }>;
  readonly invocations: InvocationEvidence[];
};
type Scenario = {
  readonly queueName: string;
  readonly runId: string;
  readonly invocationKey: string;
  readonly startsKey: string;
  readonly activeKey: string;
  readonly maximumActiveKey: string;
  readonly failuresKey: string;
  readonly keys: string[];
  readonly queue: Queue<{ organizationId: string; campaignId: string }>;
  readonly environment: NodeJS.ProcessEnv;
  readonly children: Set<ChildRun>;
};
type WorkerOverrides = {
  readonly concurrency?: number;
  readonly rateLimitMax?: number;
  readonly rateLimitDurationMs?: number;
  readonly delayMs?: number;
  readonly failFirst?: number;
  readonly failAlways?: boolean;
};

let prisma: PrismaClient;
let redis: Redis;
let databaseUrl: string;
let redisUrl: string;
const scenarios: Scenario[] = [];

function assertEnvironment(): void {
  if (process.env.NODE_ENV !== 'test') throw new Error('W402 BullMQ tests require NODE_ENV=test.');
  if (!process.env.DATABASE_URL) throw new Error('W402 BullMQ tests require DATABASE_URL.');

  const database = new URL(process.env.DATABASE_URL);
  if (
    !['postgres:', 'postgresql:'].includes(database.protocol) ||
    !['localhost', '127.0.0.1', '::1', '[::1]'].includes(database.hostname) ||
    database.port !== '55432' ||
    database.pathname !== '/truevine_w402_integration_test' ||
    ['host', 'hostaddr', 'port', 'database', 'dbname'].some((key) => database.searchParams.has(key))
  ) {
    throw new Error('W402 BullMQ tests refuse every database except local truevine_w402_integration_test.');
  }

  if (!process.env.REDIS_URL) throw new Error('W402 BullMQ tests require REDIS_URL.');
  const redisTarget = new URL(process.env.REDIS_URL);
  if (
    redisTarget.protocol !== 'redis:' ||
    !['localhost', '127.0.0.1', '::1', '[::1]'].includes(redisTarget.hostname) ||
    redisTarget.port !== '56379'
  ) {
    throw new Error('W402 BullMQ tests require local Redis on port 56379.');
  }
  if (!existsSync(CHILD_SCRIPT)) throw new Error('W402 BullMQ child process script is missing.');
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (error: Error) => void } {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function startChild(environment: NodeJS.ProcessEnv, scenario: Scenario): ChildRun {
  let stdout = '';
  let stderr = '';
  let bufferedLine = '';
  const ready = deferred<ChildMessage>();
  const checkpoint = deferred<ChildMessage>();
  const exit = deferred<ChildExit>();
  const child = spawn(process.execPath, [CHILD_SCRIPT], {
    cwd: REPO_ROOT,
    env: environment,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const run: ChildRun = {
    child,
    ready: ready.promise,
    checkpoint: checkpoint.promise,
    exit: exit.promise,
    output: () => ({ stdout, stderr }),
  };
  scenario.children.add(run);

  const consumeLine = (line: string) => {
    try {
      if (line.startsWith('W402_READY ')) {
        const message = JSON.parse(line.slice('W402_READY '.length)) as {
          pid?: unknown;
          queueName?: unknown;
        };
        if (typeof message.pid === 'number' && typeof message.queueName === 'string') {
          ready.resolve({ type: 'ready', pid: message.pid, queueName: message.queueName });
        } else {
          ready.reject(new Error('Malformed W402 worker readiness message.'));
        }
      } else if (line.startsWith('W402_CHECKPOINT ')) {
        const message = JSON.parse(line.slice('W402_CHECKPOINT '.length)) as {
          checkpoint?: unknown;
          pid?: unknown;
        };
        if (typeof message.pid === 'number' && typeof message.checkpoint === 'string') {
          checkpoint.resolve({ type: 'checkpoint', pid: message.pid, checkpoint: message.checkpoint });
        } else {
          checkpoint.reject(new Error('Malformed W402 checkpoint message.'));
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

async function stopChild(run: ChildRun): Promise<ChildExit> {
  if (
    run.child.exitCode === null &&
    run.child.signalCode === null &&
    !run.child.kill('SIGKILL')
  ) {
    throw new Error(`Could not terminate worker PID ${run.child.pid}.`);
  }
  return waitForExit(run, `terminated worker PID ${run.child.pid}`);
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

async function createScenario(overrides: WorkerOverrides = {}): Promise<Scenario> {
  const runId = randomUUID();
  const queueName = `w402-${runId}`;
  const keyPrefix = `w402:bullmq:${runId}`;
  const invocationKey = `${keyPrefix}:invocations`;
  const startsKey = `${keyPrefix}:starts`;
  const activeKey = `${keyPrefix}:active`;
  const maximumActiveKey = `${keyPrefix}:maximum-active`;
  const failuresKey = `${keyPrefix}:failures`;
  const keys = [invocationKey, startsKey, activeKey, maximumActiveKey, failuresKey];
  await redis.del(...keys);

  const environment: NodeJS.ProcessEnv = {
    ...process.env,
    NODE_ENV: 'test',
    DATABASE_URL: databaseUrl,
    REDIS_URL: redisUrl,
    CAMPAIGN_EXECUTION_QUEUE_NAME: queueName,
    W402_RUN_ID: runId,
    W402_INVOCATION_KEY: invocationKey,
    W402_STARTS_KEY: startsKey,
    W402_ACTIVE_KEY: activeKey,
    W402_MAX_ACTIVE_KEY: maximumActiveKey,
    W402_FAILURES_KEY: failuresKey,
    W402_CRASH_CHECKPOINT: '',
    W402_PROCESS_DELAY_MS: String(overrides.delayMs ?? 0),
    W402_FAIL_FIRST_N: String(overrides.failFirst ?? 0),
    W402_FAIL_ALWAYS: overrides.failAlways ? '1' : '0',
    WORKER_CONCURRENCY: String(overrides.concurrency ?? 4),
    WORKER_MAX_RETRY_ATTEMPTS: '3',
    WORKER_RETRY_BACKOFF_MS: '1000',
    WORKER_RATE_LIMIT_MAX: String(overrides.rateLimitMax ?? 10),
    WORKER_RATE_LIMIT_DURATION_MS: String(overrides.rateLimitDurationMs ?? 1000),
  };
  const config = loadWorkerConfig(environment);
  const queue = createCampaignExecutionQueue(createBullConnectionOptions(redisUrl), {
    queueName,
    maxAttempts: config.maxRetryAttempts,
    retryBackoffMs: config.retryBackoffMs,
  });
  const scenario: Scenario = {
    queueName,
    runId,
    invocationKey,
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

function startWorker(scenario: Scenario, checkpointName = ''): ChildRun {
  return startChild(
    { ...scenario.environment, W402_CRASH_CHECKPOINT: checkpointName },
    scenario,
  );
}

async function enqueueJob(
  scenario: Scenario,
  graph: W402FixtureGraph,
): Promise<{ id: string; getState: () => Promise<string> }> {
  const id = `w402-${randomUUID()}`;
  const job = await scenario.queue.add(
    'execute',
    { organizationId: graph.organizationId, campaignId: graph.campaignId },
    { jobId: id },
  );
  return { id, getState: () => job.getState() };
}

async function waitForJobState(
  scenario: Scenario,
  jobId: string,
  expectedState: 'completed' | 'failed',
  timeoutMs = 20_000,
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const job = await scenario.queue.getJob(jobId);
    if (job) {
      const state = await job.getState();
      if (state === expectedState) {
        return (await scenario.queue.getJob(jobId)) ?? job;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  const job = await scenario.queue.getJob(jobId);
  const state = job ? await job.getState() : 'missing';
  throw new Error(`BullMQ job ${jobId} stayed in ${state}; expected ${expectedState}.`);
}

async function readPersistedState(
  graph: W402FixtureGraph,
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
  const [operations, bindings, reconciliations, rawInvocations] = await Promise.all([
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
    redis.lrange(invocationKey, 0, -1),
  ]);
  return {
    attempts,
    operations,
    callbackBindingCount: bindings.length,
    reconciliations,
    invocations: rawInvocations.map((entry) => JSON.parse(entry) as InvocationEvidence),
  };
}

async function waitForPersistedCounts(
  graph: W402FixtureGraph,
  invocationKey: string,
  expected: { attempts: number; operations: number; invocations: number },
): Promise<PersistedState> {
  const deadline = Date.now() + 10_000;
  let state = await readPersistedState(graph, invocationKey);
  while (
    (state.attempts.length !== expected.attempts ||
      state.operations.length !== expected.operations ||
      state.invocations.length !== expected.invocations) &&
    Date.now() < deadline
  ) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    state = await readPersistedState(graph, invocationKey);
  }
  expect(state.attempts).toHaveLength(expected.attempts);
  expect(state.operations).toHaveLength(expected.operations);
  expect(state.invocations).toHaveLength(expected.invocations);
  return state;
}

async function addAdditionalRecipient(
  graph: W402FixtureGraph,
  destination: string,
): Promise<string> {
  const contact = await prisma.contact.create({
    data: {
      organizationId: graph.organizationId,
      id: randomUUID(),
      destination,
      createdById: graph.userId,
    },
  });
  const recipient = await prisma.campaignRecipient.create({
    data: {
      organizationId: graph.organizationId,
      id: randomUUID(),
      campaignId: graph.campaignId,
      contactId: contact.id,
      destination,
    },
  });
  return recipient.id;
}

async function createGraphs(count: number): Promise<W402FixtureGraph[]> {
  const graphs: W402FixtureGraph[] = [];
  for (let index = 0; index < count; index += 1) {
    graphs.push(await createW402Fixtures(prisma));
  }
  return graphs;
}

async function addJobs(
  scenario: Scenario,
  graphs: readonly W402FixtureGraph[],
): Promise<string[]> {
  const jobs = await Promise.all(graphs.map((graph) => enqueueJob(scenario, graph)));
  return jobs.map((job) => job.id);
}

async function finishJobs(scenario: Scenario, jobIds: readonly string[]): Promise<void> {
  await Promise.all(jobIds.map((jobId) => waitForJobState(scenario, jobId, 'completed')));
}

async function getStarts(scenario: Scenario): Promise<Array<{ at: number; pid: number }>> {
  return (await redis.lrange(scenario.startsKey, 0, -1)).map(
    (entry) => JSON.parse(entry) as { at: number; pid: number },
  );
}

describe('W402 campaign processor through real BullMQ workers', () => {
  beforeAll(async () => {
    assertEnvironment();
    databaseUrl = process.env.DATABASE_URL!;
    redisUrl = process.env.REDIS_URL!;
    prisma = await createW402TestDatabaseClient();
    redis = createRedisClient(redisUrl);
    await redis.ping();
  }, 30_000);

  afterEach(async () => {
    for (const scenario of scenarios.splice(0)) {
      await disposeScenario(scenario);
    }
  }, 30_000);

  afterAll(async () => {
    try {
      for (const scenario of scenarios.splice(0)) {
        await disposeScenario(scenario);
      }
    } finally {
      if (typeof redis !== 'undefined') redis.disconnect();
      if (typeof prisma !== 'undefined') await prisma.$disconnect();
    }
  }, 30_000);

  it.each(crashCheckpoints)(
    'recovers the valid BullMQ campaign job after %s without duplicate initiation',
    async (checkpointName: CrashCheckpoint) => {
      const graph = await createW402Fixtures(prisma);
      const scenario = await createScenario();
      const job = await enqueueJob(scenario, graph);
      const workerA = startWorker(scenario, checkpointName);
      const readyA = await waitForChildMessage(workerA.ready, workerA, 'Worker A readiness');
      expect(readyA).toMatchObject({ type: 'ready', pid: workerA.child.pid, queueName: scenario.queueName });

      const marker = await waitForChildMessage(workerA.checkpoint, workerA, `${checkpointName} checkpoint`);
      expect(marker).toEqual({ type: 'checkpoint', pid: workerA.child.pid, checkpoint: checkpointName });
      expect(await job.getState()).toBe('active');

      const workerAExit = await killChild(workerA);
      const checkpointExpected =
        checkpointName === 'before-claim-commit'
          ? { attempts: 0, operations: 0, invocations: 0 }
          : checkpointName === 'after-operation-commit'
            ? { attempts: 1, operations: 1, invocations: 1 }
            : {
                attempts: 1,
                operations: 0,
                invocations:
                  checkpointName === 'after-provider-invocation-before-operation-persistence' ? 1 : 0,
              };
      const afterCrash = await waitForPersistedCounts(
        graph,
        scenario.invocationKey,
        checkpointExpected,
      );

      const workerB = startWorker(scenario);
      const readyB = await waitForChildMessage(workerB.ready, workerB, 'Worker B readiness');
      expect(readyB).toMatchObject({ type: 'ready', pid: workerB.child.pid, queueName: scenario.queueName });
      const completedJob = await waitForJobState(scenario, job.id, 'completed');
      const finalState = await readPersistedState(graph, scenario.invocationKey);
      const jobResult = completedJob.returnvalue as {
        status: string;
        recipientCount?: number;
        outcomes?: Array<{ recipientId: string; result: { status: string; replayed?: boolean } }>;
      };
      const finalExpected =
        checkpointName === 'before-claim-commit' || checkpointName === 'after-operation-commit'
          ? { operations: 1, invocations: 1 }
          : checkpointName === 'after-claim-commit'
            ? { operations: 0, invocations: 0 }
            : {
                operations: 0,
                invocations:
                  checkpointName === 'after-provider-invocation-before-operation-persistence' ? 1 : 0,
              };

      expect(finalState.attempts).toHaveLength(1);
      expect(finalState.attempts[0]?.attemptNumber).toBe(1);
      expect(finalState.callbackBindingCount).toBe(finalExpected.operations);
      expect(finalState.operations).toHaveLength(finalExpected.operations);
      expect(finalState.invocations).toHaveLength(finalExpected.invocations);
      expect(finalState.reconciliations).toHaveLength(1);
      if (finalExpected.operations > 0) {
        expect(finalState.operations[0]?.attemptId).toBe(finalState.attempts[0]?.id);
      }
      expect(finalState.invocations.every((entry) => entry.organizationId === graph.organizationId)).toBe(true);

      if (checkpointName === 'before-claim-commit') {
        expect(finalState.reconciliations[0]).toMatchObject({
          status: 'CONFIRMED',
          reconciliationRequired: false,
        });
        expect(jobResult.status).toBe('processed');
        expect(jobResult.outcomes?.[0]?.result).toMatchObject({ status: 'initiated', replayed: false });
        expect(finalState.invocations[0]?.pid).toBe(workerB.child.pid);
      } else if (checkpointName === 'after-claim-commit') {
        expect(finalState.reconciliations[0]).toMatchObject({
          status: 'FAILED_BEFORE_PROVIDER',
          reconciliationRequired: false,
        });
        expect(jobResult.outcomes?.[0]?.result).toMatchObject({ status: 'failed_before_provider' });
      } else if (
        checkpointName === 'before-provider-invocation' ||
        checkpointName === 'after-provider-invocation-before-operation-persistence'
      ) {
        expect(finalState.reconciliations[0]).toMatchObject({
          status: 'UNKNOWN',
          reconciliationRequired: true,
        });
        expect(jobResult.status).toBe('reconciliation_required');
        if (checkpointName === 'after-provider-invocation-before-operation-persistence') {
          expect(finalState.invocations[0]?.pid).toBe(workerA.child.pid);
        }
      } else {
        expect(finalState.reconciliations[0]).toMatchObject({
          status: 'CONFIRMED',
          reconciliationRequired: false,
        });
        expect(jobResult.outcomes?.[0]?.result).toMatchObject({ status: 'initiated', replayed: true });
        expect(finalState.invocations[0]?.pid).toBe(workerA.child.pid);
      }

      const workerBExit = await stopChild(workerB);
      const evidence = {
        checkpoint: checkpointName,
        queueName: scenario.queueName,
        jobId: job.id,
        workerAPid: workerA.child.pid,
        workerAExit,
        workerBPid: workerB.child.pid,
        workerBExit,
        bullMqState: await completedJob.getState(),
        attemptsMade: completedJob.attemptsMade,
        beforeRecovery: {
          attempts: afterCrash.attempts.length,
          operations: afterCrash.operations.length,
          invocations: afterCrash.invocations.length,
          reconciliation: afterCrash.reconciliations[0] ?? null,
        },
        final: {
          attempts: finalState.attempts.length,
          operations: finalState.operations.length,
          callbackBindings: finalState.callbackBindingCount,
          invocations: finalState.invocations.length,
          reconciliation: finalState.reconciliations[0],
          result: jobResult,
        },
      };
      process.stdout.write(`W402_BULLMQ_RECOVERY_EVIDENCE ${JSON.stringify(evidence)}\n`);
    },
    60_000,
  );

  it('expands recipient snapshots in stable order and replays a duplicate campaign job', async () => {
    const graph = await createW402Fixtures(prisma);
    const secondRecipientId = await addAdditionalRecipient(graph, '+12025550124');
    const scenario = await createScenario();
    const worker = startWorker(scenario);
    await waitForChildMessage(worker.ready, worker, 'expansion worker readiness');

    const firstJob = await enqueueJob(scenario, graph);
    const firstCompleted = await waitForJobState(scenario, firstJob.id, 'completed');
    const secondJob = await enqueueJob(scenario, graph);
    const secondCompleted = await waitForJobState(scenario, secondJob.id, 'completed');
    const state = await readPersistedState(graph, scenario.invocationKey);

    expect(firstCompleted.returnvalue).toMatchObject({ status: 'processed', recipientCount: 2 });
    expect(secondCompleted.returnvalue).toMatchObject({ status: 'processed', recipientCount: 2 });
    expect(state.attempts).toHaveLength(2);
    expect(new Set(state.attempts.map((attempt) => attempt.recipientId))).toEqual(
      new Set([graph.recipientId, secondRecipientId]),
    );
    expect(state.operations).toHaveLength(2);
    expect(state.callbackBindingCount).toBe(2);
    expect(state.invocations).toHaveLength(2);
    expect(
      (secondCompleted.returnvalue as { outcomes: Array<{ result: { replayed?: boolean } }> }).outcomes.every(
        ({ result }) => result.replayed === true,
      ),
    ).toBe(true);

    process.stdout.write(
      `W402_BULLMQ_EXPANSION_EVIDENCE ${JSON.stringify({
        queueName: scenario.queueName,
        jobIds: [firstJob.id, secondJob.id],
        workerPid: worker.child.pid,
        finalStates: [await firstCompleted.getState(), await secondCompleted.getState()],
        attempts: state.attempts.length,
        operations: state.operations.length,
        invocations: state.invocations.length,
        replayedOutcomes: 2,
      })}\n`,
    );
    await stopChild(worker);
  });

  it('uses configured attempts and exponential backoff for pre-claim transient failures', async () => {
    const graph = await createW402Fixtures(prisma);
    const scenario = await createScenario({ failFirst: 2 });
    const worker = startWorker(scenario);
    await waitForChildMessage(worker.ready, worker, 'retry worker readiness');
    const job = await enqueueJob(scenario, graph);
    const completed = await waitForJobState(scenario, job.id, 'completed', 15_000);
    const starts = await getStarts(scenario);
    const state = await readPersistedState(graph, scenario.invocationKey);
    const delays = [starts[1]!.at - starts[0]!.at, starts[2]!.at - starts[1]!.at];

    expect(starts).toHaveLength(3);
    expect(completed.attemptsMade).toBe(3);
    expect(delays[0]).toBeGreaterThanOrEqual(750);
    expect(delays[1]).toBeGreaterThanOrEqual(1_500);
    expect(state.attempts).toHaveLength(1);
    expect(state.operations).toHaveLength(1);
    expect(state.invocations).toHaveLength(1);

    process.stdout.write(
      `W402_BULLMQ_RETRY_EVIDENCE ${JSON.stringify({
        queueName: scenario.queueName,
        jobId: job.id,
        workerPid: worker.child.pid,
        state: await completed.getState(),
        attemptsMade: completed.attemptsMade,
        attemptStartTimes: starts.map((entry) => entry.at),
        backoffDelaysMs: delays,
        callAttempts: state.attempts.length,
        operations: state.operations.length,
        fakeInvocations: state.invocations.length,
      })}\n`,
    );
    await stopChild(worker);
  });

  it('marks a persistently failing job failed after the configured attempt count', async () => {
    const graph = await createW402Fixtures(prisma);
    const scenario = await createScenario({ failAlways: true });
    const worker = startWorker(scenario);
    await waitForChildMessage(worker.ready, worker, 'failed-job worker readiness');
    const job = await enqueueJob(scenario, graph);
    const failed = await waitForJobState(scenario, job.id, 'failed', 15_000);
    const starts = await getStarts(scenario);
    const state = await readPersistedState(graph, scenario.invocationKey);

    expect(starts).toHaveLength(3);
    expect(failed.attemptsMade).toBe(3);
    expect(failed.failedReason).toContain('W402_TEST_TRANSIENT_BEFORE_CAMPAIGN_PROCESSOR');
    expect(state.attempts).toHaveLength(0);
    expect(state.operations).toHaveLength(0);
    expect(state.invocations).toHaveLength(0);

    process.stdout.write(
      `W402_BULLMQ_FAILED_JOB_EVIDENCE ${JSON.stringify({
        queueName: scenario.queueName,
        jobId: job.id,
        workerPid: worker.child.pid,
        state: await failed.getState(),
        attemptsMade: failed.attemptsMade,
        starts: starts.length,
        callAttempts: state.attempts.length,
        fakeInvocations: state.invocations.length,
        failedReason: failed.failedReason,
      })}\n`,
    );
    await stopChild(worker);
  });

  it('enforces the configured worker concurrency with simultaneous valid jobs', async () => {
    const graphs = await createGraphs(4);
    const scenario = await createScenario({
      concurrency: 2,
      rateLimitMax: 10,
      delayMs: 300,
    });
    const worker = startWorker(scenario);
    await waitForChildMessage(worker.ready, worker, 'concurrency worker readiness');
    const jobIds = await addJobs(scenario, graphs);
    await finishJobs(scenario, jobIds);

    const maximumActive = Number((await redis.get(scenario.maximumActiveKey)) ?? '0');
    const allStates = await Promise.all(
      jobIds.map(async (jobId) => (await scenario.queue.getJob(jobId))?.getState()),
    );
    const totalAttempts = (
      await Promise.all(graphs.map((graph) => readPersistedState(graph, scenario.invocationKey)))
    ).reduce((total, state) => total + state.attempts.length, 0);

    expect(maximumActive).toBe(2);
    expect(allStates).toEqual(jobIds.map(() => 'completed'));
    expect(totalAttempts).toBe(4);

    process.stdout.write(
      `W402_BULLMQ_CONCURRENCY_EVIDENCE ${JSON.stringify({
        queueName: scenario.queueName,
        jobIds,
        workerPid: worker.child.pid,
        configuredConcurrency: 2,
        measuredMaximumActive: maximumActive,
        completedJobs: allStates.length,
        callAttempts: totalAttempts,
      })}\n`,
    );
    await stopChild(worker);
  });

  it('enforces the configured per-window rate limit with valid jobs', async () => {
    const graphs = await createGraphs(4);
    const scenario = await createScenario({
      concurrency: 5,
      rateLimitMax: 2,
      rateLimitDurationMs: 1_000,
      delayMs: 50,
    });
    const worker = startWorker(scenario);
    await waitForChildMessage(worker.ready, worker, 'rate-limit worker readiness');
    const jobIds = await addJobs(scenario, graphs);
    const startedAt = Date.now();
    await finishJobs(scenario, jobIds);
    const elapsedMs = Date.now() - startedAt;
    const starts = (await getStarts(scenario)).sort((left, right) => left.at - right.at);
    const firstWaveAt = starts[0]?.at ?? 0;
    const secondWaveAt = starts[2]?.at ?? 0;
    const windowToleranceMs = 100;

    expect(starts).toHaveLength(4);
    process.stdout.write(
      `W402_BULLMQ_RATE_LIMIT_EVIDENCE ${JSON.stringify({
        queueName: scenario.queueName,
        jobIds,
        workerPid: worker.child.pid,
        configuredMax: 2,
        configuredWindowMs: 1_000,
        jobStartTimes: starts.map((entry) => entry.at),
        firstWaveDurationMs: starts[1]!.at - starts[0]!.at,
        interWaveDelayMs: secondWaveAt - firstWaveAt,
        elapsedMs,
      })}\n`,
    );
    // BullMQ applies a fixed window; allow instrumentation latency when measuring its boundary.
    expect(starts[1]!.at - starts[0]!.at).toBeLessThan(1_000 - windowToleranceMs);
    expect(secondWaveAt - firstWaveAt).toBeGreaterThanOrEqual(1_000 - windowToleranceMs);
    expect(starts[3]!.at - starts[2]!.at).toBeLessThan(1_000 - windowToleranceMs);
    expect(elapsedMs).toBeGreaterThanOrEqual(750);
    await stopChild(worker);
  });
});
