/**
 * Redis and BullMQ foundation.
 *
 * ARCHITECTURAL RULES ENFORCED HERE
 * ---------------------------------
 * - Redis/BullMQ carries asynchronous work and short-lived coordination state.
 *   It is NEVER the authoritative store for business data. Anything that must
 *   survive Redis being flushed lives in PostgreSQL.
 * - No business queues are declared yet. This module only provides connection
 *   construction plus the options required by BullMQ, so that queues can be
 *   added later without re-inventing connection handling.
 */

import type { RedisOptions } from 'bullmq';
import { Redis } from 'ioredis';
import { describeError, elapsedMs, withTimeout, type DependencyHealth } from '@truevine/shared';

/** Default per-probe timeout for Redis health checks. */
export const DEFAULT_REDIS_PROBE_TIMEOUT_MS = 2_000;

/**
 * BullMQ requires this to be `null` so that blocking commands (BRPOPLPUSH and
 * friends) are not aborted by ioredis' command timeout. Setting it to a finite
 * number silently breaks job processing, so it lives here as a constant.
 */
export const BULLMQ_MAX_RETRIES_PER_REQUEST: null = null;

/**
 * BullMQ connection settings shared by producers, workers and schedulers.
 *
 * `prefix` is pinned so that queue key names are stable and namespaced.
 */
export interface BullConnectionOptions {
  readonly connection: RedisOptions;
}

/** The minimal surface a health probe needs from a Redis client. */
export interface PingableClient {
  ping(): Promise<unknown>;
}

/**
 * Builds the connection options used to create Redis clients.
 *
 * The URL is deliberately not part of this object: ioredis takes it as a
 * separate constructor argument, and BullMQ expects it as `url` inside the
 * options object. Keeping them separate lets both callers share one definition
 * without either having to reshape it.
 */
export function createRedisConnectionOptions(): RedisOptions {
  return {
    // Lazy connect: constructing a client must not throw when Redis is down.
    // Connection failures surface through the health probe instead.
    lazyConnect: true,
    maxRetriesPerRequest: BULLMQ_MAX_RETRIES_PER_REQUEST,
    enableReadyCheck: true,
    enableOfflineQueue: true,
    retryStrategy(times: number): number {
      // Capped exponential backoff so a long outage does not turn into a
      // reconnect storm against the Redis container.
      return Math.min(times * 200, 5_000);
    },
  };
}

/** Creates an ioredis client configured for both direct use and BullMQ reuse. */
export function createRedisClient(redisUrl: string): Redis {
  return new Redis(redisUrl, createRedisConnectionOptions());
}

/**
 * Builds a BullMQ `connection` value that reuses an existing client.
 *
 * Preferred: it keeps one connection per process instead of letting BullMQ open
 * a second one alongside the client used by health probes and application code.
 */
export function createBullConnection(client: Redis): BullConnectionOptions {
  return { connection: client };
}

/**
 * Builds a BullMQ `connection` value from a URL.
 *
 * Use only when a dedicated BullMQ connection is genuinely wanted; BullMQ opens
 * its own client from these options. BullMQ reads `url` out of the options and
 * passes the remainder to ioredis.
 */
export function createBullConnectionOptions(redisUrl: string): BullConnectionOptions {
  return { connection: { ...createRedisConnectionOptions(), url: redisUrl } };
}

/**
 * Probes Redis connectivity.
 *
 * Like the PostgreSQL probe, failures are reported rather than thrown so that a
 * health endpoint can always answer.
 */
export async function probeRedis(
  client: PingableClient,
  timeoutMs: number = DEFAULT_REDIS_PROBE_TIMEOUT_MS,
): Promise<DependencyHealth> {
  const startedAt = Date.now();
  try {
    await withTimeout(Promise.resolve(client.ping()), timeoutMs);
    return { status: 'up', latencyMs: elapsedMs(startedAt) };
  } catch (error) {
    return {
      status: 'down',
      latencyMs: elapsedMs(startedAt),
      error: describeError(error),
    };
  }
}

export type { Redis };
