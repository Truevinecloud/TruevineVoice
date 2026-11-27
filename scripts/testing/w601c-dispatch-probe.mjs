/**
 * Long-running W6-01C dispatch probe.
 *
 * Uses the accepted compiled worker services against the dedicated W6-01C QA
 * database and Redis. The only instrumentation is a fake adapter subclass that
 * records genuine provider invocations in Redis; it never calls a real provider.
 */

import { randomUUID } from 'node:crypto';
import process from 'node:process';
import { URL } from 'node:url';

import { createDatabaseClient } from '@truevine/database';
import { createRedisClient } from '@truevine/queue';
import { CALLBACK_SOURCES, FakeVoiceAdapter } from '@truevine/telephony';

const DETAIL_KEY = 'w601c:provider-invocations:detail';
const GLOBAL_COUNT_KEY = 'w601c:provider-invocations:all';
const ORG_COUNT_KEY = (organizationId) => `w601c:provider-invocations:org:${organizationId}`;

function validateTarget() {
  const database = new URL(process.env['DATABASE_URL'] ?? '');
  if (
    !['postgres:', 'postgresql:'].includes(database.protocol) ||
    !['localhost', '127.0.0.1', '::1', '[::1]'].includes(database.hostname) ||
    database.port !== '55435' ||
    database.pathname !== '/truevine_w601c_qa' ||
    ['host', 'hostaddr', 'port', 'database', 'dbname'].some((key) => database.searchParams.has(key))
  ) {
    throw new Error('W6-01C probe refuses every database except truevine_w601c_qa on loopback 55435.');
  }
  const redis = new URL(process.env['REDIS_URL'] ?? '');
  if (
    redis.protocol !== 'redis:' ||
    !['localhost', '127.0.0.1', '::1', '[::1]'].includes(redis.hostname) ||
    redis.port !== '56385'
  ) {
    throw new Error('W6-01C probe requires Redis on loopback port 56385.');
  }
  if (process.env['AT_VOICE_PROVIDER'] === 'true' || process.env['NODE_ENV'] === 'production') {
    throw new Error('W6-01C probe refuses a real provider or production environment.');
  }
  const queueName = process.env['CAMPAIGN_EXECUTION_QUEUE_NAME'] ?? '';
  if (!queueName.startsWith('w601c-')) {
    throw new Error('W6-01C probe requires a unique w601c-* queue.');
  }
}

class CountingFakeVoiceAdapter extends FakeVoiceAdapter {
  constructor(redis) {
    super();
    this.redis = redis;
  }

  async initiateCall(request) {
    const result = await super.initiateCall(request);
    if (!result.replayed) {
      // Each probe process gets an isolated provider-call namespace: a restart
      // must never collide with a callback binding created by an earlier run.
      const providerCallId = `fake-${randomUUID()}`;
      const detail = {
        at: new Date().toISOString(),
        organizationId: request.organizationId,
        destination: request.to,
        callId: request.callId,
        idempotencyKey: request.idempotencyKey,
        providerCallId,
        pid: process.pid,
      };
      await this.redis.incr(GLOBAL_COUNT_KEY);
      await this.redis.incr(ORG_COUNT_KEY(request.organizationId));
      await this.redis.rpush(DETAIL_KEY, JSON.stringify(detail));
      return { ...result, providerCallId };
    }
    return result;
  }
}

let processor;
let database;
let redis;

async function shutdown(signal) {
  try {
    await processor?.onApplicationShutdown();
    redis?.disconnect();
    await database?.$disconnect();
    process.stdout.write(`${JSON.stringify({ event: 'W601C_PROBE_STOPPED', signal })}\n`);
  } catch (error) {
    process.stderr.write(`W6-01C probe shutdown error: ${error instanceof Error ? error.message : String(error)}\n`);
  } finally {
    process.exit(0);
  }
}

async function main() {
  validateTarget();
  process.env['CAMPAIGN_EXECUTION_MODE'] = 'local';
  process.env['AT_VOICE_PROVIDER'] = 'false';

  database = createDatabaseClient(process.env['DATABASE_URL'], { log: [] });
  redis = createRedisClient(process.env['REDIS_URL']);

  const workerModule = await import('../../apps/worker/dist/campaigns/campaign-execution.processor.js');
  const initiationModule = await import('../../apps/worker/dist/campaigns/campaign-call-initiation.service.js');
  const reconciliationModule = await import('../../apps/worker/dist/campaigns/call-initiation-reconciliation.service.js');
  const claimModule = await import('../../apps/worker/dist/campaigns/campaign-execution-claim.service.js');
  const guardModule = await import('../../apps/worker/dist/reliability/dispatch-guard.service.js');
  const policyModule = await import('../../apps/worker/dist/reliability/dispatch-cost-policy.js');

  const claim = new claimModule.CampaignExecutionClaimService(database);
  const reconciliation = new reconciliationModule.CallInitiationReconciliationService(database);
  const guard = new guardModule.DispatchGuard(new policyModule.SyntheticDispatchCostPolicy(1_000n));
  const voice = new CountingFakeVoiceAdapter(redis);
  const initiation = new initiationModule.CampaignCallInitiationService(
    claim,
    voice,
    database,
    CALLBACK_SOURCES.fake,
    reconciliation,
    guard,
  );
  processor = new workerModule.CampaignExecutionProcessor(
    redis,
    database,
    undefined,
    initiation,
    'local',
  );
  processor.onApplicationBootstrap();
  await processor.waitUntilReady();

  process.stdout.write(
    `${JSON.stringify({
      event: 'W601C_PROBE_READY',
      pid: process.pid,
      queue: process.env['CAMPAIGN_EXECUTION_QUEUE_NAME'],
      database: 'truevine_w601c_qa',
      redisPort: 56385,
      callbackSource: CALLBACK_SOURCES.fake,
      syntheticReserveMinor: '1000',
    })}\n`,
  );

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((error) => {
  process.stderr.write(`W6-01C dispatch probe failed: ${error instanceof Error ? error.stack : String(error)}\n`);
  process.exit(1);
});
