import { optionalEnv, optionalIntEnv, requireEnv } from '@truevine/shared';

/**
 * API configuration, resolved once at start-up from the environment.
 *
 * Configuration is validated eagerly so that a missing or malformed variable
 * fails the boot immediately with an actionable message, instead of surfacing
 * later as a confusing runtime error.
 */
export interface ApiConfig {
  readonly host: string;
  readonly port: number;
  readonly environment: string;
  readonly version: string;
  readonly databaseUrl: string;
  readonly redisUrl: string;
  /** Milliseconds allowed per dependency while answering `GET /health`. */
  readonly healthTimeoutMs: number;
  readonly serviceName: string;
}

export const API_SERVICE_NAME = 'truevine-voice-api';

/** Reads and validates configuration from `env`. */
export function loadApiConfig(env: NodeJS.ProcessEnv = process.env): ApiConfig {
  const environment = optionalEnv('NODE_ENV', 'development', env);

  return Object.freeze({
    host: optionalEnv('API_HOST', '0.0.0.0', env),
    port: optionalIntEnv('API_PORT', 3001, env),
    environment,
    version: optionalEnv('APP_VERSION', '0.1.0', env),
    databaseUrl: requireEnv('DATABASE_URL', env),
    redisUrl: requireEnv('REDIS_URL', env),
    healthTimeoutMs: optionalIntEnv('HEALTH_CHECK_TIMEOUT_MS', 2_000, env),
    serviceName: API_SERVICE_NAME,
  });
}
