import { NextRequest } from 'next/server';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { GET, PUT } from './[...path]/route';

describe('platform session proxy', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it('forwards the existing same-origin session to GET /me for role-aware navigation', async () => {
    vi.stubEnv('TRUEVINE_API_URL', 'https://api.example.test');
    const fetchMock = vi.fn(
      async (..._args: Parameters<typeof fetch>) =>
        new Response(JSON.stringify({ platformRole: 'AUDITOR' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const request = new NextRequest('https://admin.example.test/admin/api/me', {
      headers: { cookie: 'tv_session=opaque-session' },
    });

    const response = await GET(request, { params: Promise.resolve({ path: ['me'] }) });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ platformRole: 'AUDITOR' });
    const [target, init] = fetchMock.mock.calls[0]!;
    expect(target).toEqual(new URL('/me', 'https://api.example.test'));
    expect((init?.headers as Headers).get('cookie')).toBe('tv_session=opaque-session');
  });

  it('continues to reject paths outside the explicit proxy allowlist', async () => {
    const request = new NextRequest('https://admin.example.test/admin/api/users');
    const response = await GET(request, { params: Promise.resolve({ path: ['users'] }) });
    expect(response.status).toBe(404);
  });

  it('forwards a payment-configuration PUT with its body and CSRF header', async () => {
    vi.stubEnv('TRUEVINE_API_URL', 'https://api.example.test');
    const fetchMock = vi.fn(
      async (..._args: Parameters<typeof fetch>) =>
        new Response(JSON.stringify({ configuration: { status: 'CONFIGURED' } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const body = JSON.stringify({ callbackUrl: 'https://voice.example.test/webhooks/mtn' });
    const request = new NextRequest(
      'https://admin.example.test/admin/api/platform/payments/providers/MTN_MOMO/environments/SANDBOX',
      {
        method: 'PUT',
        headers: {
          cookie: 'tv_session=opaque-session',
          'x-truevine-csrf': 'csrf-value',
          'content-type': 'application/json',
        },
        body,
      },
    );

    const response = await PUT(request, {
      params: Promise.resolve({
        path: ['platform', 'payments', 'providers', 'MTN_MOMO', 'environments', 'SANDBOX'],
      }),
    });

    expect(response.status).toBe(200);
    const [target, init] = fetchMock.mock.calls[0]!;
    expect(target).toEqual(
      new URL(
        '/platform/payments/providers/MTN_MOMO/environments/SANDBOX',
        'https://api.example.test',
      ),
    );
    expect(init?.method).toBe('PUT');
    expect((init?.headers as Headers).get('x-truevine-csrf')).toBe('csrf-value');
    expect(Buffer.from(init?.body as ArrayBuffer).toString()).toBe(body);
  });

  it('allows only the reviewed payment routes', async () => {
    const activation = await GET(new NextRequest('https://admin.example.test/admin/api/x'), {
      params: Promise.resolve({
        path: [
          'platform',
          'payments',
          'providers',
          'AIRTEL_MONEY',
          'environments',
          'PRODUCTION',
          'activation',
        ],
      }),
    });
    expect(activation.status).not.toBe(404);

    const unreviewed = await PUT(
      new NextRequest('https://admin.example.test/admin/api/x', { method: 'PUT' }),
      {
        params: Promise.resolve({
          path: [
            'platform',
            'payments',
            'providers',
            'MTN_MOMO',
            'environments',
            'SANDBOX',
            'test-connection',
          ],
        }),
      },
    );
    expect(unreviewed.status).toBe(404);
  });
});
