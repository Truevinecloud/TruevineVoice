import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadEnvFiles } from '@truevine/shared';

import { AppModule } from '../src/app.module.js';

/**
 * `GET /health` against live local infrastructure.
 *
 * Requires PostgreSQL and Redis:
 *
 *   npm run infra:up
 *   npm run test:e2e
 *
 * This test intentionally does not skip itself when infrastructure is missing.
 * A missing dependency is a real failure that must be reported, not hidden.
 */
describe('GET /health against live infrastructure', () => {
  let app: INestApplication;

  beforeAll(async () => {
    loadEnvFiles();
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('reports ok once PostgreSQL and Redis are reachable', async () => {
    const response = await request(app.getHttpServer()).get('/health').expect(200);

    expect(response.body.status).toBe('ok');
    expect(response.body.dependencies.postgres).toMatchObject({ status: 'up' });
    expect(response.body.dependencies.redis).toMatchObject({ status: 'up' });
  });

  it('reports a plausible latency for each dependency', async () => {
    const response = await request(app.getHttpServer()).get('/health').expect(200);

    expect(response.body.dependencies.postgres.latencyMs).toBeGreaterThanOrEqual(0);
    expect(response.body.dependencies.redis.latencyMs).toBeGreaterThanOrEqual(0);
  });
});
