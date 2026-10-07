import { optionalEnv, optionalIntEnv, requireEnv } from '@truevine/shared';

/** Configuration for the background worker. */
export interface WorkerConfig {
  readonly environment: string;
  readonly version: string;
  readonly redisUrl: string;
  readonly healthTimeoutMs: number;
  readonly serviceName: string;
}

export const WORKER_SERVICE_NAME = 'truevine-voice-worker';

/** Reads and validates worker configuration from `env`. */
export function loadWorkerConfig(env: NodeJS.ProcessEnv = process.env): WorkerConfig {
  return Object.freeze({
    environment: optionalEnv('NODE_ENV', 'development', env),
    version: optionalEnv('APP_VERSION', '0.1.0', env),
    redisUrl: requireEnv('REDIS_URL', env),
    healthTimeoutMs: optionalIntEnv('HEALTH_CHECK_TIMEOUT_MS', 2_000, env),
    serviceName: WORKER_SERVICE_NAME,
  });
}
