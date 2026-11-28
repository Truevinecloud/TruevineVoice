import { optionalEnv, optionalIntEnv, requireEnv } from '@truevine/shared';

/** Configuration for the background worker. */
export interface WorkerConfig {
  readonly environment: string;
  readonly version: string;
  readonly redisUrl: string;
  readonly databaseUrl: string;
  readonly healthTimeoutMs: number;
  readonly workerConcurrency: number;
  readonly maxRetryAttempts: number;
  readonly retryBackoffMs: number;
  readonly rateLimitMax: number;
  readonly rateLimitDurationMs: number;
  readonly observabilityIntervalMs?: number;
  readonly serviceName: string;
}

export const WORKER_SERVICE_NAME = 'truevine-voice-worker';

/** Reads and validates worker configuration from `env`. */
export function loadWorkerConfig(env: NodeJS.ProcessEnv = process.env): WorkerConfig {
  return Object.freeze({
    environment: optionalEnv('NODE_ENV', 'development', env),
    version: optionalEnv('APP_VERSION', '0.1.0', env),
    redisUrl: requireEnv('REDIS_URL', env),
    databaseUrl: requireEnv('DATABASE_URL', env),
    healthTimeoutMs: optionalIntEnv('HEALTH_CHECK_TIMEOUT_MS', 2_000, env),
    workerConcurrency: 4,
    maxRetryAttempts: 3,
    retryBackoffMs: 1_000,
    rateLimitMax: 10,
    rateLimitDurationMs: 1_000,
    observabilityIntervalMs: 30_000,
    serviceName: WORKER_SERVICE_NAME,
  });
}
