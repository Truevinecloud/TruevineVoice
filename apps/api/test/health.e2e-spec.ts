import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { AppModule } from '../src/app.module.js';
import { APP_CONFIG } from '../src/config/app-config.module.js';
import type { ApiConfig } from '../src/config/api.config.js';
import { DATABASE_CLIENT, REDIS_CLIENT } from '../src/tokens.js';

/**
 * `GET /health` over the real HTTP stack, with infrastructure clients replaced
 * by fakes so this file needs neither PostgreSQL nor Redis.
 */

const TEST_CONFIG: ApiConfig = Object.freeze({
  host: '127.0.0.1',
  port: 0,
  environment: 'test',
  version: '0.1.0-test',
  databaseUrl: 'postgresql://stub/stub',
  redisUrl: 'redis://stub:6379',
  healthTimeoutMs: 50,
  serviceName: 'truevine-voice-api',
});

/**
 * Fakes must satisfy the full lifecycle contract, not just the surface the
 * health probe uses: `InfrastructureLifecycle` disconnects these clients on
 * shutdown, so a fake without `$disconnect`/`disconnect` would make application
 * shutdown throw.
 */
function fakeDatabase(queryRaw: () => Promise<unknown>): unknown {
  return { $queryRaw: vi.fn(queryRaw), $disconnect: vi.fn().mockResolvedValue(undefined) };
}

function fakeRedis(ping: () => Promise<unknown>): unknown {
  return { ping: vi.fn(ping), disconnect: vi.fn() };
}

async function createTestApp(overrides: {
  database: unknown;
  redis: unknown;
}): Promise<INestApplication> {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(APP_CONFIG)
    .useValue(TEST_CONFIG)
    .overrideProvider(DATABASE_CLIENT)
    .useValue(overrides.database)
    .overrideProvider(REDIS_CLIENT)
    .useValue(overrides.redis)
    .compile();

  const app = moduleRef.createNestApplication();
  await app.init();
  return app;
}

describe('GET /health', () => {
  let app: INestApplication;

  beforeAll(async () => {
    app = await createTestApp({
      database: fakeDatabase(async () => [{ '?column?': 1 }]),
      redis: fakeRedis(async () => 'PONG'),
    });
  });

  afterAll(async () => {
    await app.close();
  });

  it('returns 200 with a structured report when all dependencies are up', async () => {
    const response = await request(app.getHttpServer()).get('/health').expect(200);

    expect(response.body).toMatchObject({
      status: 'ok',
      service: 'truevine-voice-api',
      version: '0.1.0-test',
      environment: 'test',
    });
    expect(response.body.uptimeSeconds).toBeGreaterThanOrEqual(0);
    expect(response.body.timestamp).toBeTypeOf('string');
    expect(response.body.dependencies.postgres.status).toBe('up');
    expect(response.body.dependencies.redis.status).toBe('up');
  });

  it('releases both infrastructure clients when the application shuts down', async () => {
    const database = fakeDatabase(async () => [{ '?column?': 1 }]);
    const redis = fakeRedis(async () => 'PONG');
    const scoped = await createTestApp({ database, redis });

    await scoped.close();

    expect((database as { $disconnect: () => void }).$disconnect).toHaveBeenCalled();
    expect((redis as { disconnect: () => void }).disconnect).toHaveBeenCalled();
  });
});

describe('GET /health with an unavailable dependency', () => {
  let app: INestApplication;

  beforeAll(async () => {
    app = await createTestApp({
      database: fakeDatabase(async () => {
        throw new Error('connect ECONNREFUSED 127.0.0.1:5432');
      }),
      redis: fakeRedis(async () => 'PONG'),
    });
  });

  afterAll(async () => {
    await app.close();
  });

  it('returns 503 and reports which dependency failed', async () => {
    const response = await request(app.getHttpServer()).get('/health').expect(503);

    expect(response.body.status).toBe('degraded');
    expect(response.body.dependencies.postgres.status).toBe('down');
    expect(response.body.dependencies.postgres.error).toContain('ECONNREFUSED');
    expect(response.body.dependencies.redis.status).toBe('up');
  });
});
