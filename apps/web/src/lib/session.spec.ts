/**
 * Server-side session resolution.
 *
 * The important property is the *refusal* mapping: a 401 from the API carries a
 * stable code, and this module turns it into a typed reason the shell can act on.
 * Conflating "expired" with "signed out" would bounce a user to a sign-in screen
 * with no explanation every time their session lapsed.
 *
 * `fetch` is stubbed rather than mocked globally, so the suite asserts on real
 * Response objects and real cookie handling.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { SessionResult } from './session';

/**
 * Replaces the module's dependencies for one test.
 *
 * `currentSession` reads `cookies()` from `next/headers` and reaches the API
 * through `apiRequest`, both of which are environment-bound. Stubbing `fetch` and
 * the cookie store is enough to exercise the mapping honestly.
 */
async function resolve(options: {
  cookie?: string | undefined;
  status?: number;
  body?: unknown;
  throws?: boolean;
}): Promise<SessionResult> {
  vi.resetModules();

  vi.doMock('next/headers', () => ({
    cookies: async () => ({
      get: (name: string) =>
        options.cookie === undefined ? undefined : { name, value: options.cookie },
    }),
  }));

  const fetchMock = vi.fn(async () => {
    if (options.throws === true) throw new Error('connection refused');

    return new Response(JSON.stringify(options.body ?? {}), {
      status: options.status ?? 200,
      headers: { 'content-type': 'application/json' },
    });
  });

  vi.stubGlobal('fetch', fetchMock);

  process.env['TRUEVINE_API_URL'] = 'http://api.test.invalid';

  const { currentSession } = await import('./session');

  return currentSession();
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.doUnmock('next/headers');
});

describe('currentSession', () => {
  it('reports signed out when there is no session cookie', async () => {
    await expect(resolve({ cookie: undefined })).resolves.toEqual({
      ok: false,
      failure: { kind: 'signed_out' },
    });
  });

  it('resolves the caller when the API answers', async () => {
    const me = {
      userId: 'u1',
      email: 'owner@example.invalid',
      platformRole: null,
      termsVersion: '2026-10-01',
      termsAccepted: true,
      memberships: [],
    };

    await expect(resolve({ cookie: 'token-value', status: 200, body: me })).resolves.toEqual({
      ok: true,
      me,
    });
  });

  it('distinguishes an expired session from being signed out', async () => {
    // The sign-in screen says something different for each, so collapsing them
    // would make a lapsed session look like a failed sign-in.
    await expect(
      resolve({
        cookie: 'token',
        status: 401,
        body: { error: { code: 'session_expired' } },
      }),
    ).resolves.toEqual({ ok: false, failure: { kind: 'expired' } });
  });

  it('distinguishes a revoked session', async () => {
    await expect(
      resolve({
        cookie: 'token',
        status: 401,
        body: { error: { code: 'session_revoked' } },
      }),
    ).resolves.toEqual({ ok: false, failure: { kind: 'revoked' } });
  });

  it('treats an unrecognised 401 as signed out', async () => {
    await expect(
      resolve({ cookie: 'token', status: 401, body: { error: { code: 'unauthenticated' } } }),
    ).resolves.toEqual({ ok: false, failure: { kind: 'signed_out' } });
  });

  it('survives a 401 with a body it cannot parse', async () => {
    // A proxy or load balancer returning HTML would otherwise throw here, and a
    // thrown error in a layout takes the whole page down.
    await expect(resolve({ cookie: 'token', status: 401 })).resolves.toEqual({
      ok: false,
      failure: { kind: 'signed_out' },
    });
  });

  it('does not report an unreachable API as signed out', async () => {
    // Otherwise every API outage would bounce users to the sign-in screen and
    // they would think their session had ended.
    await expect(resolve({ cookie: 'token', throws: true })).resolves.toEqual({
      ok: false,
      failure: { kind: 'expired' },
    });
  });

  it('treats a non-401 error as signed out rather than throwing', async () => {
    await expect(
      resolve({ cookie: 'token', status: 500, body: { error: { code: 'boom' } } }),
    ).resolves.toEqual({ ok: false, failure: { kind: 'signed_out' } });
  });
});

describe('publicApiBase', () => {
  afterEach(() => {
    delete process.env['NEXT_PUBLIC_API_URL'];
  });

  it('defaults to the same-origin proxy path', async () => {
    vi.resetModules();
    const { publicApiBase } = await import('./api-target');
    // Reaching the API cross-origin would need credentialed CORS and would
    // defeat the proxy, so the default is a path.
    expect(publicApiBase()).toBe('/api');
  });

  it('refuses an absolute URL', async () => {
    vi.resetModules();
    process.env['NEXT_PUBLIC_API_URL'] = 'https://api.example.invalid';
    const { publicApiBase } = await import('./api-target');

    expect(() => publicApiBase()).toThrow(/same-origin proxy/);
  });

  it('accepts an explicit same-origin path', async () => {
    vi.resetModules();
    process.env['NEXT_PUBLIC_API_URL'] = '/gateway/api/';
    const { publicApiBase } = await import('./api-target');

    expect(publicApiBase()).toBe('/gateway/api');
  });

  it('refuses to build a server-side URL when none is configured', async () => {
    vi.resetModules();
    delete process.env['TRUEVINE_API_URL'];
    const { apiRequest } = await import('./api-target');

    expect(() => apiRequest('/me')).toThrow(/TRUEVINE_API_URL/);
  });
});
