import process from 'node:process';
import { setTimeout as sleep } from 'node:timers/promises';
import { URL } from 'node:url';

import { createDatabaseClient } from '@truevine/database';
import { createRedisClient } from '@truevine/queue';
import { CALLBACK_SOURCES, FakeVoiceAdapter } from '@truevine/telephony';

import { CampaignExecutionClaimService } from '../dist/campaigns/campaign-execution-claim.service.js';
import { CampaignCallInitiationService } from '../dist/campaigns/campaign-call-initiation.service.js';
import { CallInitiationReconciliationService } from '../dist/campaigns/call-initiation-reconciliation.service.js';
import { CampaignExecutionProcessor } from '../dist/campaigns/campaign-execution.processor.js';
import { loadWorkerConfig } from '../dist/config/worker.config.js';
import { SyntheticDispatchCostPolicy } from '../dist/reliability/dispatch-cost-policy.js';
import { DispatchGuard } from '../dist/reliability/dispatch-guard.service.js';

const RESERVE_MINOR = 1000n;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const checkpoints = new Set([
  'before-claim-commit',
  'after-claim-commit',
  'before-provider-invocation',
  'after-provider-invocation-before-operation-persistence',
  'after-operation-commit',
]);
const faultModes = new Set(['', 'db-before-provider', 'db-after-provider']);
const checkpointName = process.env.W601_CRASH_CHECKPOINT ?? '';
const gateCheckpoint = process.env.W601_GATE_CHECKPOINT ?? '';
const faultMode = process.env.W601_FAULT_MODE ?? '';
const queueName = process.env.CAMPAIGN_EXECUTION_QUEUE_NAME ?? '';
const invocationKey = process.env.W601_INVOCATION_KEY ?? '';
const gateKey = process.env.W601_GATE_KEY ?? '';
let checkpointReached = false;
let prisma;
let redis;
let processor;

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

function validateEnvironment() {
  const redisFailure = faultMode === '' && process.env.W601_REDIS_FAILURE === '1';

  if (process.env.NODE_ENV !== 'test') throw new Error('W6-01 child requires NODE_ENV=test.');

  const database = new URL(required('DATABASE_URL'));
  const routeParameters = ['host', 'hostaddr', 'port', 'database', 'dbname'];
  if (
    !['postgres:', 'postgresql:'].includes(database.protocol) ||
    !['localhost', '127.0.0.1', '::1', '[::1]'].includes(database.hostname) ||
    database.port !== '55434' ||
    database.pathname !== '/truevine_w601_qa' ||
    database.hash ||
    routeParameters.some((parameter) => database.searchParams.has(parameter))
  ) {
    throw new Error('W6-01 child requires the local truevine_w601_qa database.');
  }

  const redisTarget = new URL(required('REDIS_URL'));
  const expectedRedisPort = redisFailure ? '56383' : '56382';
  if (
    redisTarget.protocol !== 'redis:' ||
    !['localhost', '127.0.0.1', '::1', '[::1]'].includes(redisTarget.hostname) ||
    redisTarget.port !== expectedRedisPort
  ) {
    throw new Error(`W6-01 child requires local test Redis on port ${expectedRedisPort}.`);
  }

  if (!queueName.startsWith('w601-')) {
    throw new Error('W6-01 child requires a unique w601-* campaign queue.');
  }
  if (!uuidPattern.test(required('W601_RUN_ID'))) {
    throw new Error('W601_RUN_ID must be a UUID.');
  }
  if (!invocationKey.startsWith('w601:bullmq:')) {
    throw new Error('W6-01 child requires a test-owned invocation ledger key.');
  }
  if (checkpointName && !checkpoints.has(checkpointName)) {
    throw new Error('Unknown W6-01 crash checkpoint.');
  }
  if (gateCheckpoint && !checkpoints.has(gateCheckpoint)) {
    throw new Error('Unknown W6-01 gate checkpoint.');
  }
  if (!faultModes.has(faultMode)) throw new Error('Unknown W6-01 fault mode.');
  if (redisFailure && !gateKey && !invocationKey) {
    throw new Error('Redis failure run still requires an evidence key.');
  }
}

function emit(prefix, payload) {
  process.stdout.write(`${prefix} ${JSON.stringify(payload)}\n`);
}

async function failWithin(promise, timeoutMs, label) {
  return await Promise.race([
    promise,
    sleep(timeoutMs).then(() => {
      throw new Error(`${label} timed out after ${timeoutMs}ms.`);
    }),
  ]);
}

