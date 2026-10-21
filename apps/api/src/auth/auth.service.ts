import { mutationAudit } from './sensitive-audit.js';
import { SECURITY_TRANSACTION, type SecurityTransaction } from './security-transaction.js';
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
    @Inject(SECURITY_TRANSACTION) private readonly transactions: SecurityTransaction,
  ) {}

  /**
   * Exchanges credentials for a session.
   *
   * Refusals are deliberately indistinguishable from one another: same status,
   * same message, comparable timing. Anything more specific would tell an
   * attacker which addresses are registered.
   */
  async signIn(email: string, password: string, context: RequestContext): Promise<SignInResult> {
    const limit = await this.rateLimiter.consume(
      `signin:${context.ipPrefix ?? 'unknown'}`,
      SIGN_IN_LIMIT,
      SIGN_IN_WINDOW_MS,
    );
    if (!limit.allowed)
      throw new AuthError(
        'invalid_credentials',
        'Too many sign-in attempts. Try again later.',
        429,
      );
    const normalized = checkEmail(email);
    const user = normalized.ok ? await this.authStore.findUserByEmail(normalized.value) : undefined;
    // Always do password work, including unknown, locked and suspended accounts.
    const matches = await verifyPassword(user?.passwordHash ?? DUMMY_PASSWORD_HASH, password);
    if (!user) throw invalidCredentials();
    const verifiedHash = user.passwordHash;
    const outcome = await this.transactions.run(async (stores) => {
      await stores.lockUser(user.id);
      const current = await stores.auth.findUserById(user.id);
      if (!current) return { allowed: false as const };
      const now = new Date();
      const scoped = new AuthService(
        stores.auth,
        stores.audit,
        this.rateLimiter,
        this.emailSender,
        this.webPublicUrl,
        this.failureLimit,
        this.lockoutMs,
        this.resetCooldownMs,
        this.transactions,
      );
      const locked = current.lockedUntil !== null && current.lockedUntil > now;
      if (!matches || current.passwordHash !== verifiedHash || locked) {
        if (!locked && current.passwordHash === verifiedHash) {
          const beforeLock = {
            failedLoginCount: current.failedLoginCount,
            lockedUntil: current.lockedUntil?.toISOString() ?? null,
          };
          const updated = await stores.auth.recordFailedSignIn(
            user.id,
            this.failureLimit,
            this.lockoutMs,
            now,
          );
          if (updated.lockedUntil)
            await scoped.auditIdentity(user.id, 'auth.account_locked', 'DENIED', {
              until: updated.lockedUntil.toISOString(),
              ...mutationAudit({
                targetType: 'user',
                targetId: user.id,
                before: beforeLock,
                change: { accessLocked: true },
                after: {
                  failedLoginCount: updated.failedLoginCount,
                  lockedUntil: updated.lockedUntil.toISOString(),
                },
                reasonCode: 'invalid_credentials_threshold',
              }),
            });
        }
        await scoped.auditIdentity(user.id, 'auth.sign_in.failed', 'DENIED', {
          reason: 'invalid_credentials',
        });
        return { allowed: false as const };
      }
      if (current.status !== 'ACTIVE') {
        await scoped.auditIdentity(user.id, 'auth.sign_in.failed', 'DENIED', {
          reason: 'suspended',
        });
        return { allowed: false as const };
      }
      await stores.auth.recordSuccessfulSignIn(user.id);
      const session = await scoped.issueSession(user.id, context);
      await scoped.auditIdentity(user.id, 'auth.sign_in.succeeded', 'SUCCESS', {});
      return { allowed: true as const, session };
    });
    // Throw outside the transaction so denial audit/counters are committed.
    if (!outcome.allowed) throw invalidCredentials();
    return outcome.session;
  }

  /** Ends a session. Idempotent: signing out twice is not an error. */
  async signOut(sessionId: string, userId: string): Promise<void> {
    return this.transactions.run(async (stores) => {
      const scoped = new AuthService(
        stores.auth,
        stores.audit,
        this.rateLimiter,
        this.emailSender,
        this.webPublicUrl,
        this.failureLimit,
        this.lockoutMs,
        this.resetCooldownMs,
        this.transactions,
      );

      const revoked = await stores.auth.revokeSession(sessionId, 'signed_out', new Date());
      if (revoked)
        await scoped.auditIdentity(userId, 'auth.session_revoked', 'SUCCESS', {
          reason: 'signed_out',
          ...mutationAudit({
            targetType: 'session',
            targetId: sessionId,
            before: { revoked: false },
            change: { revoked: true },
            after: { revoked: true },
            reasonCode: 'self_sign_out',
          }),
        });
    });
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
    if (!limit.allowed)
      throw new AuthError(
        'invalid_credentials',
        'Too many password reset requests. Try again later.',
        429,
      );
    const normalized = checkEmail(email);
    const user = normalized.ok ? await this.authStore.findUserByEmail(normalized.value) : undefined;
    if (!user) return;
    const raw = generateToken();
    const issued = await this.transactions.run(async (stores) => {
      await stores.lockUser(user.id);
      const current = await stores.auth.findUserById(user.id);
      if (!current || current.status !== 'ACTIVE') return false;
      await stores.auth.revokeAllPasswordResetTokens(user.id);
      await stores.auth.createPasswordResetToken({
        id: randomUUID(),
        userId: user.id,
        tokenHash: hashToken(raw),
        expiresAt: new Date(Date.now() + PASSWORD_RESET_TTL_MS),
      });
      await stores.audit.recordIdentity({
        actorUserId: user.id,
        action: 'auth.password_reset_requested',
        outcome: 'SUCCESS',
        metadata: {},
      });
      return true;
    });
    if (issued)
      await this.emailSender
        .send(
          passwordResetMessage({
            to: user.email,
            resetUrl: this.resetUrl(raw),
            expiresInMinutes: Math.round(PASSWORD_RESET_TTL_MS / 60000),
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
    const found = await this.authStore.findPasswordResetTokenByHash(hashToken(rawToken));
    if (!found)
      throw new AuthError('invalid_or_expired_token', 'This reset link is not valid.', 400);
    const passwordHash = await hashPassword(newPassword);
    const result = await this.transactions.run(async (stores) => {
      await stores.lockUser(found.userId);
      const token = await stores.auth.findPasswordResetTokenByHash(hashToken(rawToken));
      if (!token) return 'invalid';
      if (token.usedAt !== null) {
        // Replays cannot mutate credentials or revoke sessions issued after reset.
        // Otherwise a spent token becomes a permanent account-denial capability.
        await stores.audit.recordIdentity({
          actorUserId: token.userId,
          action: 'auth.password_reset_token_reused',
          outcome: 'DENIED',
          metadata: {},
        });
        return 'used';
      }
      const now = new Date();
      if (token.expiresAt <= now) return 'invalid';
      if (!(await stores.auth.markPasswordResetTokenUsed(token.id, now))) {
        await stores.audit.recordIdentity({
          actorUserId: token.userId,
          action: 'auth.password_reset_token_reused',
          outcome: 'DENIED',
          metadata: {},
        });
        return 'used';
      }
      const before = await stores.auth.findUserById(token.userId);
      const previousCredentialTime = before?.passwordChangedAt.toISOString() ?? null;
      await stores.auth.setPasswordHash(token.userId, passwordHash, now);
      await stores.auth.revokeAllPasswordResetTokens(token.userId);
      await stores.auth.revokeAllSessionsForUser(token.userId, 'password_changed', now);
      await stores.audit.recordIdentity({
        actorUserId: token.userId,
        action: 'auth.password_reset_completed',
        outcome: 'SUCCESS',
        metadata: {
          ...mutationAudit({
            targetType: 'user',
            targetId: token.userId,
            before: { credentialChangedAt: previousCredentialTime },
            change: { credentialsReplaced: true, sessionsRevoked: true },
            after: { credentialChangedAt: now.toISOString() },
            reasonCode: 'credential_recovery',
          }),
          actorKind: 'recovery_capability',
        },
      });
      return 'ok';
    });
    if (result === 'used')
      throw new AuthError(
        'token_already_used',
        'This reset link has already been used. Request a new one.',
        400,
      );
    if (result !== 'ok')
      throw new AuthError('invalid_or_expired_token', 'This reset link is not valid.', 400);
  }

  /** Records acceptance of the current terms version. */
  async acceptTerms(userId: string, termsVersion: string, ipPrefix: string | null): Promise<void> {
    return this.transactions.run(async (stores) => {
      const scoped = new AuthService(
        stores.auth,
        stores.audit,
        this.rateLimiter,
        this.emailSender,
        this.webPublicUrl,
        this.failureLimit,
        this.lockoutMs,
        this.resetCooldownMs,
        this.transactions,
      );

      const acceptedBefore = await stores.auth.hasAcceptedTerms(userId, termsVersion);
      await stores.auth.recordTermsAcceptance(userId, termsVersion, ipPrefix);
      await scoped.auditIdentity(userId, 'terms.accepted', 'SUCCESS', {
        termsVersion,
        ...mutationAudit({
          targetType: 'user',
          targetId: userId,
          before: { termsAccepted: acceptedBefore },
          change: { termsVersion },
          after: { termsAccepted: true },
          reasonCode: 'terms_acceptance',
        }),
      });
    });
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
   * Reactivation requires an operator-reviewed recovery policy. Password reset
   * must not automatically undo a security suspension. There is deliberately no "reactivate me" button: an
   * account a user could switch off and on at will would make suspension
   * meaningless as a response to abuse.
   */
  async deactivateAccount(userId: string): Promise<void> {
    return this.transactions.run(async (stores) => {
      const scoped = new AuthService(
        stores.auth,
        stores.audit,
        this.rateLimiter,
        this.emailSender,
        this.webPublicUrl,
        this.failureLimit,
        this.lockoutMs,
        this.resetCooldownMs,
        this.transactions,
      );
      await stores.lockUser(userId);

      const before = await stores.auth.findUserById(userId);
      const beforeStatus = before?.status ?? null;
      await stores.auth.setUserSuspended(userId, true);
      await stores.auth.revokeAllSessionsForUser(userId, 'account_deactivated', new Date());

      await scoped.auditIdentity(userId, 'auth.account_deactivated', 'SUCCESS', {
        // Reversible, so the reason is recorded for whoever reviews it later.
        reversible: true,
        ...mutationAudit({
          targetType: 'user',
          targetId: userId,
          before: { status: beforeStatus },
          change: { status: 'SUSPENDED', sessionsRevoked: true },
          after: { status: 'SUSPENDED' },
          reasonCode: 'self_deactivation',
        }),
      });
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
