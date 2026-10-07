import { NestFactory } from '@nestjs/core';
import type { Redis } from '@truevine/queue';
import { loadEnvFiles } from '@truevine/shared';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';

import { AppModule } from '../src/app.module.js';
import { WorkerReadinessService } from '../src/health/worker-readiness.service.js';
import { REDIS_CLIENT } from '../src/tokens.js';

/**
 * Repository root, resolved from this file rather than `process.cwd()` so the
 * check works no matter which directory the test runner was started from.
 */
const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));

/**
 * The host port that Docker Compose published for *this project's* Redis
 * container.
 *
 * This is the only authoritative answer to "is the Redis we are talking to
 * ours?". Redis carries no project identity of its own, so comparing against
 * what our own container publishes is what turns a wrong target into a loud
 * failure instead of an accidental pass.
 */
function composePublishedPort(service: string, containerPort: string): number {
  let output: string;
  try {
    output = execFileSync('docker', ['compose', 'port', service, containerPort], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
    }).trim();
  } catch (error) {
    throw new Error(
      `Could not run "docker compose port ${service} ${containerPort}" from ${REPO_ROOT}. ` +
        'The infrastructure E2E tests require Docker, because they verify that this ' +
        "project's containers own the configured host ports.",
      { cause: error },
    );
  }

  const port = Number(output.split(':').pop());
  if (!Number.isSafeInteger(port) || port <= 0) {
    throw new Error(
      `Unexpected output from "docker compose port ${service} ${containerPort}": ${JSON.stringify(output)}. ` +
        'Is this project\'s Compose stack running (npm run infra:up)?',
    );
  }
  return port;
}

/**
 * Boots the real worker application context against live Redis.
 *
 * Uses `NestFactory.createApplicationContext` rather than a testing module so
 * that the test exercises the same start-up path as `npm run dev:worker`.
 *
 * Requires `npm run infra:up`. This test does not skip itself when Redis is
 * unavailable: a missing dependency is a real failure that must be reported.
 */
describe('worker bootstrap against live Redis', () => {
  let context: Awaited<ReturnType<typeof NestFactory.createApplicationContext>>;
  let readiness: WorkerReadinessService;
  let redis: Redis;

  beforeAll(async () => {
    loadEnvFiles();
    context = await NestFactory.createApplicationContext(AppModule);
    context.enableShutdownHooks();
    readiness = context.get(WorkerReadinessService);
    redis = context.get<Redis>(REDIS_CLIENT);
  });

  it('exposes a readiness check', () => {
    // Documented foundation-stage invariant: no business queues or processors
    // are registered; those arrive together with the feature that needs them.
    expect(typeof readiness.check).toBe('function');
  });

  it('reports Redis as reachable once booted', async () => {
    const report = await readiness.check();

    expect(report.status).toBe('ok');
    expect(report.dependencies.redis).toMatchObject({ status: 'up' });
  });

  it('reports ok from the start-up probe itself', () => {
    expect(readiness.status).toBe('ok');
  });

  it('configures Redis from the port declared in REDIS_URL', () => {
    const declared = new URL(process.env['REDIS_URL'] as string);

    // Compose publishes this host port; the container port is always 6379.
    expect(Number(declared.port || '6379')).toBe(Number(process.env['REDIS_PORT'] ?? '56379'));
  });

  /**
   * Guards against a fresh clone silently attaching to another project's Redis
   * that happens to occupy the configured host port - the case where a plain
   * PING would pass by accident.
   *
   * Three facts are checked: the declared URL, the port this project's own
   * container publishes, and the live TCP peer. All three must agree.
   */
  it('is connected to the Redis published by this project Compose stack', async () => {
    const declaredPort = Number(new URL(process.env['REDIS_URL'] as string).port || '6379');
    const ourComposePort = composePublishedPort('redis', '6379');

    expect(declaredPort).toBe(ourComposePort);

    // Ensure the socket is established before reading its peer.
    await redis.ping();

    expect(redis.stream.remotePort).toBe(ourComposePort);
  });
});