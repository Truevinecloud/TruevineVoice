import process from 'node:process';
import { URL } from 'node:url';
import { createDatabaseClient } from '@truevine/database';
import { createRedisClient } from '@truevine/queue';
import { CampaignExecutionClaimService } from '../dist/campaigns/campaign-execution-claim.service.js';
import { CampaignCallInitiationService } from '../dist/campaigns/campaign-call-initiation.service.js';
import { CallInitiationReconciliationService } from '../dist/campaigns/call-initiation-reconciliation.service.js';
import { SyntheticDispatchCostPolicy } from '../dist/reliability/dispatch-cost-policy.js';
import { DispatchGuard } from '../dist/reliability/dispatch-guard.service.js';

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const checkpoints = new Set([
  'before-claim-commit',
  'after-claim-commit',
  'before-provider-invocation',
  'after-provider-invocation-before-operation-persistence',
  'after-operation-commit',
]);
const checkpointName = process.env.W402_CRASH_CHECKPOINT ?? '';
let checkpointReached = false;

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

function verifyEnvironment() {
  if (process.env.NODE_ENV !== 'test') throw new Error('Recovery child requires NODE_ENV=test.');

  const database = new URL(required('DATABASE_URL'));
  if (
    database.protocol !== 'postgresql:' ||
    database.hostname !== 'localhost' ||
    database.port !== '55432' ||
    database.pathname !== '/truevine_w402_integration_test'
  ) {
    throw new Error('Recovery child requires the local truevine_w402_integration_test database.');
  }

  const redis = new URL(required('REDIS_URL'));
  if (
    redis.protocol !== 'redis:' ||
    !['localhost', '127.0.0.1', '::1'].includes(redis.hostname) ||
    redis.port !== '56379'
  ) {
    throw new Error('Recovery child requires the local W402 test Redis on port 56379.');
  }

  for (const name of ['W402_RUN_ID', 'W402_ORGANIZATION_ID', 'W402_CAMPAIGN_ID', 'W402_RECIPIENT_ID']) {
    if (!uuidPattern.test(required(name))) throw new Error(`${name} must be a UUID.`);
  }

  if (checkpointName && !checkpoints.has(checkpointName)) {
    throw new Error('Unknown W402 crash checkpoint.');
  }
}

async function checkpoint(name) {
  if (checkpointName !== name) return;
  if (checkpointReached) throw new Error(`W402 checkpoint ${name} was reached more than once.`);
  checkpointReached = true;
  process.stdout.write(`W402_CHECKPOINT ${JSON.stringify({ checkpoint: name, pid: process.pid })}\n`);
  await new Promise(() => {});
}

function createInitiationClient(prisma) {
  return new Proxy(prisma, {
    get(target, property) {
      if (property === '$transaction') {
        return async (work, ...options) => {
          let operationCreated = false;
          const result = await target.$transaction(
            async (tx) => {
              const txClient = new Proxy(tx, {
                get(txTarget, txProperty) {
                  if (txProperty === 'callOperation') {
                    return new Proxy(txTarget.callOperation, {
                      get(delegate, method) {
                        if (method === 'create') {
                          return async (input) => {
                            if (input?.data?.result?.providerCallId) {
                              await checkpoint('after-provider-invocation-before-operation-persistence');
                            }
                            const create = Reflect.get(delegate, method, delegate);
                            const created = await create.call(delegate, input);
                            operationCreated = true;
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
          if (operationCreated) await checkpoint('after-operation-commit');
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

async function main() {
  verifyEnvironment();

  const databaseUrl = process.env.DATABASE_URL;
  const redisUrl = process.env.REDIS_URL;
  const runId = process.env.W402_RUN_ID;
  const organizationId = process.env.W402_ORGANIZATION_ID;
  const campaignId = process.env.W402_CAMPAIGN_ID;
  const recipientId = process.env.W402_RECIPIENT_ID;
  const ledgerKey = `w402:recovery:${runId}:invocations`;
  const prisma = createDatabaseClient(databaseUrl, { log: [] });
  const redis = createRedisClient(redisUrl);

  try {
    await redis.ping();
    const recipient = await prisma.campaignRecipient.findUnique({
      where: { organizationId_id: { organizationId, id: recipientId } },
    });
    if (!recipient || recipient.campaignId !== campaignId) {
      throw new Error('The tenant-scoped W402 recipient fixture was not found.');
    }

    const claimPrisma = {
      callAttempt: prisma.callAttempt,
      $transaction: (work, ...options) =>
        prisma.$transaction(
          async (tx) => {
            const result = await work(tx);
            await checkpoint('before-claim-commit');
            return result;
          },
          ...options,
        ),
    };
    const claimService = new CheckpointClaimService(claimPrisma);
    const reconciliation = new CallInitiationReconciliationService(prisma);

    const voice = {
      async initiateCall(request) {
        await checkpoint('before-provider-invocation');
        await redis.rpush(
          ledgerKey,
          JSON.stringify({
            organizationId: request.organizationId,
            attemptId: request.callId,
            idempotencyKey: request.idempotencyKey,
            pid: process.pid,
          }),
        );
        return {
          callId: request.callId,
          state: 'DIALING',
          providerCallId: `fake-${request.callId}`,
          replayed: false,
        };
      },
      async hangUp() {
        throw new Error('W402 fake port does not implement hangUp.');
      },
      async fetchCallStatus() {
        throw new Error('W402 fake port does not implement fetchCallStatus.');
      },
    };

    const initiation = new CampaignCallInitiationService(
      claimService,
      voice,
      createInitiationClient(prisma),
      'w402-recovery-test',
      reconciliation,
      new DispatchGuard(new SyntheticDispatchCostPolicy(0n)),
    );
    const result = await initiation.initiate({
      organizationId,
      campaignId,
      recipientId,
    });
    process.stdout.write(`W402_RESULT ${JSON.stringify({ pid: process.pid, result })}\n`);
  } finally {
    redis.disconnect();
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
