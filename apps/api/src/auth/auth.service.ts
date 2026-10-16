/**
 * Sign-in, sign-out, password reset and terms acceptance.
 *
 * Three properties this service exists to guarantee:
 *
 * 1. **No account enumeration.** A wrong email and a wrong password produce the
 *    same 401 with the same message. So does a password-reset request for an
 *    address nobody has registered. Timing is equalised too, so the difference
 *    is not merely in the status code.
 * 2. **No silent failure.** Sign-in attempts, password resets and terms
 *    acceptance all write to the append-only identity audit trail - including the
 *    refusals, because a log of only successes cannot answer "is this an
 *    attack?".
 * 3. **Bounded attempts.** Sign-in and password reset are rate limited, and the
 *    limiter fails closed.
 */

import { randomUUID } from 'node:crypto';

import { Inject, Injectable } from '@nestjs/common';
import {
  AuthError,
  PASSWORD_RESET_TTL_MS,
  SESSION_TTL_MS,
  assertKnownAuditAction,
  checkEmail,
  generateToken,
  hashToken,
  invalidCredentials,
  isSafeAuditMetadata,
  passwordTooWeak,
} from '@truevine/auth';
import { checkPassword, hashPassword, verifyPassword } from '@truevine/auth/passwords';
import { passwordResetMessage, type EmailSender } from '@truevine/messaging';

import type { AuthStore, AuditStore } from './auth.store.js';
import type { RateLimiter } from './rate-limiter.js';
import {
  AUDIT_STORE,
  AUTH_STORE,
  EMAIL_SENDER,
  PASSWORD_RESET_COOLDOWN_MS,
  RATE_LIMITER,
  SIGN_IN_FAILURE_LIMIT,
  SIGN_IN_LOCKOUT_MS,
  WEB_PUBLIC_URL,
} from './tokens.js';

/** Where a request came from, for rate limiting and audit. */
export interface RequestContext {
  readonly ipPrefix: string | null;
  readonly userAgentHash: string | null;
}

/** What a successful sign-in returns. The raw token is returned once. */
export interface SignInResult {
  readonly sessionToken: string;
  readonly csrfToken: string;
  readonly expiresAt: Date;
}

/**
 * A real Argon2id hash of a value nobody knows.
 *
 * Used only to burn the same CPU a genuine verification would, so that "no such
 * user" and "wrong password" take comparable time. It is not a credential:
 * there is no plaintext behind it, it is never compared against a stored user,
 * and it cannot authenticate anybody.
 */
const DUMMY_PASSWORD_HASH =
  '$argon2id$v=19$m=19456,t=2,p=1$c29tZXNhbHR2YWx1ZQ$Zm9yLXRpbWluZy1lcXVhbGlzYXRpb24tb25seQ';

/** Permitted sign-in attempts per IP per window. */
const SIGN_IN_WINDOW_MS = 15 * 60 * 1_000;
const SIGN_IN_LIMIT = 10;

/** Permitted password-reset requests per IP per window. */
const RESET_WINDOW_MS = 60 * 60 * 1_000;
const RESET_LIMIT = 5;

@Injectable()
export class AuthService {
  constructor(
    @Inject(AUTH_STORE) private readonly authStore: AuthStore,
    @Inject(AUDIT_STORE) private readonly auditStore: AuditStore,
    @Inject(RATE_LIMITER) private readonly rateLimiter: RateLimiter,
    @Inject(EMAIL_SENDER) private readonly emailSender: EmailSender,
    @Inject(WEB_PUBLIC_URL) private readonly webPublicUrl: string,
    @Inject(SIGN_IN_FAILURE_LIMIT) private readonly failureLimit: number,
    @Inject(SIGN_IN_LOCKOUT_MS) private readonly lockoutMs: number,
    @Inject(PASSWORD_RESET_COOLDOWN_MS) private readonly resetCooldownMs: number,
  ) {}

