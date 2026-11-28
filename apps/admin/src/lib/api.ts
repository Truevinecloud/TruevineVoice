/**
 * Shared fetch helper for the admin application's same-origin API proxy.
 *
 * Extracted from the operations dashboard so the support workspace and any
 * future page talk to the proxy the same way, with one place that knows the
 * CSRF cookie name and the error shape.
 */

export const API_BASE = '/admin/api';

/** A non-2xx response, carrying the status for caller-specific messaging. */
export class ApiError extends Error {
  readonly status: number;
  readonly code?: string;
  readonly detail?: string;

  constructor(status: number, code?: string, detail?: string) {
    super(detail ?? `Request failed (${status})`);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.detail = detail;
  }
}

export function csrfToken(): string {
  return (
    document.cookie
      .split('; ')
      .find((cookie) => cookie.startsWith('tv_csrf='))
      ?.slice('tv_csrf='.length) ?? ''
  );
}

/**
 * Makes sure a CSRF cookie exists before a mutation is attempted.
 *
 * The admin application is reachable on a host that has never loaded the web
 * application, so no `tv_csrf` cookie may exist yet. The API issues one on any
 * request, and `GET /auth/terms` needs no session and returns nothing
 * sensitive. Doing this here rather than in each screen keeps sign-out, role
 * revocation and payment configuration working on a fresh browser.
 */
async function ensureCsrfToken(): Promise<void> {
  if (csrfToken().length > 0) return;

  await fetch(`${API_BASE}/auth/terms`, {
    credentials: 'same-origin',
    cache: 'no-store',
  }).catch(() => undefined);
}

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const method = (init.method ?? 'GET').toUpperCase();
  const mutating = method !== 'GET' && method !== 'HEAD';

  // A mutation without the cookie's value would be rejected by the API's CSRF
  // guard with a 403 that looks like a permissions problem.
  if (mutating) await ensureCsrfToken();

  const response = await fetch(`${API_BASE}${path}`, {
    ...init,
    credentials: 'same-origin',
    cache: 'no-store',
    headers: {
      ...(init.body ? { 'content-type': 'application/json' } : {}),
      ...(mutating ? { 'x-truevine-csrf': csrfToken() } : {}),
      ...init.headers,
    },
  });
  if (!response.ok) {
    let code: string | undefined;
    let detail: string | undefined;
    try {
      const body = (await response.json()) as { error?: { code?: string; message?: string } };
      code = body.error?.code;
      detail = body.error?.message;
    } catch {
      detail = undefined;
    }
    throw new ApiError(response.status, code, detail);
  }
  return (response.status === 204 ? undefined : await response.json()) as T;
}