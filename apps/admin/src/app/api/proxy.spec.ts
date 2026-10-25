import { NextRequest } from 'next/server';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { GET } from './[...path]/route';

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
});