  /**
   * Exchanges credentials for a session.
   *
   * Refusals are deliberately indistinguishable from one another: same status,
   * same message, comparable timing. Anything more specific would tell an
   * attacker which addresses are registered.
   */
  async signIn(email: string, password: string, context: RequestContext): Promise<SignInResult> {
    const normalized = checkEmail(email);

    const limit = await this.rateLimiter.consume(
      `signin:${context.ipPrefix ?? 'unknown'}`,
      SIGN_IN_LIMIT,
      SIGN_IN_WINDOW_MS,
    );

    if (!limit.allowed) {
      throw new AuthError(
        'invalid_credentials',
        'Too many sign-in attempts. Try again later.',
        429,
      );
    }

    if (!normalized.ok) throw invalidCredentials();

    const user = await this.authStore.findUserByEmail(normalized.value);

    if (!user) {
      // Burn the same CPU a real verification would, then refuse identically.
      await verifyPassword(DUMMY_PASSWORD_HASH, password);
      throw invalidCredentials();
    }

    if (user.lockedUntil && user.lockedUntil.getTime() > Date.now()) {
      throw new AuthError(
        'account_locked',
        'This account is temporarily locked after too many failed sign-ins.',
        429,
      );
    }

    if (!(await verifyPassword(user.passwordHash, password))) {
      const updated = await this.authStore.recordFailedSignIn(user.id);
      const nowLocked = updated.failedLoginCount >= this.failureLimit;

      await this.auditIdentity(user.id, 'auth.sign_in.failed', 'DENIED', {
        reason: 'bad_password',
      });

      if (nowLocked) {
        await this.auditIdentity(user.id, 'auth.account_locked', 'DENIED', {
          until: new Date(Date.now() + this.lockoutMs).toISOString(),
        });
      }

      throw invalidCredentials();
    }

    if (user.status !== 'ACTIVE') {
      await this.auditIdentity(user.id, 'auth.sign_in.failed', 'DENIED', { reason: 'suspended' });
      throw new AuthError('account_suspended', 'This account is not active.', 403);
    }

    await this.authStore.recordSuccessfulSignIn(user.id);

    const session = await this.issueSession(user.id, context);
    await this.auditIdentity(user.id, 'auth.sign_in.succeeded', 'SUCCESS', {});

    return session;
  }

  /** Ends a session. Idempotent: signing out twice is not an error. */
  async signOut(sessionId: string): Promise<void> {
    await this.authStore.revokeSession(sessionId, 'signed_out', new Date());
  }

  /**
   * Starts a password reset.
   *
   * Always resolves, whether or not the address is registered, because a 404 for
   * an unknown address would make this endpoint an account-existence oracle.
   *
   * When a token is created it is emailed. The raw token exists in exactly two
   * places at this moment: this function's stack frame, and the email body. Only
   * the digest reaches the database.
   */
  async requestPasswordReset(email: string, context: RequestContext): Promise<void> {
    const limit = await this.rateLimiter.consume(
      `reset:${context.ipPrefix ?? 'unknown'}`,
      RESET_LIMIT,
      RESET_WINDOW_MS,
    );

    if (!limit.allowed) {
      throw new AuthError(
        'invalid_credentials',
        'Too many password reset requests. Try again later.',
        429,
      );
    }

    const normalized = checkEmail(email);

    if (!normalized.ok) return;

    const user = await this.authStore.findUserByEmail(normalized.value);

    if (!user || user.status !== 'ACTIVE') return;

    // Every previous token for this account is invalidated, so a link captured
    // earlier stops working the moment a new one is requested.
    await this.authStore.revokeAllPasswordResetTokens(user.id);

    const raw = generateToken();
    const expiresInMinutes = Math.round(PASSWORD_RESET_TTL_MS / 60_000);

    await this.authStore.createPasswordResetToken({
      id: randomUUID(),
      userId: user.id,
      tokenHash: hashToken(raw),
      expiresAt: new Date(Date.now() + PASSWORD_RESET_TTL_MS),
    });

    await this.auditIdentity(user.id, 'auth.password_reset_requested', 'SUCCESS', {
      cooldownMs: this.resetCooldownMs,
    });

    // A delivery failure must not tell the caller anything. The response is
    // identical either way, and the audit row above already records that a reset
    // was requested.
    await this.emailSender
      .send(
        passwordResetMessage({
          to: user.email,
          resetUrl: this.resetUrl(raw),
          expiresInMinutes,
        }),
      )
      .catch(() => undefined);
  }

  /** Builds the reset link from configured public URLs. */
  private resetUrl(token: string): string {
    return `${this.webPublicUrl.replace(/\/$/, '')}/reset-password?token=${encodeURIComponent(token)}`;
  }

