'use client';

/**
 * Browser-side API client.
 *
 * Every call goes to the same-origin proxy, so the session cookie travels as a
 * cookie and is never read here. The one piece of state this module handles is
 * the CSRF token, which is read from a **deliberately non-HTTP-only** cookie and
 * echoed in a header. That is the whole double-submit pattern; skipping it, or
 * letting the server synthesise the header, would make every mutation forgeable
 * from another origin.
 *
 * A 401 is surfaced as a typed result rather than thrown, so a screen can send the
 * user to sign-in instead of showing a generic failure.
 */

import { browserApiUrl } from './api-target';

const CSRF_COOKIE = 'tv_csrf';
const CSRF_HEADER = 'x-truevine-csrf';

/** The API's error body. */
interface ErrorBody {
  readonly error?: { readonly code?: string; readonly message?: string };
}

/** A failed API call. */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }

  /** True when the caller must sign in again. */
  get isUnauthenticated(): boolean {
    return this.status === 401;
  }

  /** True when the caller is authenticated but not allowed. */
  get isForbidden(): boolean {
    return this.status === 403;
  }
}

/** Reads the CSRF cookie the API issued. */
export function readCsrfToken(): string | undefined {
  if (typeof document === 'undefined') return undefined;

  for (const part of document.cookie.split(';')) {
    const separator = part.indexOf('=');
    if (separator === -1) continue;
    if (part.slice(0, separator).trim() === CSRF_COOKIE) {
      return decodeURIComponent(part.slice(separator + 1).trim());
    }
  }

  return undefined;
}

/** Fetches a CSRF cookie to exist, without reading a secret. */
export async function ensureCsrfToken(): Promise<void> {
  if (readCsrfToken() !== undefined) return;

  // Any GET causes the API's middleware to set the cookie. `/auth/terms` needs
  // no session and returns nothing sensitive.
  await fetch(browserApiUrl('/auth/terms'), { credentials: 'same-origin' }).catch(() => undefined);
}

/** Options for {@link request}. */
interface RequestOptions {
  readonly method?: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  readonly body?: unknown;
}

/**
 * Calls the API.
 *
 * Throws {@link ApiError} on any non-2xx response, with the API's own stable code
 * so a screen can branch on it rather than matching on message text.
 */
export async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const method = options.method ?? 'GET';

  const headers: Record<string, string> = { accept: 'application/json' };

  if (options.body !== undefined) headers['content-type'] = 'application/json';

  if (method !== 'GET') {
    const csrf = readCsrfToken();

    if (!csrf) {
      // Failing loudly here is better than sending a mutation the server will
      // reject with an opaque 403.
      await ensureCsrfToken();
      throw new ApiError(
        0,
        'csrf_token_missing',
        'Could not establish a secure session. Reload and try again.',
      );
    }

    headers[CSRF_HEADER] = csrf;
  }

  const response = await fetch(browserApiUrl(path), {
    method,
    headers,
    credentials: 'same-origin',
    cache: 'no-store',
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });

  if (response.status === 204) return undefined as T;

  const text = await response.text();
  const payload = text.length > 0 ? (JSON.parse(text) as unknown) : undefined;

  if (!response.ok) {
    const body = payload as ErrorBody | undefined;

    throw new ApiError(
      response.status,
      body?.error?.code ?? 'unexpected_error',
      body?.error?.message ?? 'Something went wrong. Please try again.',
    );
  }

  return payload as T;
}

/** Turns any thrown value into a message safe to render. */
export function messageFor(error: unknown): string {
  if (error instanceof ApiError) return error.message;

  return 'Something went wrong. Please try again.';
}
