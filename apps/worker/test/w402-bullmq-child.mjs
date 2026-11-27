import process from 'node:process';
import { setTimeout as sleep } from 'node:timers/promises';
import { URL } from 'node:url';
import { createDatabaseClient } from '@truevine/database';
import { FakeVoiceAdapter } from '@truevine/telephony';
import { createRedisClient } from '@truevine/queue';
import { CampaignExecutionClaimService } from '../dist/campaigns/campaign-execution-claim.service.js';
import { CampaignCallInitiationService } from '../dist/campaigns/campaign-call-initiation.service.js';
import { CallInitiationReconciliationService } from '../dist/campaigns/call-initiation-reconciliation.service.js';
import { CampaignExecutionProcessor } from '../dist/campaigns/campaign-execution.processor.js';
import { SyntheticDispatchCostPolicy } from '../dist/reliability/dispatch-cost-policy.js';
import { DispatchGuard } from '../dist/reliability/dispatch-guard.service.js';
import { loadWorkerConfig } from '../dist/config/worker.config.js';

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const checkpoints = new Set([
  'before-claim-commit',
  'after-claim-commit',
  'before-provider-invocation',
  'after-provider-invocation-before-operation-persistence',
  'after-operation-commit',
]);
const checkpointName = process.env.W402_CRASH_CHECKPOINT ?? '';
const queueName = process.env.CAMPAIGN_EXECUTION_QUEUE_NAME ?? '';
const invocationKey = process.env.W402_INVOCATION_KEY ?? '';
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
  if (process.env.NODE_ENV !== 'test') throw new Error('BullMQ child requires NODE_ENV=test.');

  const database = new URL(required('DATABASE_URL'));
  const routeParameters = ['host', 'hostaddr', 'port', 'database', 'dbname'];
  if (
    !['postgres:', 'postgresql:'].includes(database.protocol) ||
    !['localhost', '127.0.0.1', '::1', '[::1]'].includes(database.hostname) ||
    database.port !== '55432' ||
    database.pathname !== '/truevine_w402_integration_test' ||
    database.hash ||
    routeParameters.some((parameter) => database.searchParams.has(parameter))
  ) {
    throw new Error('BullMQ child requires the local truevine_w402_integration_test database.');
  }

  const redisTarget = new URL(required('REDIS_URL'));
  if (
    redisTarget.protocol !== 'redis:' ||
    !['localhost', '127.0.0.1', '::1', '[::1]'].includes(redisTarget.hostname) ||
    redisTarget.port !== '56379'
  ) {
    throw new Error('BullMQ child requires local W402 Redis on port 56379.');
  }

  if (!queueName.startsWith('w402-')) {
    throw new Error('BullMQ child requires a unique w402-* campaign queue.');
  }
  if (!uuidPattern.test(required('W402_RUN_ID'))) {
    throw new Error('W402_RUN_ID must be a UUID.');
  }
  if (!invocationKey.startsWith('w402:bullmq:')) {
    throw new Error('BullMQ child requires a test-owned invocation ledger key.');
  }
  if (checkpointName && !checkpoints.has(checkpointName)) {
    throw new Error('Unknown W402 BullMQ crash checkpoint.');
  }
}

async function checkpoint(name) {
  if (checkpointName !== name) return;
  if (checkpointReached) throw new Error(`W402 checkpoint ${name} was reached more than once.`);
  checkpointReached = true;
  process.stdout.write(`W402_CHECKPOINT ${JSON.stringify({ checkpoint: name, pid: process.pid })}\n`);
  await new Promise(() => {});
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

function createInitiationClient(client) {
  return new Proxy(client, {
    get(target, property) {
      if (property === '$transaction') {
        return async (work, ...options) => {
          let confirmedOperationCreated = false;
          const result = await target.$transaction(
            async (tx) => {
              const txClient = new Proxy(tx, {
                get(txTarget, txProperty) {
                  if (txProperty === 'callOperation') {
                    return new Proxy(txTarget.callOperation, {
                      get(delegate, method) {
                        if (method === 'create') {
                          return async (input) => {
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
  const startsKey = process.env.W402_STARTS_KEY;
  const activeKey = process.env.W402_ACTIVE_KEY;
  const maximumActiveKey = process.env.W402_MAX_ACTIVE_KEY;
  const failuresKey = process.env.W402_FAILURES_KEY;
  const failFirst = Number(process.env.W402_FAIL_FIRST_N ?? '0');
  const failAlways = process.env.W402_FAIL_ALWAYS === '1';
  const delayMs = Number(process.env.W402_PROCESS_DELAY_MS ?? '0');

  if (!Number.isInteger(failFirst) || failFirst < 0 || !Number.isInteger(delayMs) || delayMs < 0) {
    throw new Error('Invalid W402 test instrumentation settings.');
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
        if (failAlways || attempt <= failFirst) {
          throw new Error('W402_TEST_TRANSIENT_BEFORE_CAMPAIGN_PROCESSOR');
        }
      }
      if (delayMs > 0) await sleep(delayMs);
      return await originalProcess(data);
    } finally {
      if (activeTracked) await redis.decr(activeKey);
    }
  };
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
  if (databaseRows[0]?.database_name !== 'truevine_w402_integration_test') {
    throw new Error('Connected PostgreSQL database did not match the W402 integration target.');
  }
  await redis.ping();

  const claimService = new CheckpointClaimService(createClaimClient(prisma));
  const reconciliation = new CallInitiationReconciliationService(prisma);
  const fake = new FakeVoiceAdapter();
  const voice = {
    async initiateCall(request) {
      await checkpoint('before-provider-invocation');
      const result = await fake.initiateCall(request);
      await redis.rpush(
        invocationKey,
        JSON.stringify({
          organizationId: request.organizationId,
          attemptId: request.callId,
          idempotencyKey: request.idempotencyKey,
          providerCallId: result.providerCallId,
          pid: process.pid,
        }),
      );
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
    createInitiationClient(prisma),
    `w402-bullmq-${process.env.W402_RUN_ID}`,
    reconciliation,
    new DispatchGuard(new SyntheticDispatchCostPolicy(0n)),
  );
  processor = new CampaignExecutionProcessor(redis, prisma, config, initiation, 'w402-test');
  installTestInstrumentation(processor);
  processor.onApplicationBootstrap();
  await processor.waitUntilReady();
  process.stdout.write(`W402_READY ${JSON.stringify({ pid: process.pid, queueName })}\n`);
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
