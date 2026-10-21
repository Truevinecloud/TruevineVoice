import {
  CanActivate,
  ExecutionContext,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
} from '@nestjs/common';

import type { RateLimiter } from '../auth/rate-limiter.js';
import { PRINCIPAL, type AuthenticatedRequest } from '../auth/principal.js';
import { RATE_LIMITER } from '../auth/tokens.js';

/**
 * Requests one auditor may make per window.
 *
 * Generous for normal UI use - the auditor home issues a handful of requests
 * per view - and finite so scripted polling of the audit trail is bounded. The
 * constant lives in code, not the environment, for the same reason the sign-in
 * and technical limits do: a value that silently changed with a deployment
 * would change security behaviour without appearing in a diff.
 */
export const AUDIT_RATE_LIMIT = 120;
export const AUDIT_RATE_WINDOW_MS = 60_000;

/**
 * Rate-limits auditor reads per authenticated operator.
 *
 * Runs before {@link PlatformGuard} so that denied-permission probing counts
 * against the budget too. The limiter fails closed by construction (see
 * `RedisRateLimiter`), so an unreachable Redis denies rather than opening an
 * unbounded window.
 */
@Injectable()
export class AuditRateLimitGuard implements CanActivate {
  constructor(@Inject(RATE_LIMITER) private readonly limiter: RateLimiter) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (context.getType() !== 'http') return true;

    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const principal = request[PRINCIPAL];

    // No session to attribute attempts to; SessionGuard runs first and refuses
    // the request regardless.
    if (!principal) return true;

    const outcome = await this.limiter.consume(
      `audit:${principal.userId}`,
      AUDIT_RATE_LIMIT,
      AUDIT_RATE_WINDOW_MS,
    );

    if (!outcome.allowed) {
      throw new HttpException(
        {
          error: {
            code: 'rate_limited',
            message: 'Too many audit requests. Try again later.',
          },
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    return true;
  }
}
