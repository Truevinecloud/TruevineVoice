import { NestFactory } from '@nestjs/core';
import { loadEnvFiles } from '@truevine/shared';
import { beforeAll, describe, expect, it } from 'vitest';

import { AppModule } from '../src/app.module.js';
import { WorkerReadinessService } from '../src/health/worker-readiness.service.js';

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

  beforeAll(async () => {
    loadEnvFiles();
    context = await NestFactory.createApplicationContext(AppModule);
    context.enableShutdownHooks();
    readiness = context.get(WorkerReadinessService);
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
});
