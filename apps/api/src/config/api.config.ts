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
  readonly audioStorage?: {
    readonly bucket: string;
    readonly region: string;
    readonly endpoint?: string;
    readonly forcePathStyle?: boolean;
  } | null;
  readonly audioTtsRegion?: string | null;
}

export const API_SERVICE_NAME = 'truevine-voice-api';

/** Reads and validates configuration from `env`. */
export function loadApiConfig(env: NodeJS.ProcessEnv = process.env): ApiConfig {
  const environment = optionalEnv('NODE_ENV', 'development', env);
  const audioBucket = optionalEnv('AUDIO_STORAGE_BUCKET', '', env).trim();
  const audioStorageRegion = optionalEnv('AUDIO_STORAGE_REGION', '', env).trim();
  const audioStorageEndpoint = optionalEnv('AUDIO_STORAGE_ENDPOINT', '', env).trim();
  const audioPathStyle = optionalEnv('AUDIO_STORAGE_FORCE_PATH_STYLE', '', env).trim();
  const audioTtsRegion = optionalEnv('AUDIO_TTS_REGION', '', env).trim();

  if (audioBucket && !audioStorageRegion) {
    throw new Error('AUDIO_STORAGE_REGION is required when AUDIO_STORAGE_BUCKET is configured.');
  }
  if (!audioBucket && (audioStorageRegion || audioStorageEndpoint || audioPathStyle)) {
    throw new Error('AUDIO_STORAGE_BUCKET is required to configure audio object storage.');
  }
  if (audioPathStyle && !['true', 'false'].includes(audioPathStyle.toLowerCase())) {
    throw new Error('AUDIO_STORAGE_FORCE_PATH_STYLE must be true or false.');
  }

  return Object.freeze({
    host: optionalEnv('API_HOST', '0.0.0.0', env),
    port: optionalIntEnv('API_PORT', 3001, env),
    environment,
    version: optionalEnv('APP_VERSION', '0.1.0', env),
    databaseUrl: requireEnv('DATABASE_URL', env),
    redisUrl: requireEnv('REDIS_URL', env),
    healthTimeoutMs: optionalIntEnv('HEALTH_CHECK_TIMEOUT_MS', 2_000, env),
    serviceName: API_SERVICE_NAME,
    audioStorage: audioBucket
      ? Object.freeze({
          bucket: audioBucket,
          region: audioStorageRegion,
          ...(audioStorageEndpoint ? { endpoint: audioStorageEndpoint } : {}),
          ...(audioPathStyle ? { forcePathStyle: audioPathStyle.toLowerCase() === 'true' } : {}),
        })
      : null,
    audioTtsRegion: audioTtsRegion || null,
  });
}
