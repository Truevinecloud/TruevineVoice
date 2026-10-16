/**
 * Cookie handling for the session.
 *
 * The session token is never readable by JavaScript and never sent on a
 * cross-site request. Both properties are what make a stolen XSS payload unable
 * to exfiltrate the session.
 *
 * `sameSite: 'lax'` rather than `'strict'` because the application is reached by
 * following a link from an email - a password-reset or invitation link - and
 * `strict` would strip the cookie on the navigation that completes it. Mutations
 * are protected by the CSRF token below rather than by the cookie's SameSite,
 * because SameSite alone does not cover every cross-site vector.
 */

import { createHash, randomBytes } from 'node:crypto';
import type { CookieSerializeOptions } from '@nestjs/common';

/** Name of the cookie carrying the session token. */
export const SESSION_COOKIE = 'tv_session';

/** Name of the cookie carrying the CSRF token. */
export const CSRF_COOKIE = 'tv_csrf';

/** Options for the session cookie. */
export const SESSION_COOKIE_OPTIONS = {
  httpOnly: true,
  secure: true,
  sameSite: 'lax',
  path: '/',
  maxAge: 12 * 60 * 60,
} as const satisfies CookieSerializeOptions;

/**
 * The CSRF cookie is deliberately readable by the browser.
 *
 * That is the entire double-submit pattern: the server issues a value, the
 * client echoes it back in a header, and a cross-site attacker can neither read
 * the cookie nor set the header. `httpOnly` here would break it.
 */
export const CSRF_COOKIE_OPTIONS = {
  httpOnly: false,
  secure: true,
  sameSite: 'lax',
  path: '/',
  maxAge: 12 * 60 * 60,
} as const satisfies CookieSerializeOptions;

/**
 * Options used when clearing a cookie.
 *
 * `maxAge` is omitted deliberately. Express treats `maxAge: 0` as "expire now",
 * but a cleared cookie must carry the *same* `path`, `domain` and `secure` as
 * the cookie it replaces or the browser keeps the original.
 */
export function clearedCookieOptions(options: CookieSerializeOptions): CookieSerializeOptions {
  const { maxAge: _maxAge, ...rest } = options;

  return { ...rest, expires: new Date(0) };
}

/** Header the client echoes the CSRF token back in. */
export const CSRF_HEADER = 'x-truevine-csrf';

/** The minimum a request-like object needs for cookie reading. */
export interface CookieCarrier {
  headers?: Record<string, string | string[] | undefined> | undefined;
}

/** Reads one cookie from a raw request, tolerating an absent header block. */
function readCookie(request: CookieCarrier, name: string): string | undefined {
  const header = request.headers?.['cookie'];

  if (typeof header !== 'string') return undefined;

  for (const part of header.split(';')) {
    const separator = part.indexOf('=');
    if (separator === -1) continue;

    if (part.slice(0, separator).trim() === name) {
      return decodeURIComponent(part.slice(separator + 1).trim());
    }
  }

  return undefined;
}

/** The session token from the request cookie, if present. */
export function readSessionToken(request: CookieCarrier): string | undefined {
  return readCookie(request, SESSION_COOKIE);
}

/** The CSRF token from the request cookie, if present. */
export function readCsrfToken(request: CookieCarrier): string | undefined {
  return readCookie(request, CSRF_COOKIE);
}

/** The CSRF token from the request header, if present. */
export function readCsrfHeader(request: CookieCarrier): string | undefined {
  const value = request.headers?.[CSRF_HEADER];
  return typeof value === 'string' ? value : undefined;
}

/** A fresh CSRF token. 32 bytes, URL-safe. */
export function generateCsrfToken(): string {
  return randomBytes(32).toString('base64url');
}

/**
 * Compares a presented CSRF token with the cookie's, in constant time.
 *
 * A plain `===` on a timing-observable comparison would let an attacker recover
 * the token a byte at a time.
 */
export function csrfTokensMatch(
  cookieValue: string | undefined,
  headerValue: string | undefined,
): boolean {
  if (!cookieValue || !headerValue) return false;

  const left = Buffer.from(cookieValue, 'utf8');
  const right = Buffer.from(headerValue, 'utf8');

  if (left.length !== right.length) return false;

  return createHash('sha256')
    .update(left)
    .digest()
    .equals(createHash('sha256').update(right).digest());
}

/** Truncates an IP to its /24 network for storage. IPv6 falls back to /48. */
export function ipPrefixOf(address: string | undefined): string | null {
  if (!address) return null;

  if (address.includes(':')) return `${address.split(':').slice(0, 3).join(':')}::/48`;

  const octets = address.split('.');
  return octets.length === 4 ? `${octets[0]}.${octets[1]}.${octets[2]}.0/24` : null;
}

/** SHA-256 of the user agent, so a session row holds no personal data verbatim. */
export function hashUserAgent(userAgent: string | undefined): string | null {
  return userAgent ? createHash('sha256').update(userAgent, 'utf8').digest('hex') : null;
}
