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

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, {
    ...init,
    credentials: 'same-origin',
    cache: 'no-store',
    headers: {
      ...(init.body ? { 'content-type': 'application/json' } : {}),
      ...(init.method && init.method !== 'GET' ? { 'x-truevine-csrf': csrfToken() } : {}),
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