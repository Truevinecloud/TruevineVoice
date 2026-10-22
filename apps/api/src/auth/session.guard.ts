import { ACCEPTED_TERMS } from './permission.decorators.js';
import { termsAcceptanceRequired } from '@truevine/auth';
/**
 * Session validation.
 *
 * Resolves the session cookie into a `Principal`, or refuses the request. Runs
 * before every organization and platform check, because both of those are
 * questions about a specific person.
 *
 * FAIL CLOSED
 * -----------
 * Every failure path - no cookie, unknown token, expired, revoked, suspended
 * account - produces a 401. Nothing is guessed, and nothing falls back to "let
 * them through and check later": if the caller cannot be established, the answer
 * is no.
 */

import { Inject, Injectable, type CanActivate, type ExecutionContext } from '@nestjs/common';
import { hashToken, permissionDenied, sessionInvalid, unauthenticated } from '@truevine/auth';

import { readSessionToken } from './cookies.js';
import { PRINCIPAL, type AuthenticatedRequest, type Principal } from './principal.js';
import { AUTH_STORE, PLATFORM_ROLE_STORE, TERMS_VERSION, AUDIT_STORE } from './tokens.js';
import type { AuthStore, PlatformRoleStore, AuditStore } from './auth.store.js';

/** Validates the session cookie and attaches a {@link Principal}. */
@Injectable()
export class SessionGuard implements CanActivate {
  constructor(
    @Inject(AUTH_STORE) private readonly authStore: AuthStore,
    @Inject(PLATFORM_ROLE_STORE) private readonly platformRoleStore: PlatformRoleStore,
    @Inject(TERMS_VERSION) private readonly termsVersion: string,
    @Inject(AUDIT_STORE) private readonly audit: AuditStore,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    // Anything that is not an HTTP request (a queue consumer, say) has no
    // session to validate, and therefore cannot be authorised.
    if (context.getType() !== 'http') return false;

    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const token = readSessionToken(request);

    if (!token) throw unauthenticated('Sign in to continue.');

    const now = new Date();
    const session = await this.authStore.findActiveSessionByTokenHash(hashToken(token), now);

    if (!session) throw sessionInvalid('session_revoked');
    if (session.expiresAt.getTime() <= now.getTime()) throw sessionInvalid('session_expired');

    const user = await this.authStore.findUserById(session.userId);

    // A session row that outlived its user, or an account suspended without its
    // sessions being cleared, must stop working.
    if (!user || user.status !== 'ACTIVE') throw sessionInvalid('session_revoked');

    // The platform role is read on every request rather than cached in the
    // session, so revoking an operator takes effect immediately instead of when
    // their cookie happens to expire.
    const assignment = await this.platformRoleStore.findPlatformRole(user.id);

    const principal: Principal = {
      userId: user.id,
      email: user.email,
      sessionId: session.id,
      platformRole: assignment && !assignment.revokedAt ? assignment.role : null,
    };

    if (
      Reflect.getMetadata(ACCEPTED_TERMS, context.getHandler()) === true &&
      !(await this.authStore.hasAcceptedTerms(user.id, this.termsVersion))
    ) {
      await this.audit.recordIdentity({
        actorUserId: user.id,
        action: 'authorization.denied',
        outcome: 'DENIED',
        metadata: { reason: 'terms_not_accepted' },
      });
      throw termsAcceptanceRequired();
    }
    request[PRINCIPAL] = principal;

    // A support capability is deliberately usable only on the one read-only
    // context route and its explicit termination route. Rejecting it here,
    // after the real actor is authenticated but before any business guard or
    // controller runs, prevents a support context from accompanying a customer
    // mutation even when the operator separately has a tenant membership.
    if (request.headers?.['x-support-access-token'] !== undefined) {
      const path = request.url?.split('?')[0];
      const allowedSupportRoute =
        (request.method === 'GET' &&
          typeof path === 'string' &&
          /^\/platform\/support\/organizations\/[^/]+\/diagnostics$/.test(path)) ||
        (request.method === 'POST' && path === '/platform/support/sessions/terminate');
      if (!allowedSupportRoute) {
        await this.audit
          .recordIdentity({
            actorUserId: principal.userId,
            action: 'platform.support.access_denied',
            outcome: 'DENIED',
            metadata: { reason: 'support_context_route_not_allowed' },
          })
          .catch(() => process.stderr.write('[support-access] Denial audit unavailable.\n'));
        throw permissionDenied('Support access is limited to read-only diagnostics.');
      }
    }

    // Best effort. Recording usage must never turn a valid sign-in into a 401.
    await this.authStore.touchSession(session.id, now).catch(() => undefined);

    return true;
  }
}
