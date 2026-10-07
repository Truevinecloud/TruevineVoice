import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { PrismaClient } from '@truevine/database';
import { loadEnvFiles } from '@truevine/shared';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { AppModule } from '../src/app.module.js';
import { DATABASE_CLIENT } from '../src/tokens.js';

/**
 * Repository root, resolved from this file rather than `process.cwd()` so the
 * check works no matter which directory the test runner was started from.
 */
const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));

/**
 * The host port that Docker Compose published for *this project's* PostgreSQL
 * container. Comparing the application's target against it turns a wrong target
 * into a loud failure instead of an accidental pass.
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
  let database: PrismaClient;

  beforeAll(async () => {
    loadEnvFiles();
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    database = app.get<PrismaClient>(DATABASE_CLIENT);
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

  it('configures PostgreSQL from the port declared in DATABASE_URL', () => {
    const declared = new URL(process.env['DATABASE_URL'] as string);

    // Compose publishes this host port; the container port is always 5432.
    expect(Number(declared.port || '5432')).toBe(Number(process.env['POSTGRES_PORT'] ?? '55432'));
  });

  /**
   * Guards against a fresh clone silently attaching to another project's
   * PostgreSQL on the configured host port.
   */
  it('is connected to the PostgreSQL published by this project Compose stack', () => {
    const declaredPort = Number(new URL(process.env['DATABASE_URL'] as string).port || '5432');

    expect(declaredPort).toBe(composePublishedPort('postgres', '5432'));
  });

  /**
   * Defence in depth: even if the port check were bypassed, a foreign PostgreSQL
   * does not have this project's database and role, so the session itself
   * proves identity.
   */
  it('is connected to the Truevine Voice development database', async () => {
    const [row] = await database.$queryRaw<Array<{ db: string; usr: string }>>`
      SELECT current_database() AS db, current_user AS usr
    `;

    expect(row?.db).toBe('truevine_voice');
    expect(row?.usr).toBe('truevine');
  });
});