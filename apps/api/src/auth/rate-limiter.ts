/**
 * Fixed-window rate limiting, backed by the Redis the application already runs.
 *
 * WHY NOT @nestjs/throttler
 * ------------------------
 * `ioredis` is already a dependency, and the surface needed here is one counter
 * with a TTL. Adding a second rate-limiting framework would mean two Redis
 * connections, two configurations and a second thing to reason about, for one
 * operation. AGENTS.md 4 asks for a dependency to be justified; this one was not.
 *
 * WHY FIXED WINDOW, NOT SLIDING
 * -----------------------------
 * A fixed window allows a burst of 2x the limit across a window boundary. That
 * is an accepted trade for sign-in, where the cost of the burst is bounded and
 * the alternative is more state on the hot path. What matters here is that the
 * limiter FAILS CLOSED: if Redis is unreachable the limiter denies rather than
 * allowing unlimited attempts, because "we could not check" must never mean
 * "unlimited".
 */

import { Inject, Injectable } from '@nestjs/common';
import type { Redis } from 'ioredis';

import { REDIS_CLIENT } from '../tokens.js';

/** The decision a limiter returns. */
export interface RateLimitOutcome {
  /** Whether the attempt may proceed. */
  readonly allowed: boolean;
  /** How long to wait, in milliseconds. Meaningless when `allowed`. */
  readonly retryAfterMs: number;
  /** Attempts remaining in the current window. */
  readonly remaining: number;
}

/** Narrow rate-limiting contract, so services never see Redis. */
export interface RateLimiter {
  consume(key: string, limit: number, windowMs: number): Promise<RateLimitOutcome>;
}

/** Namespace so a sign-in counter cannot collide with anything else. */
const NAMESPACE = 'tv:rl';

/** Redis-backed fixed-window limiter. */
@Injectable()
export class RedisRateLimiter implements RateLimiter {
  constructor(
    // The symbol token, not the string "REDIS_CLIENT". A string literal here
    // resolves against a different provider than the one `InfrastructureModule`
    // exports, and Nest reports it as an unresolvable dependency with no hint
    // that the mismatch is a token rather than a missing module.
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
  ) {}

  async consume(key: string, limit: number, windowMs: number): Promise<RateLimitOutcome> {
    const bucket = Math.floor(Date.now() / windowMs);
    const redisKey = `${NAMESPACE}:${key}:${bucket}`;

    try {
      // INCR then EXPIRE. If the process dies between them the key would live
      // forever, so the expiry is re-asserted whenever this is the first hit -
      // which is exactly when INCR returns 1.
      const count = await this.redis.incr(redisKey);
      if (count === 1) await this.redis.expire(redisKey, Math.ceil(windowMs / 1_000) + 1);

      const allowed = count <= limit;

      return {
        allowed,
        retryAfterMs: allowed ? 0 : windowMs - (Date.now() % windowMs),
        remaining: Math.max(0, limit - count),
      };
    } catch {
      // Fail closed. A limiter that cannot answer must not answer "yes".
      return { allowed: false, retryAfterMs: windowMs, remaining: 0 };
    }
  }
}
