#!/usr/bin/env node

import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import process from 'node:process';
import { URL, fileURLToPath } from 'node:url';

import { Queue } from 'bullmq';
import Redis from 'ioredis';
import { CAMPAIGN_EXECUTION_QUEUE } from '@truevine/queue';
import { createDatabaseClient } from '@truevine/database';

import {
  collectDiagnostics,
  safeErrorCode,
  summarizeReconciliationRows,
} from './diagnostics.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);
const QUEUE_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9:_-]{0,127}$/;
const TIMEOUT_MS = 2_500;

function parseArguments(args) {
  if (args.includes('--help') || args.includes('-h')) return { help: true, format: 'text' };
  if (args.some((arg) => arg !== '--json')) throw new Error('Unsupported option.');
  return { help: false, format: args.includes('--json') ? 'json' : 'text' };
}

function loadEnvironmentFile() {
  const path = resolve(ROOT, '.env');
  if (!existsSync(path)) return 'not_found';
  if (typeof process.loadEnvFile !== 'function') return 'unsupported_runtime';
  try {
    process.loadEnvFile(path);
    return 'loaded';
  } catch {
    return 'invalid';
  }
}

function localUrl(raw, protocols) {
  if (typeof raw !== 'string' || raw.length === 0) return null;
  try {
    const url = new URL(raw);
    if (
      !protocols.includes(url.protocol) ||
      !LOOPBACK_HOSTS.has(url.hostname.toLowerCase())
    ) {
      return null;
    }
    return url;
  } catch {
    return null;
  }
}

function createRedis(url, captureError) {
  const client = new Redis(url.href, {
    lazyConnect: true,
    maxRetriesPerRequest: 1,
    enableReadyCheck: true,
    enableOfflineQueue: false,
    connectTimeout: TIMEOUT_MS,
    retryStrategy: () => null,
  });
  client.on('error', (error) => captureError(safeErrorCode(error)));
  return client;
}

function createQueueFactory(redisUrl, queueName, captureError) {
  return () => {
    const queue = new Queue(queueName, {
      connection: {
        url: redisUrl,
        lazyConnect: true,
        maxRetriesPerRequest: null,
        connectTimeout: TIMEOUT_MS,
        retryStrategy: () => null,
      },
      skipMetasUpdate: true,
    });
    queue.on('error', (error) => captureError(safeErrorCode(error)));
    return queue;
  };
}

async function readReconciliation(databaseUrl) {
  if (!databaseUrl) {
    return {
      status: 'not_configured',
      totalCount: null,
      requiredCount: null,
      byStatus: null,
    };
  }

  const url = localUrl(databaseUrl, ['postgres:', 'postgresql:']);
  if (!url) {
    return {
      status: 'blocked_non_local',
      totalCount: null,
      requiredCount: null,
      byStatus: null,
    };
  }

  const database = createDatabaseClient(url.href, {
    log: [],
    transactionTimeoutMs: TIMEOUT_MS,
  });
  try {
    const rows = await database.$transaction(async (transaction) => {
      await transaction.$executeRaw`SET TRANSACTION READ ONLY`;
      return transaction.callInitiationReconciliation.groupBy({
        by: ['organizationId', 'status', 'reconciliationRequired'],
        _count: { _all: true },
      });
    });
    return summarizeReconciliationRows(rows);
  } catch (error) {
    return {
      status: 'unavailable',
      totalCount: null,
      requiredCount: null,
      byStatus: null,
      errorCode: safeErrorCode(error),
    };
  } finally {
    await database.$disconnect();
  }
}

