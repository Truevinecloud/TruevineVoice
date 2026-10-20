import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DELETE, GET, PATCH, POST, PUT, isAllowed } from '../app/api/[...path]/route';

const origin = 'http://127.0.0.1:3001';
const routes = [
  {
    method: 'PATCH',
    path: '/organizations/tenant-a/billing',
    handler: PATCH,
    body: { name: 'Synthetic billing', email: 'uat@example.invalid', address: 'Test address' },
    status: 200,
    result: { name: 'Synthetic billing' },
  },
  {
    method: 'POST',
    path: '/organizations/tenant-a/wallet/top-ups',
    handler: POST,
    body: {
      amountMinor: '1000',
      currency: 'UGX',
      idempotencyKey: '11111111-1111-4111-8111-111111111111',
    },
    status: 202,
    result: { status: 'PENDING', amountMinor: '1000', currency: 'UGX' },
  },
];

function incoming(method: string, path: string, body?: unknown, csrf = true): NextRequest {
  return new NextRequest(`https://uat.example.invalid/api${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      cookie: 'tv_session=synthetic-session; tv_csrf=synthetic-csrf',
      ...(csrf ? { 'x-truevine-csrf': 'synthetic-csrf' } : {}),
      authorization: 'must-not-forward',
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

describe('billing browser proxy', () => {
  const upstream = vi.fn<typeof fetch>();

  beforeEach(() => {
    vi.stubEnv('TRUEVINE_API_URL', origin);
    upstream.mockReset();
    vi.stubGlobal('fetch', upstream);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it.each(routes)('forwards $method $path with session, CSRF and exact payload', async (route) => {
    upstream.mockResolvedValue(Response.json(route.result, { status: route.status }));
    const response = await route.handler(incoming(route.method, route.path, route.body));
    expect(isAllowed(route.method, route.path)).toBe(true);
    expect(upstream).toHaveBeenCalledExactlyOnceWith(`${origin}${route.path}`, {
      method: route.method,
      headers: expect.any(Headers),
      body: JSON.stringify(route.body),
      redirect: 'manual',
      cache: 'no-store',
    });
    const headers = new Headers(upstream.mock.calls[0]?.[1]?.headers);
    expect(headers.get('cookie')).toBe('tv_session=synthetic-session; tv_csrf=synthetic-csrf');
    expect(headers.get('x-truevine-csrf')).toBe('synthetic-csrf');
    expect(headers.get('content-type')).toBe('application/json');
    expect(headers.has('authorization')).toBe(false);
    expect(response.status).toBe(route.status);
    expect(await response.json()).toEqual(route.result);
    expect(response.headers.get('cache-control')).toBe('no-store');
  });

  it.each([
    { method: 'GET', path: routes[0]!.path, handler: GET },
    { method: 'POST', path: routes[0]!.path, handler: POST },
    { method: 'PUT', path: routes[0]!.path, handler: PUT },
    { method: 'DELETE', path: routes[0]!.path, handler: DELETE },
    { method: 'GET', path: routes[1]!.path, handler: GET },
    { method: 'PATCH', path: routes[1]!.path, handler: PATCH },
    { method: 'DELETE', path: routes[1]!.path, handler: DELETE },
    { method: 'PUT', path: routes[1]!.path, handler: PUT },
    { method: 'PATCH', path: '/organizations//billing', handler: PATCH },
    { method: 'PATCH', path: '/organizations/a/b/billing', handler: PATCH },
    { method: 'PATCH', path: '/organizations/a/billing/extra', handler: PATCH },
    { method: 'PATCH', path: '/organizations/a/billing/', handler: PATCH },
    { method: 'POST', path: '/organizations//wallet/top-ups', handler: POST },
    { method: 'POST', path: '/organizations/a/wallet/top-ups/extra', handler: POST },
    { method: 'POST', path: '/organizations/a/wallet/top-ups/', handler: POST },
    { method: 'POST', path: '/platform/operations/organizations/a/wallet/top-ups', handler: POST },
  ])('rejects $method $path before contacting upstream', async ({ method, path, handler }) => {
    const response = await handler(incoming(method, path));
    expect(response.status).toBe(404);
    expect(upstream).not.toHaveBeenCalled();
  });

  for (const route of routes) {
    it.each([401, 403, 409, 422, 500])(
      `preserves upstream %s for ${route.method} ${route.path}`,
      async (status) => {
        const error = { error: { code: `synthetic_${status}`, message: 'Rejected by API' } };
        upstream.mockResolvedValue(Response.json(error, { status }));
        const response = await route.handler(incoming(route.method, route.path, route.body));
        expect(response.status).toBe(status);
        expect(await response.json()).toEqual(error);
        expect(response.headers.get('cache-control')).toBe('no-store');
      },
    );

    it(`does not invent a CSRF header for ${route.method} ${route.path}`, async () => {
      upstream.mockResolvedValue(Response.json({ error: { code: 'csrf_invalid' } }, { status: 403 }));
      const response = await route.handler(incoming(route.method, route.path, route.body, false));
      const headers = new Headers(upstream.mock.calls[0]?.[1]?.headers);
      expect(headers.has('x-truevine-csrf')).toBe(false);
      expect(response.status).toBe(403);
    });

    it(`returns a sanitized 502 when upstream fails for ${route.method} ${route.path}`, async () => {
      upstream.mockRejectedValue(new Error('private upstream connection detail'));
      const response = await route.handler(incoming(route.method, route.path, route.body));
      expect(response.status).toBe(502);
      expect(await response.text()).not.toContain('private upstream');
    });
  }
});
