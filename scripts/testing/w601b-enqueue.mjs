/**
 * Enqueues one synthetic W6-01B dispatch job and waits for its terminal result.
 * It reads the authoritative campaign epoch before enqueueing so a stale job is
 * never silently treated as a fresh one.
 */

import process from 'node:process';
import { randomUUID } from 'node:crypto';
import { URL } from 'node:url';

import { createDatabaseClient } from '@truevine/database';
import { createBullConnection, createRedisClient } from '@truevine/queue';
import { Queue, QueueEvents } from 'bullmq';

const GLOBAL_COUNT_KEY = 'w601b:provider-invocations:all';

function validateTarget() {
  const database = new URL(process.env['DATABASE_URL'] ?? '');
  if (
    !['postgres:', 'postgresql:'].includes(database.protocol) ||
    !['localhost', '127.0.0.1', '::1', '[::1]'].includes(database.hostname) ||
    database.port !== '55434' ||
    database.pathname !== '/truevine_w601b_qa'
  ) {
    throw new Error('W6-01B enqueue refuses every database except truevine_w601b_qa on loopback 55434.');
  }
  const redis = new URL(process.env['REDIS_URL'] ?? '');
  if (
    redis.protocol !== 'redis:' ||
    !['localhost', '127.0.0.1', '::1', '[::1]'].includes(redis.hostname) ||
    redis.port !== '56384'
  ) {
    throw new Error('W6-01B enqueue requires Redis on loopback port 56384.');
  }
  if (!process.env['CAMPAIGN_EXECUTION_QUEUE_NAME']?.startsWith('w601b-')) {
    throw new Error('W6-01B enqueue requires a unique w601b-* queue.');
  }
  if (process.env['AT_VOICE_PROVIDER'] === 'true' || process.env['NODE_ENV'] === 'production') {
    throw new Error('W6-01B enqueue refuses a real provider or production environment.');
  }
}

async function main() {
  validateTarget();
  const organizationId = process.env['W601B_ORGANIZATION_ID'];
  const campaignId = process.env['W601B_CAMPAIGN_ID'];
  const label = process.env['W601B_JOB_LABEL'] ?? 'unlabelled';
  if (!organizationId || !campaignId) {
    throw new Error('W601B_ORGANIZATION_ID and W601B_CAMPAIGN_ID are required.');
  }

  const database = createDatabaseClient(process.env['DATABASE_URL'], { log: [] });
  const redis = createRedisClient(process.env['REDIS_URL']);
  if (redis.status === 'wait') await redis.connect();
  const connection = createBullConnection(redis);
  const queueName = process.env['CAMPAIGN_EXECUTION_QUEUE_NAME'];
  const queue = new Queue(queueName, connection);
  const events = new QueueEvents(queueName, connection);
  try {
    await events.waitUntilReady();
    const campaign = await database.campaign.findUnique({
      where: { organizationId_id: { organizationId, id: campaignId } },
      select: {
        name: true,
        status: true,
        dispatchState: true,
        dispatchEpoch: true,
        dispatchStopReason: true,
        emergencyStoppedAt: true,
      },
    });
    if (!campaign) throw new Error('W6-01B campaign fixture is missing.');

    const before = Number((await redis.get(GLOBAL_COUNT_KEY)) ?? '0');
    const job = await queue.add(
      'w601b-acceptance',
      { organizationId, campaignId, dispatchEpoch: campaign.dispatchEpoch },
      { jobId: `w601b-${randomUUID()}`, attempts: 1 },
    );
    const result = await job.waitUntilFinished(events);
    const after = Number((await redis.get(GLOBAL_COUNT_KEY)) ?? '0');
    process.stdout.write(
      `${JSON.stringify({
        event: 'W601B_JOB',
        label,
        jobId: job.id,
        campaignId,
        campaignName: campaign.name,
        campaignBefore: campaign,
        result,
        fakeProviderInvocationsBefore: before,
        fakeProviderInvocationsAfter: after,
      })}\n`,
    );
  } finally {
    await events.close();
    await queue.close();
    redis.disconnect();
    await database.$disconnect();
  }
}

main().catch((error) => {
  process.stderr.write(`W6-01B enqueue failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
