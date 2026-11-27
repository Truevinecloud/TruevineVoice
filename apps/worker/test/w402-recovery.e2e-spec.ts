import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { PrismaClient } from '@truevine/database';
import { createDatabaseClient } from '@truevine/database';
import { createRedisClient, type Redis } from '@truevine/queue';
import { CALLBACK_SOURCES, CALL_OPERATION_TYPES, canonicalCampaignCallInitiation } from '@truevine/telephony';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { CallInitiationReconciliationService } from '../src/campaigns/call-initiation-reconciliation.service.js';
import { cleanupW402Fixtures, createW402Fixtures, type W402FixtureGraph } from './helpers/w402-fixtures.js';
import { assertW402DatabaseUrl } from './helpers/w402-test-database.js';

const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const CHILD_SCRIPT = fileURLToPath(new URL('./w402-recovery-child.mjs', import.meta.url));
const BINDING_SOURCE = CALLBACK_SOURCES.fake;

const crashCheckpoints = [
  'before-claim-commit',
  'after-claim-commit',
  'before-provider-invocation',
  'after-provider-invocation-before-operation-persistence',
  'after-operation-commit',
] as const;

type CrashCheckpoint = (typeof crashCheckpoints)[number];
type ChildInitiationResult = {
  readonly status: string;
  readonly attemptId?: string;
  readonly providerCallId?: string;
  readonly replayed?: boolean;
};
type ChildMessage<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: string };
type ChildExit = { readonly code: number | null; readonly signal: NodeJS.Signals | null; readonly error?: Error };
type ChildRun = {
  readonly child: ChildProcess;
  readonly checkpoint: Promise<ChildMessage<{ checkpoint: string; pid: number }>>;
  readonly result: Promise<ChildMessage<{ pid: number; result: ChildInitiationResult }>>;
  readonly exit: Promise<ChildExit>;
  readonly output: () => { stdout: string; stderr: string };
};
type InvocationEvidence = {
  readonly organizationId: string;
  readonly attemptId: string;
  readonly idempotencyKey: string;
  readonly pid: number;
};
type PersistedState = {
  readonly attempts: Array<{ id: string; state: string; attemptNumber: number; destination: string }>;
  readonly operations: Array<{
    operation: string;
    key: string;
    fingerprintVersion: number;
    fingerprint: string;
    attemptId: string;
    result: unknown;
  }>;
  readonly callbackBindingCount: number;
  readonly reconciliation: {
    status: string;
    reconciliationRequired: boolean;
  } | null;
  readonly invocations: InvocationEvidence[];
};

let prisma: PrismaClient;
let redis: Redis;
const ledgerKeys: string[] = [];
const runningChildren = new Set<ChildProcess>();

function assertEnvironment(): { databaseUrl: string; redisUrl: string } {
  if (process.env.NODE_ENV !== 'test') throw new Error('W402 recovery requires NODE_ENV=test.');

  const databaseUrl = assertW402DatabaseUrl(process.env.DATABASE_URL, process.env.NODE_ENV);

  const redisUrl = process.env.REDIS_URL;
  if (!redisUrl) throw new Error('W402 recovery requires REDIS_URL.');
  const redisTarget = new URL(redisUrl);
  if (
    redisTarget.protocol !== 'redis:' ||
    !['localhost', '127.0.0.1', '::1', '[::1]'].includes(redisTarget.hostname) ||
    redisTarget.port !== '56379'
  ) {
    throw new Error('W402 recovery requires local test Redis on port 56379.');
  }

  if (!existsSync(CHILD_SCRIPT)) throw new Error('W402 child process script is missing.');
  return { databaseUrl, redisUrl };
}

