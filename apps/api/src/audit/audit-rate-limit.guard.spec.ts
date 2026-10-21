import { HttpException, HttpStatus, type ExecutionContext } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';

import type { RateLimiter, RateLimitOutcome } from '../auth/rate-limiter.js';
import { PRINCIPAL, type AuthenticatedRequest, type Principal } from '../auth/principal.js';
import {
  AuditRateLimitGuard,
  AUDIT_RATE_LIMIT,
  AUDIT_RATE_WINDOW_MS,
} from './audit-rate-limit.guard.js';

/**
 * The auditor rate limit is the one piece of this module the E2E suite cannot
 * exercise: it overrides the limiter to always-allow so the trail tests are not
 * made flaky by a shared counter. That makes this spec the only place the
 * guard's decision - which key it charges, and that a denied attempt is refused
 * with 429 - is actually asserted.
 */

const PRINCIPAL_VALUE: Principal = {
  userId: 'auditor-1',
  email: 'auditor@example.com',
  sessionId: 'session-1',
  platformRole: 'AUDITOR',
};

function context(request: AuthenticatedRequest, type = 'http'): ExecutionContext {
  return {
    getType: () => type,
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
}

function limiterReturning(outcome: RateLimitOutcome): {
  limiter: RateLimiter;
  consume: ReturnType<typeof vi.fn>;
} {
  const consume = vi.fn(async () => outcome);
  return { limiter: { consume }, consume };
}

describe('AuditRateLimitGuard', () => {
  it('charges the limiter against the operator, not the session or IP', async () => {
    const { limiter, consume } = limiterReturning({ allowed: true, retryAfterMs: 0, remaining: 5 });
    const guard = new AuditRateLimitGuard(limiter);

    const allowed = await guard.canActivate(context({ [PRINCIPAL]: PRINCIPAL_VALUE }));

    expect(allowed).toBe(true);
    expect(consume).toHaveBeenCalledWith('audit:auditor-1', AUDIT_RATE_LIMIT, AUDIT_RATE_WINDOW_MS);
  });

  it('refuses a denied attempt with 429 and a stable error code', async () => {
    const { limiter } = limiterReturning({ allowed: false, retryAfterMs: 1_000, remaining: 0 });
    const guard = new AuditRateLimitGuard(limiter);

    const attempt = guard.canActivate(context({ [PRINCIPAL]: PRINCIPAL_VALUE }));

    await expect(attempt).rejects.toBeInstanceOf(HttpException);
    await attempt.catch((error: HttpException) => {
      expect(error.getStatus()).toBe(HttpStatus.TOO_MANY_REQUESTS);
      expect(error.getResponse()).toMatchObject({ error: { code: 'rate_limited' } });
    });
  });

  it('charges denied-permission probing too, because it runs before the permission check', async () => {
    const { limiter, consume } = limiterReturning({ allowed: true, retryAfterMs: 0, remaining: 1 });
    const guard = new AuditRateLimitGuard(limiter);

    await guard.canActivate(context({ [PRINCIPAL]: PRINCIPAL_VALUE }));

    expect(consume).toHaveBeenCalledTimes(1);
  });

  it('does not charge a request with no principal, leaving SessionGuard to refuse it', async () => {
    const { limiter, consume } = limiterReturning({ allowed: true, retryAfterMs: 0, remaining: 1 });
    const guard = new AuditRateLimitGuard(limiter);

    const allowed = await guard.canActivate(context({}));

    expect(allowed).toBe(true);
    expect(consume).not.toHaveBeenCalled();
  });

  it('ignores non-HTTP contexts', async () => {
    const { limiter, consume } = limiterReturning({ allowed: true, retryAfterMs: 0, remaining: 1 });
    const guard = new AuditRateLimitGuard(limiter);

    const allowed = await guard.canActivate(context({ [PRINCIPAL]: PRINCIPAL_VALUE }, 'rpc'));

    expect(allowed).toBe(true);
    expect(consume).not.toHaveBeenCalled();
  });

  it('fails closed when the limiter reports denial, by propagating rather than allowing', async () => {
    // RedisRateLimiter denies when it cannot reach Redis. The guard must turn
    // that into a refusal, never into an open window.
    const { limiter } = limiterReturning({ allowed: false, retryAfterMs: 60_000, remaining: 0 });
    const guard = new AuditRateLimitGuard(limiter);

    await expect(guard.canActivate(context({ [PRINCIPAL]: PRINCIPAL_VALUE }))).rejects.toThrow();
  });
});
