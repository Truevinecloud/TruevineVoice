/**
 * CSRF protection for cookie-authenticated mutations.
 *
 * WHY THIS IS NEEDED
 * ------------------
 * The session cookie has `SameSite=Lax`, which stops most cross-site POSTs. It is
 * not sufficient on its own: `Lax` allows the cookie on top-level GET
 * navigations, and a same-site subdomain that an attacker can influence is still
 * same-site. A cookie-authenticated mutation therefore needs a second,
 * independent check.
 *
 * DOUBLE SUBMIT
 * -------------
 * The server issues a random CSRF value in a readable cookie. The client echoes
 * it in a header. A cross-site attacker can cause the browser to send the cookie
 * but cannot read it to construct the header, and cannot set the header at all on
 * a cross-origin form or fetch. Both halves are required.
 *
 * Only state-changing methods are checked. A GET has no side effect to forge.
 */

import {
  ForbiddenException,
  Injectable,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common';

import { csrfTokensMatch, readCsrfHeader, readCsrfToken } from './cookies.js';

/** Methods that must carry a valid CSRF token. */
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/** Verifies the double-submit CSRF token on mutations. */
@Injectable()
export class CsrfGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    if (context.getType() !== 'http') return true;

    const request = context.switchToHttp().getRequest<{
      method: string;
      headers?: Record<string, string | string[] | undefined>;
    }>();

    if (SAFE_METHODS.has(request.method.toUpperCase())) return true;

    if (!csrfTokensMatch(readCsrfToken(request), readCsrfHeader(request))) {
      throw new ForbiddenException({
        error: {
          code: 'csrf_token_invalid',
          message: 'This request could not be verified. Reload the page and try again.',
        },
      });
    }

    return true;
  }
}
