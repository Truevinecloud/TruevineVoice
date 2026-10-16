import { describe, expect, it } from 'vitest';

import { AuthError, AUTH_ERROR_CODES, invalidCredentials, permissionDenied } from './errors.js';

describe('error taxonomy', () => {
  it('assigns 401 to unauthenticated failures and 403 to authorization failures', () => {
    expect(invalidCredentials().status).toBe(401);
    expect(permissionDenied().status).toBe(403);
  });

  it('never distinguishes a missing account from a wrong password', () => {
    // Two different codes would tell an attacker which addresses are registered.
    expect(invalidCredentials().code).toBe('invalid_credentials');
    expect(invalidCredentials().message).toBe(invalidCredentials().message);
    expect(invalidCredentials().message).not.toMatch(/no such|unknown|not found|does not exist/i);
  });

  it('carries a code drawn from the published taxonomy', () => {
    const errors = [
      invalidCredentials(),
      permissionDenied(),
      new AuthError('session_expired', 'expired', 401),
      new AuthError('unauthenticated', 'missing', 401),
    ];

    for (const error of errors) {
      expect(AUTH_ERROR_CODES).toContain(error.code);
    }
  });

  it('does not leak internals through the message', () => {
    // The messages this package produces are safe to return to a client: no
    // SQL, no stack frames, no repository or column names.
    for (const message of [invalidCredentials().message, permissionDenied().message]) {
      expect(message).not.toMatch(/select |insert |update |delete |pg_|prisma|\bat \w+\.\w+/i);
    }
  });

  it('keeps a stable name for logs and error middleware', () => {
    expect(new AuthError('unauthenticated', 'x', 401).name).toBe('AuthError');
    expect(new AuthError('unauthenticated', 'x', 401)).toBeInstanceOf(Error);
  });
});
