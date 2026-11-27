import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Queue, QueueEvents } from 'bullmq';
import { createDatabaseClient } from '@truevine/database';
import { CAMPAIGN_EXECUTION_QUEUE } from '@truevine/queue';
import { loadEnvFiles } from '@truevine/shared';

loadEnvFiles();

const queueName = process.env.CAMPAIGN_EXECUTION_QUEUE_NAME;
if (!queueName || !queueName.startsWith('w402-') || queueName === CAMPAIGN_EXECUTION_QUEUE) {
  throw new Error('CAMPAIGN_EXECUTION_QUEUE_NAME must name an isolated w402-* queue.');
}

const redisUrl = process.env.REDIS_URL;
if (!redisUrl) throw new Error('REDIS_URL is required.');
const redis = new URL(redisUrl);
if (
  redis.protocol !== 'redis:' ||
  !['localhost', '127.0.0.1', '::1'].includes(redis.hostname) ||
  redis.port !== '56379'
) {
  throw new Error('REDIS_URL must target the local W402 test Redis on port 56379.');
}

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL is required.');
const database = new URL(databaseUrl);
if (database.pathname !== '/truevine_w402_integration_test') {
  throw new Error('DATABASE_URL must target truevine_w402_integration_test.');
}

const jobId = `w402-smoke-${randomUUID()}`;
const data = {
  organizationId: randomUUID(),
  campaignId: randomUUID(),
};

const prisma = createDatabaseClient(databaseUrl, { log: [] });
const queue = new Queue(queueName, {
  connection: { url: redisUrl },
});
const queueEvents = new QueueEvents(queueName, { connection: { url: redisUrl } });

let jobState: string | null = null;
let jobExists = false;

try {
  await Promise.all([queue.waitUntilReady(), queueEvents.waitUntilReady()]);

  const workerClients = await queue.getWorkers();
  assert.ok(workerClients.length > 0, 'No worker is registered on the isolated queue.');

  const existing = await prisma.campaignExecution.findUnique({
    where: {
      organizationId_campaignId: {
        organizationId: data.organizationId,
        campaignId: data.campaignId,
      },
    },
  });
  assert.equal(existing, null, 'Generated IDs unexpectedly match an existing campaign execution.');

  const job = await queue.add('execute', data, { jobId });
  const result = await job.waitUntilFinished(queueEvents, 30_000);
  const state = await job.getState();
  assert.equal(state, 'completed', `Expected completed job state, received ${state}.`);
  assert.deepEqual(result, { status: 'missing' });

  const executionAfter = await prisma.campaignExecution.findUnique({
    where: {
      organizationId_campaignId: {
        organizationId: data.organizationId,
        campaignId: data.campaignId,
      },
    },
  });
  assert.equal(executionAfter, null, 'The smoke test unexpectedly created a campaign execution.');

  const attempts = await prisma.$queryRaw`SELECT COUNT(*)::int AS count
    FROM call_attempts
    WHERE organization_id = ${data.organizationId}::uuid
      AND campaign_id = ${data.campaignId}::uuid`;
  const operations = await prisma.$queryRaw`SELECT COUNT(*)::int AS count
    FROM call_operations o
    JOIN call_attempts a
      ON a.organization_id = o.organization_id
     AND a.id = o.attempt_id
    WHERE a.organization_id = ${data.organizationId}::uuid
      AND a.campaign_id = ${data.campaignId}::uuid`;
  assert.equal(attempts[0]?.count, 0, 'The smoke test unexpectedly created a CallAttempt.');
  assert.equal(operations[0]?.count, 0, 'The smoke test unexpectedly created a CallOperation.');

  const existingJob = await queue.getJob(jobId);
  if (existingJob) {
    jobExists = true;
    jobState = await existingJob.getState();
    if (jobState !== 'active') {
      await existingJob.remove();
    }
  }
} finally {
  await Promise.all([queue.close(), queueEvents.close(), prisma.$disconnect()]);
}

if (jobExists && jobState === 'active') {
  throw new Error('W402 job is still active; stop its worker before removing the test job.');
}
