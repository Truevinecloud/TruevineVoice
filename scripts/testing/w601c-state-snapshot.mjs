/**
 * Read-only W6-01C reconciliation snapshot.
 *
 * Prints authoritative PostgreSQL and isolated Redis state as JSON. It refuses
 * every target except the dedicated W6-01C QA database and Redis container.
 */

import process from 'node:process';
import { URL } from 'node:url';

import { createDatabaseClient } from '@truevine/database';
import { createRedisClient } from '@truevine/queue';

const CAMPAIGN_IDS = [
  '71000000-0000-4000-8000-000000000001',
  '71000000-0000-4000-8000-000000000002',
  '71000000-0000-4000-8000-000000000003',
  '71000000-0000-4000-8000-000000000004',
  '71000000-0000-4000-8000-000000000009',
  '71000000-0000-4000-8000-000000000010',
  '71000000-0000-4000-8000-000000000011',
];

function validateTarget() {
  const database = new URL(process.env['DATABASE_URL'] ?? '');
  if (
    !['postgres:', 'postgresql:'].includes(database.protocol) ||
    !['localhost', '127.0.0.1', '::1', '[::1]'].includes(database.hostname) ||
    database.port !== '55435' ||
    database.pathname !== '/truevine_w601c_qa' ||
    ['host', 'hostaddr', 'port', 'database', 'dbname'].some((key) => database.searchParams.has(key))
  ) {
    throw new Error('W6-01C snapshot refuses every database except truevine_w601c_qa.');
  }
  const redis = new URL(process.env['REDIS_URL'] ?? '');
  if (
    redis.protocol !== 'redis:' ||
    !['localhost', '127.0.0.1', '::1', '[::1]'].includes(redis.hostname) ||
    redis.port !== '56385'
  ) {
    throw new Error('W6-01C snapshot requires Redis on loopback port 56385.');
  }
}

function iso(value) {
  return value instanceof Date ? value.toISOString() : value;
}

async function main() {
  validateTarget();
  const database = createDatabaseClient(process.env['DATABASE_URL'], { log: [] });
  const redis = createRedisClient(process.env['REDIS_URL']);
  try {
    if (redis.status === 'wait') await redis.connect();
    const [campaigns, walletEntries, wallets, reservations, attempts, audits, globalCount, detail] =
      await Promise.all([
        database.campaign.findMany({
          where: { id: { in: CAMPAIGN_IDS } },
          select: {
            organizationId: true,
            id: true,
            name: true,
            status: true,
            dispatchState: true,
            dispatchEpoch: true,
            dispatchStopReason: true,
            emergencyStoppedAt: true,
            updatedAt: true,
          },
          orderBy: { name: 'asc' },
        }),
        database.walletEntry.findMany({
          select: {
            organizationId: true,
            id: true,
            amountMinor: true,
            currency: true,
            reference: true,
          },
          orderBy: { createdAt: 'asc' },
        }),
        database.$queryRaw`
          SELECT organization_id::text AS "organizationId",
                 currency,
                 COALESCE(SUM(amount_minor), 0)::text AS "balanceMinor"
          FROM wallet_entries
          GROUP BY 1, 2
          ORDER BY 1, 2`,
        database.$queryRaw`
          SELECT organization_id::text AS "organizationId",
                 state,
                 COUNT(*)::int AS "count",
                 COALESCE(SUM(amount_minor), 0)::text AS "amountMinor"
          FROM campaign_dispatch_reservations
          GROUP BY 1, 2
          ORDER BY 1, 2`,
        database.$queryRaw`
          SELECT organization_id::text AS "organizationId",
                 campaign_id::text AS "campaignId",
                 id::text AS "attemptId",
                 recipient_id::text AS "recipientId",
                 attempt_number AS "attemptNumber",
                 state::text AS "state",
                 created_at AS "createdAt"
          FROM call_attempts
          ORDER BY created_at, id`,
        database.$queryRaw`
          SELECT a.organization_id::text AS "organizationId",
                 a.action,
                 a.outcome::text AS "outcome",
                 a.scope::text AS "scope",
                 a.target_type AS "targetType",
                 a.target_id AS "targetId",
                 a.metadata,
                 a.occurred_at AS "occurredAt",
                 u.email AS "actorEmail"
          FROM security_audit_events a
          JOIN users u ON u.id = a.actor_user_id
          WHERE a.target_id::text = ANY(${CAMPAIGN_IDS})
             OR a.action LIKE 'campaign.%'
             OR a.action LIKE 'platform.campaign%'
          ORDER BY a.occurred_at, a.id`,
        redis.get('w601c:provider-invocations:all'),
        redis.lrange('w601c:provider-invocations:detail', 0, -1),
      ]);

    const snapshot = {
      capturedAt: new Date().toISOString(),
      database: 'truevine_w601c_qa',
      redisPort: 56385,
      campaigns: campaigns.map((row) => ({
        ...row,
        emergencyStoppedAt: iso(row.emergencyStoppedAt),
        updatedAt: iso(row.updatedAt),
      })),
      walletEntries: walletEntries.map((row) => ({ ...row, amountMinor: row.amountMinor.toString() })),
      walletBalances: wallets,
      reservations,
      callAttempts: attempts.map((row) => ({ ...row, createdAt: iso(row.createdAt) })),
      audits: audits.map((row) => ({ ...row, occurredAt: iso(row.occurredAt) })),
      fakeProvider: {
        globalCount: Number(globalCount ?? '0'),
        detail: detail.map((entry) => JSON.parse(entry)),
      },
    };
    process.stdout.write(`${JSON.stringify(snapshot, null, 2)}\n`);
  } finally {
    redis.disconnect();
    await database.$disconnect();
  }
}

main().catch((error) => {
  process.stderr.write(`W6-01C snapshot failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
