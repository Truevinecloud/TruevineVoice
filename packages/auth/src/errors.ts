/**
 * The authentication and authorization error taxonomy.
 *
 * Every failure the client can observe has a stable `code`. Clients branch on
 * the code; the message is for humans and must never describe internals.
 *
 * Two rules the rest of the codebase depends on:
 *
 * 1. **Messages are safe to return.** An error thrown here carries no SQL, no
 *    stack, no email address of another user and no hint about whether an
 *    account exists. `SignInFailed` deliberately does not distinguish "no such
 *    user" from "wrong password" - that difference is an account-enumeration
 *    oracle.
 * 2. **Not-found and forbidden are different codes but the same shape.** Both
 *    mean "you do not get this", and both answer `403`. Responding `404` for
 *    another tenant's row would confirm the row exists.
 */

/** Stable machine-readable failure codes. */
export const AUTH_ERROR_CODES = [
  'invalid_credentials',
  'account_suspended',
  'account_locked',
  'session_expired',
  'session_revoked',
  'unauthenticated',
  'terms_acceptance_required',
  'organization_membership_required',
  'permission_denied',
  'invalid_or_expired_token',
  'token_already_used',
  'password_too_weak',
  'email_already_registered',
  'invalid_email',
  'cannot_remove_last_owner',
  'invitation_not_found',
  'cannot_delegate_beyond_own_authority',
] as const;

export type AuthErrorCode = (typeof AUTH_ERROR_CODES)[number];

/**
 * A failure the transport layer can turn into a response.
 *
 * Carries the HTTP status so that a service can throw without a controller
 * having to re-derive which failures are 401 and which are 403. That mapping is
 * a security decision, so it lives with the error rather than at each call site.
 */
export class AuthError extends Error {
  readonly code: AuthErrorCode;
  readonly status: number;

  constructor(code: AuthErrorCode, message: string, status: number) {
    super(message);
    this.name = 'AuthError';
    this.code = code;
    this.status = status;
  }
}

/** No usable session. Always 401. */
export function unauthenticated(message = 'Authentication is required.'): AuthError {
  return new AuthError('unauthenticated', message, 401);
}

/**
 * Authenticated, but not permitted.
 *
 * Also used where the principal may not know whether the resource exists, so
 * the same 403 answers both "forbidden" and "belongs to another tenant".
 */
export function permissionDenied(
  message = 'You do not have permission to perform this action.',
): AuthError {
  return new AuthError('permission_denied', message, 403);
}

/** The session is well-formed but no longer usable. */
export function sessionInvalid(code: 'session_expired' | 'session_revoked'): AuthError {
  return new AuthError(
    code,
    code === 'session_expired'
      ? 'Your session has expired. Sign in again.'
      : 'Your session has been revoked. Sign in again.',
    401,
  );
}

/** Terms of the current version have not been accepted. */
export function termsAcceptanceRequired(): AuthError {
  return new AuthError(
    'terms_acceptance_required',
    'You must accept the current terms before using the application.',
    403,
  );
}

/**
 * Sign-in failed.
 *
 * One code for "no such account", "wrong password" and "malformed request".
 * Distinguishing them tells an attacker which addresses are registered.
 */
export function invalidCredentials(): AuthError {
  return new AuthError('invalid_credentials', 'Email or password is incorrect.', 401);
}

/** Password did not meet the policy. */
export function passwordTooWeak(message: string): AuthError {
  return new AuthError('password_too_weak', message, 400);
}

/** The principal tried to grant authority they do not hold. */
export function cannotDelegate(): AuthError {
  return new AuthError(
    'cannot_delegate_beyond_own_authority',
    'You cannot grant a role with more authority than your own.',
    403,
  );
}

/** Removing or demoting this member would leave the organization without an owner. */
export function cannotRemoveLastOwner(): AuthError {
  return new AuthError(
    'cannot_remove_last_owner',
    'An organization must always have at least one owner.',
    409,
  );
}
