import { NextRequest } from 'next/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GET } from './[...path]/route';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});
describe('technical API proxy', () => {
  it.each(['overview', 'providers', 'queues', 'logs', 'audit'])(
    'forwards %s with session, query and upstream status',
    async (section) => {
      vi.stubEnv('TRUEVINE_API_URL', 'http://127.0.0.1:3003');
      const upstream = vi.fn(
        async () => new Response(JSON.stringify({ error: 'forbidden' }), { status: 403 }),
      );
      vi.stubGlobal('fetch', upstream);
      const response = await GET(
        new NextRequest(
          `http://127.0.0.1:3004/admin/api/platform/technical/${section}?action=platform.technical.logs_viewed`,
          { headers: { cookie: 'tv_session=opaque', 'x-truevine-csrf': 'csrf-test' } },
        ),
        { params: Promise.resolve({ path: ['platform', 'technical', section] }) },
      );
      expect(response.status).toBe(403);
      expect(upstream).toHaveBeenCalledWith(
        new URL(
          `http://127.0.0.1:3003/platform/technical/${section}?action=platform.technical.logs_viewed`,
        ),
        expect.objectContaining({ method: 'GET', cache: 'no-store', redirect: 'manual' }),
      );
      const init = (upstream.mock.calls as unknown as [URL, RequestInit][])[0]![1];
      expect((init.headers as Headers).get('cookie')).toBe('tv_session=opaque');
      expect((init.headers as Headers).get('x-truevine-csrf')).toBe('csrf-test');
    },
  );
});