async function checkpoint(name) {
  if (checkpointName === name) {
    if (checkpointReached) throw new Error(`W601 checkpoint ${name} was reached more than once.`);
    checkpointReached = true;
    emit('W601_CHECKPOINT', { checkpoint: name, pid: process.pid });
    await new Promise(() => {});
  }
  if (gateCheckpoint !== name) return;
  emit('W601_CHECKPOINT', { checkpoint: name, pid: process.pid, gated: true });
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (!gateKey) throw new Error('W601_GATE_KEY is required for a gated checkpoint.');
    if ((await redis.get(gateKey)) === 'release') return;
    await sleep(50);
  }
  throw new Error(`W601 gate at ${name} timed out.`);
}

function createClaimClient(client) {
  return new Proxy(client, {
    get(target, property) {
      if (property === '$transaction') {
        return (work, ...options) =>
          target.$transaction(
            async (tx) => {
              const result = await work(tx);
              await checkpoint('before-claim-commit');
              return result;
            },
            ...options,
          );
      }

      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

function createInitiationClient(client, mode) {
  return new Proxy(client, {
    get(target, property) {
      if (property === '$transaction') {
        return async (work, ...options) => {
          let confirmedOperationCreated = false;
          const result = await target.$transaction(
            async (tx) => {
              const txClient = new Proxy(tx, {
                get(txTarget, txProperty) {
                  if (txProperty === '$queryRaw' && mode === 'db-before-provider') {
                    return () => {
                      throw new Error('W601_TEST_DB_FAILURE_BEFORE_PROVIDER');
                    };
                  }
                  if (txProperty === 'callOperation') {
                    return new Proxy(txTarget.callOperation, {
                      get(delegate, method) {
                        if (method === 'create') {
                          return async (input) => {
                            if (mode === 'db-after-provider' && input?.data?.result?.providerCallId) {
                              throw new Error('W601_TEST_DB_FAILURE_AFTER_PROVIDER');
                            }
                            const create = Reflect.get(delegate, method, delegate);
                            const created = await create.call(delegate, input);
                            confirmedOperationCreated = Boolean(input?.data?.result?.providerCallId);
                            return created;
                          };
                        }
                        const value = Reflect.get(delegate, method, delegate);
                        return typeof value === 'function' ? value.bind(delegate) : value;
                      },
                    });
                  }
                  const value = Reflect.get(txTarget, txProperty, txTarget);
                  return typeof value === 'function' ? value.bind(txTarget) : value;
                },
              });
              return work(txClient);
            },
            ...options,
          );
          if (confirmedOperationCreated) await checkpoint('after-operation-commit');
          return result;
        };
      }

      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

class CheckpointClaimService extends CampaignExecutionClaimService {
  async claim(input) {
    const result = await super.claim(input);
    if (result.status === 'claimed') await checkpoint('after-claim-commit');
    return result;
  }
}

async function updateMaximumActive(activeKey, maximumKey) {
  await redis.eval(
    "local active = tonumber(redis.call('GET', KEYS[1]) or '0'); " +
      "local maximum = tonumber(redis.call('GET', KEYS[2]) or '0'); " +
      "if active > maximum then redis.call('SET', KEYS[2], active) end; return active",
    2,
    activeKey,
    maximumKey,
  );
}

function installTestInstrumentation(worker) {
  const originalProcess = worker.process.bind(worker);
  const startsKey = process.env.W601_STARTS_KEY;
  const activeKey = process.env.W601_ACTIVE_KEY;
  const maximumActiveKey = process.env.W601_MAX_ACTIVE_KEY;
  const failuresKey = process.env.W601_FAILURES_KEY;
  const failFirst = Number(process.env.W601_FAIL_FIRST_N ?? '0');
  const delayMs = Number(process.env.W601_PROCESS_DELAY_MS ?? '0');

  if (!Number.isInteger(failFirst) || failFirst < 0 || !Number.isInteger(delayMs) || delayMs < 0) {
    throw new Error('Invalid W6-01 test instrumentation settings.');
  }

  worker.process = async (data) => {
    if (startsKey) {
      await redis.rpush(startsKey, JSON.stringify({ at: Date.now(), pid: process.pid }));
    }

    let activeTracked = false;
    if (activeKey && maximumActiveKey) {
      await redis.incr(activeKey);
      await updateMaximumActive(activeKey, maximumActiveKey);
      activeTracked = true;
    }

    try {
      if (failuresKey) {
        const attempt = await redis.incr(failuresKey);
        if (attempt <= failFirst) throw new Error('W601_TEST_TRANSIENT_BEFORE_CAMPAIGN_PROCESSOR');
      }
      if (delayMs > 0) await sleep(delayMs);
      return await originalProcess(data);
    } finally {
      if (activeTracked) await redis.decr(activeKey);
    }
  };
}

async function recordInvocation(request, result) {
  const entry = {
    organizationId: request.organizationId,
    attemptId: request.callId,
    idempotencyKey: request.idempotencyKey,
    providerCallId: result.providerCallId,
    pid: process.pid,
  };
  emit('W601_INVOCATION', entry);
  await redis.rpush(invocationKey, JSON.stringify(entry));
}

async function markExternalUncertain(organizationId, attemptId) {
  const rows = await prisma.callInitiationReconciliation.findMany({
    where: { organizationId, attemptId },
    select: { status: true },
  });
  const status = rows[0]?.status;
  if (!status || status === 'UNKNOWN' || status === 'CONFIRMED') return;
  if (status === 'NOT_STARTED') {
    await prisma.callInitiationReconciliation.updateMany({
      where: { organizationId, attemptId, status: 'NOT_STARTED' },
      data: { status: 'INVOKING' },
    });
  }
  await prisma.callInitiationReconciliation.updateMany({
    where: { organizationId, attemptId, status: 'INVOKING' },
    data: { status: 'UNKNOWN', reconciliationRequired: true },
  });
}

async function cleanup() {
  try {
    await processor?.onApplicationShutdown();
    if (prisma) await prisma.$disconnect();
    if (redis) redis.disconnect();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
    throw error;
  }
}

async function main() {
  validateEnvironment();
  const config = loadWorkerConfig(process.env);
  prisma = createDatabaseClient(config.databaseUrl, { log: [] });
  redis = createRedisClient(config.redisUrl);

  const databaseRows = await prisma.$queryRaw`SELECT current_database() AS database_name`;
  if (databaseRows[0]?.database_name !== 'truevine_w601_qa') {
    throw new Error('Connected PostgreSQL database did not match the W6-01 QA target.');
  }
  await failWithin(redis.ping(), 3_000, 'W6-01 Redis readiness probe');

  const claimService = new CheckpointClaimService(createClaimClient(prisma));
  const reconciliation = new CallInitiationReconciliationService(prisma);
  const fake = new FakeVoiceAdapter();
  const voice = {
    async initiateCall(request) {
      await checkpoint('before-provider-invocation');
      const fakeResult = await fake.initiateCall(request);
      // FakeVoiceAdapter returns a fixed session id. Use a stable, attempt-scoped
      // id so independent test campaigns never collide on the callback binding
      // uniqueness constraint. Replays of the same attempt keep the same id.
      const result = { ...fakeResult, providerCallId: `fake-${request.callId}` };
      await recordInvocation(request, result);
      await checkpoint('after-provider-invocation-before-operation-persistence');
      return result;
    },
    async hangUp(request) {
      return fake.hangUp(request);
    },
    async fetchCallStatus(callId) {
      return fake.fetchCallStatus(callId);
    },
  };

  const initiation = new CampaignCallInitiationService(
    claimService,
    voice,
    createInitiationClient(prisma, faultMode),
    CALLBACK_SOURCES.fake,
    reconciliation,
    new DispatchGuard(new SyntheticDispatchCostPolicy(RESERVE_MINOR)),
  );
  const rawInitiate = initiation.initiate.bind(initiation);
  const instrumentedInitiation = {
    async initiate(input) {
      const result = await rawInitiate(input);
      if (faultMode === 'db-after-provider' && result.status === 'uncertain') {
        // The aborted transaction cannot persist the conservative marker. Write
        // it from a separate committed statement only after the transaction has
        // released the row locks.
        await markExternalUncertain(input.organizationId, result.attemptId);
      }
      return result;
    },
  };
  processor = new CampaignExecutionProcessor(
    redis,
    prisma,
    config,
    instrumentedInitiation,
    'w601-test',
  );
  installTestInstrumentation(processor);
  processor.onApplicationBootstrap();
  await processor.waitUntilReady();
  emit('W601_READY', { pid: process.pid, queueName });
}

main().catch(async (error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  try {
    await cleanup();
  } catch {
    // The startup error remains the process failure; cleanup errors are already written.
  }
  process.exitCode = 1;
});
