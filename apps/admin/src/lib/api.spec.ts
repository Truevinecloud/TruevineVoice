// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';

import { api, csrfToken } from './api';

/** Clears the cookies the API sets, so each test starts from a fresh browser. */
function clearCookies(): void {
  for (const name of ['tv_csrf', 'tv_session']) {
    document.cookie = `${name}=; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT`;
  }
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

describe('admin API client', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    clearCookies();
  });

  it('fetches the CSRF cookie before a mutation when the browser has none', async () => {
    const calls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
        const target = String(input);
        calls.push(target);

        if (target === '/admin/api/auth/terms') {
          // The real API sets the cookie on any request; the stub does the same.
          document.cookie = 'tv_csrf=bootstrapped-token; Path=/';
          return new Response(null, { status: 200 });
        }

        expect(new Headers(init?.headers).get('x-truevine-csrf')).toBe('bootstrapped-token');
        return jsonResponse({ ok: true });
      }),
    );

    await api('/auth/sign-out', { method: 'POST' });

    expect(calls).toEqual(['/admin/api/auth/terms', '/admin/api/auth/sign-out']);
  });

  it('reuses an existing CSRF cookie without an extra round trip', async () => {
    document.cookie = 'tv_csrf=existing-token; Path=/';
    const fetchMock = vi.fn(
      async (..._args: Parameters<typeof fetch>) => jsonResponse({ ok: true }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await api('/platform/admin/roles/abc/revoke', { method: 'POST', body: '{}' });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [target, init] = fetchMock.mock.calls[0]!;
    expect(String(target)).toBe('/admin/api/platform/admin/roles/abc/revoke');
    expect(new Headers(init?.headers).get('x-truevine-csrf')).toBe('existing-token');
  });

  it('does not request a CSRF token for reads', async () => {
    const fetchMock = vi.fn(
      async (..._args: Parameters<typeof fetch>) => jsonResponse({ platformRole: 'SUPPORT_ADMIN' }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await api('/me');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(csrfToken()).toBe('');
  });
});