  /**
   * Completes a password reset.
   *
   * Single-use. Presenting a spent token is the signal that somebody else may
   * have captured the link, so every live session for that account is destroyed
   * rather than merely changing the password.
   */
  async completePasswordReset(rawToken: string, newPassword: string): Promise<void> {
    const problem = checkPassword(newPassword);

    if (problem) throw passwordTooWeak(this.passwordMessage(problem));

    const token = await this.authStore.findPasswordResetTokenByHash(hashToken(rawToken));

    if (!token) {
      throw new AuthError('invalid_or_expired_token', 'This reset link is not valid.', 400);
    }

    if (token.usedAt !== null) {
      await this.onResetTokenReuse(token.userId);
    }

    if (token.expiresAt.getTime() <= Date.now()) {
      throw new AuthError('invalid_or_expired_token', 'This reset link has expired.', 400);
    }

    const claimed = await this.authStore.markPasswordResetTokenUsed(token.id, new Date());

    // Lost the race against a concurrent completion of the same link.
    if (!claimed) await this.onResetTokenReuse(token.userId);

    await this.authStore.setPasswordHash(token.userId, await hashPassword(newPassword), new Date());

    // Any session opened before the change is stale. Leaving one alive would mean
    // a stolen cookie survives a password reset, which is the scenario a reset
    // exists to end.
    await this.authStore.revokeAllSessionsForUser(token.userId, 'password_changed', new Date());

    await this.auditIdentity(token.userId, 'auth.password_reset_completed', 'SUCCESS', {});
  }

  /** Records acceptance of the current terms version. */
  async acceptTerms(userId: string, termsVersion: string, ipPrefix: string | null): Promise<void> {
    await this.authStore.recordTermsAcceptance(userId, termsVersion, ipPrefix);
    await this.auditIdentity(userId, 'terms.accepted', 'SUCCESS', { termsVersion });
  }

  /**
   * Deactivates the caller's own account.
   *
   * REVERSIBLE. This sets `status = SUSPENDED`; it never deletes a row. Deleting
   * would break every audit reference to the user, and the append-only trigger
   * would refuse it anyway (ADR 0009).
   *
   * Every live session is destroyed. A suspension that left the sessions standing
   * would be reversible by the user rather than by us, which is the opposite of
   * the point.
   *
   * Reactivation goes through the password-reset flow, which requires proof of
   * control of the address. There is deliberately no "reactivate me" button: an
   * account a user could switch off and on at will would make suspension
   * meaningless as a response to abuse.
   */
  async deactivateAccount(userId: string): Promise<void> {
    await this.authStore.setUserSuspended(userId, true);
    await this.authStore.revokeAllSessionsForUser(userId, 'account_deactivated', new Date());

    await this.auditIdentity(userId, 'auth.account_deactivated', 'SUCCESS', {
      // Reversible, so the reason is recorded for whoever reviews it later.
      reversible: true,
    });
  }

  /** Issues a session and returns the raw token exactly once. */
  async issueSession(userId: string, context: RequestContext): Promise<SignInResult> {
    const raw = generateToken();
    const expiresAt = new Date(Date.now() + SESSION_TTL_MS);

    await this.authStore.createSession({
      id: randomUUID(),
      userId,
      tokenHash: hashToken(raw),
      previousTokenHash: null,
      expiresAt,
      userAgentHash: context.userAgentHash,
      ipPrefix: context.ipPrefix,
    });

    return { sessionToken: raw, csrfToken: generateToken(), expiresAt };
  }

  /** A reset token was replayed: destroy every session for that account. */
  private async onResetTokenReuse(userId: string): Promise<never> {
    await this.authStore.revokeAllSessionsForUser(userId, 'reset_token_reused', new Date());
    await this.auditIdentity(userId, 'auth.password_reset_token_reused', 'DENIED', {});

    throw new AuthError(
      'token_already_used',
      'This reset link has already been used. Request a new one.',
      400,
    );
  }

  /** Human wording for a password policy failure. Never echoes the password. */
  private passwordMessage(problem: string): string {
    switch (problem) {
      case 'too_short':
        return 'Password must be at least 12 characters.';
      case 'too_long':
        return 'Password is too long.';
      case 'blank':
        return 'Password cannot be only whitespace.';
      default:
        return 'Password is not acceptable.';
    }
  }

  /**
   * Writes an identity audit row.
   *
   * Refuses anything outside the vocabulary, or any metadata carrying a
   * credential-shaped key. Both throw rather than warn: an audit row nobody can
   * interpret later, or one holding a password, is worse than a failed request.
   */
  private async auditIdentity(
    userId: string,
    action: string,
    outcome: 'SUCCESS' | 'DENIED',
    metadata: Readonly<Record<string, unknown>>,
  ): Promise<void> {
    assertKnownAuditAction(action);

    if (!isSafeAuditMetadata(metadata)) {
      throw new Error('Refusing to write audit metadata containing a credential-shaped key.');
    }

    await this.auditStore.recordIdentity({ actorUserId: userId, action, outcome, metadata });
  }
}