async function inspectTechnicalApiSource() {
  const sourcePath = resolve(ROOT, 'apps/api/src/technical/technical.service.ts');
  const controllerPath = resolve(ROOT, 'apps/api/src/technical/technical.controller.ts');
  let source;
  let controller;
  try {
    [source, controller] = await Promise.all([
      readFile(sourcePath, 'utf8'),
      readFile(controllerPath, 'utf8'),
    ]);
  } catch {
    return {
      status: 'unavailable',
      queueInventoryStatus: 'unavailable',
    };
  }

  const sourceFiles = [
    'apps/api/src/technical/technical.controller.ts',
    'apps/api/src/technical/technical.service.ts',
  ];
  if (!controller.includes("@Get('queues')")) {
    return {
      status: 'source_checked',
      queueInventoryStatus: 'route_not_found',
      source: sourceFiles,
    };
  }

  const start = source.indexOf('async queues(');
  if (start < 0) {
    return {
      status: 'source_checked',
      queueInventoryStatus: 'implementation_not_found',
      source: sourceFiles,
    };
  }
  const nextMethod = source.indexOf('\n  async ', start + 1);
  const method = source.slice(start, nextMethod < 0 ? undefined : nextMethod);
  const queueInventoryStatus =
    method.includes("status: 'not_integrated'") && method.includes('queues: []')
      ? 'not_integrated'
      : /getJobCounts\s*\(|getWorkers\s*\(/.test(method) &&
          /status:\s*'(available|integrated|ok)'/.test(method)
        ? 'integrated'
        : 'unknown';

  return {
    status: 'source_checked',
    queueInventoryStatus,
    source: sourceFiles,
  };
}

function renderText(report) {
  const counts = report.queue.counts.values;
  const lines = [
    `${report.tool} (read-only)`,
    `Generated: ${report.generatedAt}`,
    `Redis: ${report.redis.status}${report.redis.latencyMs === undefined ? '' : ` (${report.redis.latencyMs} ms)`}`,
    `Queue: ${report.queue.name ?? 'unavailable'}`,
    `Jobs: ${Object.entries(counts).map(([state, count]) => `${state}=${count ?? 'unavailable'}`).join(', ')}`,
    `Workers: ${report.queue.workers.registeredCount ?? 'unavailable'} registered; readiness=${report.queue.workers.readinessSignal}`,
    `Failed-job sample: ${report.queue.failures.status}; sampled=${report.queue.failures.sampledCount ?? 'unavailable'}`,
    `Reconciliation: ${report.reconciliation.status}; required=${report.reconciliation.requiredCount ?? 'unavailable'}`,
    `Technical Admin API: ${report.technicalAdminApi.status}; inventory=${report.technicalAdminApi.queueInventoryStatus}`,
    'W4-02 acceptance gaps:',
    ...report.acceptanceGaps.map((gap) => `- ${gap}`),
  ];
  return lines.join('\n');
}

async function closeResources({ queue, redis, database }) {
  const warnings = [];
  if (queue) {
    try {
      await queue.close();
    } catch (error) {
      warnings.push({ resource: 'bullmq_queue', errorCode: safeErrorCode(error) });
    }
  }
  if (redis) {
    try {
      if (redis.status === 'ready') await redis.quit();
      else redis.disconnect();
    } catch (error) {
      warnings.push({ resource: 'redis', errorCode: safeErrorCode(error) });
    }
  }
  if (database) {
    try {
      await database.$disconnect();
    } catch (error) {
      warnings.push({ resource: 'postgresql', errorCode: safeErrorCode(error) });
    }
  }
  return warnings;
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(
      'Usage: node tools/qa/w402-diagnostics/cli.mjs [--json]\n' +
        'Read-only local Redis, BullMQ, reconciliation, and Technical Admin diagnostics.\n',
    );
    return;
  }

  const envFileStatus = loadEnvironmentFile();
  const configuredQueueName = process.env['CAMPAIGN_EXECUTION_QUEUE_NAME'] ?? CAMPAIGN_EXECUTION_QUEUE;
  const queueName = QUEUE_NAME_PATTERN.test(configuredQueueName) ? configuredQueueName : null;

  const redisUrl = localUrl(process.env['REDIS_URL'], ['redis:', 'rediss:']);
  const redisUnavailableStatus = !process.env['REDIS_URL']
    ? 'not_configured'
    : redisUrl
      ? 'unavailable'
      : 'blocked_non_local';
  let redisEventErrorCode = null;
  const redis = redisUrl
    ? createRedis(redisUrl, (code) => {
        redisEventErrorCode = code;
      })
    : null;
  let queue;
  let queueEventErrorCode = null;

  const report = await collectDiagnostics({
    queueName,
    redis,
    redisUnavailableStatus,
    createQueue:
      redis && queueName
        ? () => {
            queue = createQueueFactory(redisUrl.href, queueName, (code) => {
              queueEventErrorCode = code;
            })();
            return queue;
          }
        : undefined,
    readReconciliation: () => readReconciliation(process.env['DATABASE_URL']),
    inspectTechnicalApi: inspectTechnicalApiSource,
  });

  report.configuration = {
    localEnvFile: envFileStatus,
    queueNameSource: process.env['CAMPAIGN_EXECUTION_QUEUE_NAME']
      ? 'environment'
      : 'queue_contract_default',
    queueNameValid: queueName !== null,
    reconciliationDatabase: !process.env['DATABASE_URL']
      ? 'not_configured'
      : localUrl(process.env['DATABASE_URL'], ['postgres:', 'postgresql:'])
        ? 'local_configured'
        : 'blocked_non_local',
  };
  if (!queueName) report.acceptanceGaps.push('Configured BullMQ queue name is invalid.');
  if (redisEventErrorCode && report.redis.status !== 'available') {
    report.redis.errorCode ??= redisEventErrorCode;
  }
  if (queueEventErrorCode) report.queue.eventErrorCode = queueEventErrorCode;

  const cleanupWarnings = await closeResources({ queue, redis });
  if (cleanupWarnings.length > 0) report.cleanupWarnings = cleanupWarnings;

  process.stdout.write(
    options.format === 'json' ? `${JSON.stringify(report, null, 2)}\n` : `${renderText(report)}\n`,
  );
}

main().catch((error) => {
  const message = error?.message === 'Unsupported option.' ? error.message : 'Diagnostics could not start.';
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