function startChild(environment: NodeJS.ProcessEnv): ChildRun {
  let stdout = '';
  let stderr = '';
  let bufferedLine = '';
  let resolveCheckpoint!: (message: ChildMessage<{ checkpoint: string; pid: number }>) => void;
  let resolveResult!: (message: ChildMessage<{ pid: number; result: ChildInitiationResult }>) => void;
  let resolveExit!: (exit: ChildExit) => void;
  const checkpoint = new Promise<ChildMessage<{ checkpoint: string; pid: number }>>((resolve) => {
    resolveCheckpoint = resolve;
  });
  const result = new Promise<ChildMessage<{ pid: number; result: ChildInitiationResult }>>((resolve) => {
    resolveResult = resolve;
  });
  const exit = new Promise<ChildExit>((resolve) => {
    resolveExit = resolve;
  });
  const child = spawn(process.execPath, [CHILD_SCRIPT], {
    cwd: REPO_ROOT,
    env: environment,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  runningChildren.add(child);

  const consumeLine = (line: string) => {
    try {
      if (line.startsWith('W402_CHECKPOINT ')) {
        const message = JSON.parse(line.slice('W402_CHECKPOINT '.length)) as { checkpoint?: unknown; pid?: unknown };
        if (typeof message.checkpoint === 'string' && typeof message.pid === 'number') {
          resolveCheckpoint({ ok: true, value: { checkpoint: message.checkpoint, pid: message.pid } });
        } else {
          resolveCheckpoint({ ok: false, error: 'Malformed checkpoint message.' });
        }
      } else if (line.startsWith('W402_RESULT ')) {
        const message = JSON.parse(line.slice('W402_RESULT '.length)) as {
          pid?: unknown;
          result?: ChildInitiationResult;
        };
        if (typeof message.pid === 'number' && typeof message.result?.status === 'string') {
          resolveResult({ ok: true, value: { pid: message.pid, result: message.result } });
        } else {
          resolveResult({ ok: false, error: 'Malformed child result message.' });
        }
      }
    } catch (error) {
      const description = error instanceof Error ? error.message : String(error);
      resolveCheckpoint({ ok: false, error: description });
      resolveResult({ ok: false, error: description });
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
  child.once('error', (error) => {
    resolveExit({ code: null, signal: null, error });
  });
  child.once('close', (code, signal) => {
    runningChildren.delete(child);
    resolveExit({ code, signal });
  });

  return { child, checkpoint, result, exit, output: () => ({ stdout, stderr }) };
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

async function waitForChildMessage<T>(
  message: Promise<ChildMessage<T>>,
  run: ChildRun,
  label: string,
  timeoutMs: number,
): Promise<T> {
  const outcome = await within(
    Promise.race([
      message,
      run.exit.then((exit) => {
        const output = run.output();
        throw new Error(
          `${label}: child exited early (code=${exit.code}, signal=${exit.signal}). ` +
            `stdout=${output.stdout} stderr=${output.stderr}`,
        );
      }),
    ]),
    timeoutMs,
    label,
  );
  if (!outcome.ok) throw new Error(`${label}: ${outcome.error}`);
  return outcome.value;
}

async function waitForExit(run: ChildRun, label: string): Promise<ChildExit> {
  return within(run.exit, 10_000, `${label} process exit`);
}

async function stopChild(run: ChildRun): Promise<ChildExit> {
  if (run.child.exitCode === null && run.child.signalCode === null) run.child.kill('SIGKILL');
  return waitForExit(run, `child PID ${run.child.pid}`);
}

async function runCrashChild(
  environment: NodeJS.ProcessEnv,
  expectedCheckpoint: CrashCheckpoint,
): Promise<{ pid: number; exit: ChildExit }> {
  const run = startChild(environment);
  try {
    if (!run.child.pid) throw new Error('Node did not provide the crash child PID.');
    const marker = await waitForChildMessage(run.checkpoint, run, `${expectedCheckpoint} checkpoint`, 20_000);
    expect(marker).toEqual({ checkpoint: expectedCheckpoint, pid: run.child.pid });
    if (!run.child.kill('SIGKILL')) throw new Error(`Could not terminate checkpoint child PID ${run.child.pid}.`);
    const exit = await waitForExit(run, `checkpoint child PID ${run.child.pid}`);
    expect(exit.code !== 0 || exit.signal !== null).toBe(true);
    return { pid: run.child.pid, exit };
  } finally {
    if (run.child.exitCode === null && run.child.signalCode === null) await stopChild(run);
  }
}

async function runRecoveryChild(
  environment: NodeJS.ProcessEnv,
): Promise<{ pid: number; result: ChildInitiationResult; exit: ChildExit }> {
  const run = startChild(environment);
  try {
    if (!run.child.pid) throw new Error('Node did not provide the recovery child PID.');
    const message = await waitForChildMessage(run.result, run, 'replacement child result', 30_000);
    const exit = await waitForExit(run, `replacement child PID ${run.child.pid}`);
    if (exit.code !== 0) {
      const output = run.output();
      throw new Error(
        `Replacement child PID ${run.child.pid} failed (code=${exit.code}, signal=${exit.signal}). ` +
          `stdout=${output.stdout} stderr=${output.stderr}`,
      );
    }
    expect(message.pid).toBe(run.child.pid);
    return { pid: run.child.pid, result: message.result, exit };
  } finally {
    if (run.child.exitCode === null && run.child.signalCode === null) await stopChild(run);
  }
}

async function readPersistedState(
  graph: W402FixtureGraph,
  invocationKey: string,
): Promise<PersistedState> {
  const operationKey = `${graph.organizationId}:${graph.campaignId}:${graph.recipientId}:1`;
  const [attempts, operations, rawInvocations] = await Promise.all([
    prisma.callAttempt.findMany({
      where: {
        organizationId: graph.organizationId,
        campaignId: graph.campaignId,
        executionId: graph.executionId,
        recipientId: graph.recipientId,
      },
      select: { id: true, state: true, attemptNumber: true, destination: true },
    }),
    prisma.callOperation.findMany({
      where: {
        organizationId: graph.organizationId,
        operation: CALL_OPERATION_TYPES.campaignCallInitiation,
        key: operationKey,
      },
      select: {
        operation: true,
        key: true,
        fingerprintVersion: true,
        fingerprint: true,
        attemptId: true,
        result: true,
      },
    }),
    redis.lrange(invocationKey, 0, -1),
  ]);
  const attempt = attempts[0];
  const attemptReconciliation = attempt
    ? await prisma.callInitiationReconciliation.findUnique({
        where: {
          organizationId_attemptId: {
            organizationId: graph.organizationId,
            attemptId: attempt.id,
          },
        },
        select: { status: true, reconciliationRequired: true },
      })
    : null;
  const bindings = attempt
    ? await prisma.$queryRaw<Array<{ count: number }>>`
        SELECT COUNT(*)::int AS count
        FROM voice_callback_bindings
        WHERE source = ${BINDING_SOURCE}
          AND session_id = ${`fake-${attempt.id}`}
          AND organization_id = ${graph.organizationId}::uuid
          AND attempt_id = ${attempt.id}::uuid`
    : [{ count: 0 }];
  return {
    attempts,
    operations,
    callbackBindingCount: bindings[0]?.count ?? 0,
    reconciliation: attemptReconciliation,
    invocations: rawInvocations.map((entry) => JSON.parse(entry) as InvocationEvidence),
  };
}

async function waitForPersistedCounts(
  graph: W402FixtureGraph,
  invocationKey: string,
  expectedAttempts: number,
  expectedOperations: number,
): Promise<PersistedState> {
  const deadline = Date.now() + 10_000;
  let state = await readPersistedState(graph, invocationKey);
  while (
    (state.attempts.length !== expectedAttempts || state.operations.length !== expectedOperations) &&
    Date.now() < deadline
  ) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    state = await readPersistedState(graph, invocationKey);
  }
  expect(state.attempts).toHaveLength(expectedAttempts);
  expect(state.operations).toHaveLength(expectedOperations);
  return state;
}

function expectedOutcome(checkpoint: CrashCheckpoint): {
  readonly beforeRecoveryAttempts: number;
  readonly beforeRecoveryOperations: number;
  readonly beforeRecoveryInvocations: number;
  readonly beforeRecoveryReconciliation: string | null;
  readonly beforeRecoveryReconciliationRequired: boolean;
  readonly finalOperations: number;
  readonly finalInvocations: number;
  readonly finalCallbackBindings: number;
  readonly finalAttemptState: 'QUEUED' | 'DIALING';
  readonly resultStatus: 'initiated' | 'uncertain' | 'failed_before_provider';
  readonly finalReconciliation: string;
  readonly reconciliationRequired: boolean;
  readonly replayed: boolean;
} {
  if (checkpoint === 'before-claim-commit') {
    return {
      beforeRecoveryAttempts: 0,
      beforeRecoveryOperations: 0,
      beforeRecoveryInvocations: 0,
      beforeRecoveryReconciliation: null,
      beforeRecoveryReconciliationRequired: false,
      finalOperations: 1,
      finalInvocations: 1,
      finalCallbackBindings: 1,
      finalAttemptState: 'DIALING',
      resultStatus: 'initiated',
      finalReconciliation: 'CONFIRMED',
      reconciliationRequired: false,
      replayed: false,
    };
  }
  if (checkpoint === 'after-operation-commit') {
    return {
      beforeRecoveryAttempts: 1,
      beforeRecoveryOperations: 1,
      beforeRecoveryInvocations: 1,
      beforeRecoveryReconciliation: 'CONFIRMED',
      beforeRecoveryReconciliationRequired: false,
      finalOperations: 1,
      finalInvocations: 1,
      finalCallbackBindings: 1,
      finalAttemptState: 'DIALING',
      resultStatus: 'initiated',
      finalReconciliation: 'CONFIRMED',
      reconciliationRequired: false,
      replayed: true,
    };
  }
  const providerWasInvoked =
    checkpoint === 'after-provider-invocation-before-operation-persistence';
  return {
    beforeRecoveryAttempts: 1,
    beforeRecoveryOperations: 0,
    beforeRecoveryInvocations: providerWasInvoked ? 1 : 0,
    beforeRecoveryReconciliation:
      checkpoint === 'after-claim-commit'
        ? 'NOT_STARTED'
        : 'INVOKING',
    beforeRecoveryReconciliationRequired: true,
    finalOperations: 0,
    finalInvocations: providerWasInvoked ? 1 : 0,
    finalCallbackBindings: 0,
    finalAttemptState: 'QUEUED',
    resultStatus: checkpoint === 'after-claim-commit' ? 'failed_before_provider' : 'uncertain',
    finalReconciliation:
      checkpoint === 'after-claim-commit'
        ? 'FAILED_BEFORE_PROVIDER'
        : 'UNKNOWN',
    reconciliationRequired: checkpoint !== 'after-claim-commit',
    replayed: false,
  };
}

describe('W402 direct initiation recovery in child processes', () => {
  beforeAll(async () => {
    const { databaseUrl, redisUrl } = assertEnvironment();
    prisma = createDatabaseClient(databaseUrl, { log: [] });
    redis = createRedisClient(redisUrl);
    const rows = await prisma.$queryRaw<Array<{ database_name: string }>>`
      SELECT current_database() AS database_name`;
    if (rows[0]?.database_name !== 'truevine_w402_integration_test') {
      throw new Error('Connected PostgreSQL database did not match the W402 integration target.');
    }
    await redis.ping();
  }, 30_000);

  afterAll(async () => {
    try {
      for (const child of runningChildren) {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      }
      if (runningChildren.size > 0) {
        await Promise.all(
          [...runningChildren].map(
            (child) =>
              new Promise<void>((resolve) => {
                child.once('close', () => resolve());
              }),
          ),
        );
      }
      if (ledgerKeys.length > 0 && typeof redis !== 'undefined') await redis.del(...ledgerKeys);
    } finally {
      if (typeof redis !== 'undefined') redis.disconnect();
      if (typeof prisma !== 'undefined') await prisma.$disconnect();
    }
  }, 30_000);

  it.each(crashCheckpoints)(
    'initiates once, persists, or fails closed after interruption at %s',
    async (checkpointName) => {
      const graph = await createW402Fixtures(prisma);
      const runId = randomUUID();
      const invocationKey = `w402:recovery:${runId}:invocations`;
      ledgerKeys.push(invocationKey);
      await redis.del(invocationKey);

      const expected = expectedOutcome(checkpointName);
      const baseEnvironment: NodeJS.ProcessEnv = {
        ...process.env,
        NODE_ENV: 'test',
        W402_RUN_ID: runId,
        W402_ORGANIZATION_ID: graph.organizationId,
        W402_CAMPAIGN_ID: graph.campaignId,
        W402_RECIPIENT_ID: graph.recipientId,
      };

      try {
        const initial = await readPersistedState(graph, invocationKey);
        expect(initial.attempts).toHaveLength(0);
        expect(initial.operations).toHaveLength(0);
        expect(initial.reconciliation).toBeNull();
        expect(initial.invocations).toHaveLength(0);

        const workerA = await runCrashChild(
          { ...baseEnvironment, W402_CRASH_CHECKPOINT: checkpointName },
          checkpointName,
        );
        const afterCrash = await waitForPersistedCounts(
          graph,
          invocationKey,
          expected.beforeRecoveryAttempts,
          expected.beforeRecoveryOperations,
        );
        expect(afterCrash.invocations).toHaveLength(expected.beforeRecoveryInvocations);
        expect(afterCrash.reconciliation?.status ?? null).toBe(expected.beforeRecoveryReconciliation);

        const reconciliationService = new CallInitiationReconciliationService(prisma as never);
        const discovered = await reconciliationService.listRequired(graph.organizationId);
        if (expected.beforeRecoveryReconciliationRequired) {
          expect(discovered.map((record) => record.status)).toContain(
            expected.beforeRecoveryReconciliation,
          );
        } else {
          expect(discovered).toHaveLength(0);
        }

        const workerB = await runRecoveryChild({
          ...baseEnvironment,
          W402_CRASH_CHECKPOINT: '',
        });
        expect(workerB.pid).not.toBe(workerA.pid);
        const finalState = await readPersistedState(graph, invocationKey);
        expect(finalState.attempts).toHaveLength(1);
        expect(finalState.operations).toHaveLength(expected.finalOperations);
        expect(finalState.invocations).toHaveLength(expected.finalInvocations);
        expect(finalState.attempts[0]?.state).toBe(expected.finalAttemptState);
        expect(workerB.result.status).toBe(expected.resultStatus);
        expect(finalState.callbackBindingCount).toBe(expected.finalCallbackBindings);
        expect(finalState.reconciliation).toEqual({
          status: expected.finalReconciliation,
          reconciliationRequired: expected.reconciliationRequired,
        });
        if (checkpointName !== 'before-claim-commit') {
          expect(finalState.invocations).toHaveLength(afterCrash.invocations.length);
        }

        const attempt = finalState.attempts[0];
        if (!attempt) throw new Error('Recovery did not persist the expected logical attempt.');
        expect(workerB.result.attemptId).toBe(attempt.id);
        if (expected.resultStatus === 'initiated') {
          expect(workerB.result.providerCallId).toBe(`fake-${attempt.id}`);
          expect(workerB.result.replayed).toBe(expected.replayed);
          const operation = finalState.operations[0];
          if (!operation) throw new Error('Successful initiation did not persist its operation.');
          const canonical = canonicalCampaignCallInitiation({
            organizationId: graph.organizationId,
            campaignId: graph.campaignId,
            recipientId: graph.recipientId,
            attemptId: attempt.id,
            attemptNumber: attempt.attemptNumber,
            destination: attempt.destination,
            bindingSource: BINDING_SOURCE,
          });
          expect(operation).toEqual({
            operation: canonical.operation,
            key: canonical.idempotencyKey,
            fingerprintVersion: canonical.fingerprintVersion,
            fingerprint: canonical.fingerprint,
            attemptId: attempt.id,
            result: { providerCallId: `fake-${attempt.id}`, bindingSource: BINDING_SOURCE },
          });
          expect(finalState.callbackBindingCount).toBe(1);
        } else {
          expect(workerB.result.replayed).toBeUndefined();
          expect(finalState.operations).toHaveLength(0);
          expect(finalState.callbackBindingCount).toBe(0);
        }

        for (const invocation of finalState.invocations) {
          expect(invocation.organizationId).toBe(graph.organizationId);
          expect(invocation.attemptId).toBe(attempt.id);
          expect(invocation.idempotencyKey).toBe(
            `${graph.organizationId}:${graph.campaignId}:${graph.recipientId}:${attempt.attemptNumber}`,
          );
        }
        const firstReconciliation = await reconciliationService.reconcileAttempt(
          graph.organizationId,
          attempt.id,
        );
        const secondReconciliation = await reconciliationService.reconcileAttempt(
          graph.organizationId,
          attempt.id,
        );
        expect(secondReconciliation).toEqual(firstReconciliation);
        expect(firstReconciliation.reconciliationRequired).toBe(expected.reconciliationRequired);
        const afterRepeatedReconciliation = await readPersistedState(graph, invocationKey);
        expect(afterRepeatedReconciliation.attempts).toEqual(finalState.attempts);
        expect(afterRepeatedReconciliation.operations).toEqual(finalState.operations);
        expect(afterRepeatedReconciliation.callbackBindingCount).toBe(finalState.callbackBindingCount);
        expect(afterRepeatedReconciliation.invocations).toEqual(finalState.invocations);
        expect(afterRepeatedReconciliation.reconciliation).toEqual(finalState.reconciliation);
        if (checkpointName === 'before-claim-commit') {
          expect(finalState.invocations[0]?.pid).toBe(workerB.pid);
        }
        if (checkpointName === 'after-provider-invocation-before-operation-persistence') {
          expect(finalState.invocations[0]?.pid).toBe(workerA.pid);
        }
        if (checkpointName === 'after-operation-commit') {
          expect(finalState.invocations[0]?.pid).toBe(workerA.pid);
        }

        const evidence = {
          checkpoint: checkpointName,
          workerAPid: workerA.pid,
          workerAExit: { code: workerA.exit.code, signal: workerA.exit.signal },
          workerBPid: workerB.pid,
          workerBExit: { code: workerB.exit.code, signal: workerB.exit.signal },
          callAttemptCount: finalState.attempts.length,
          callAttemptState: finalState.attempts[0]?.state,
          callOperationCount: finalState.operations.length,
          callbackBindingCount: finalState.callbackBindingCount,
          reconciliation: finalState.reconciliation,
          reconciliationIdempotent: firstReconciliation.status === secondReconciliation.status,
          fakeInvocationCount: finalState.invocations.length,
          recoveryResult: workerB.result,
          recoveryOutcome:
            workerB.result.status === 'initiated'
              ? workerB.result.replayed
                ? 'replayed persisted initiation without another provider invocation'
                : 'initiated and persisted once after claim rollback'
              : workerB.result.status === 'failed_before_provider'
                ? 'confirmed no provider invocation; no retry'
                : 'unknown provider outcome; reconciliation required; no duplicate initiation',
        };
        process.stdout.write(`W402_RECOVERY_EVIDENCE ${JSON.stringify(evidence)}\n`);
      } finally {
        await cleanupW402Fixtures(prisma, graph);
      }
    },
    60_000,
  );
});
