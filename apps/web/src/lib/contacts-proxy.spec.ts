import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { GET, POST } from '../app/api/[...path]/route';

const apiOrigin = 'http://127.0.0.1:3001';

function request(
  method: 'GET' | 'POST',
  path: string,
  body?: unknown,
  csrf = true,
  session = true,
): NextRequest {
  return new NextRequest(`https://voice.example.invalid/api${path}`, {
    method,
    headers: {
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      cookie: session
        ? 'tv_session=synthetic-session; tv_csrf=synthetic-csrf'
        : 'tv_csrf=synthetic-csrf',
      ...(csrf ? { 'x-truevine-csrf': 'synthetic-csrf' } : {}),
      authorization: 'must-not-forward',
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

describe('contacts same-origin API proxy', () => {
  const upstream = vi.fn<typeof fetch>();

  beforeEach(() => {
    vi.stubEnv('TRUEVINE_API_URL', apiOrigin);
    upstream.mockReset();
    vi.stubGlobal('fetch', upstream);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it('forwards a tenant-scoped contacts read and returns the API response', async () => {
    const result = { items: [], nextCursor: null };
    upstream.mockResolvedValue(Response.json(result));

    const response = await GET(request('GET', '/organizations/tenant-a/contacts'));

    expect(upstream).toHaveBeenCalledExactlyOnceWith(
      `${apiOrigin}/organizations/tenant-a/contacts`,
      expect.objectContaining({ method: 'GET', cache: 'no-store' }),
    );
    const headers = new Headers(upstream.mock.calls[0]?.[1]?.headers);
    expect(headers.get('cookie')).toBe('tv_session=synthetic-session; tv_csrf=synthetic-csrf');
    expect(headers.has('authorization')).toBe(false);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(result);
  });

  it('forwards an import mutation with the caller supplied CSRF token and exact body', async () => {
    const body = { fileName: 'synthetic.csv', csv: 'phone,name\n07720000001,Test' };
    upstream.mockResolvedValue(Response.json({ importId: 'synthetic-import' }, { status: 202 }));

    const response = await POST(request('POST', '/organizations/tenant-a/contact-imports', body));

    expect(upstream).toHaveBeenCalledExactlyOnceWith(
      `${apiOrigin}/organizations/tenant-a/contact-imports`,
      expect.objectContaining({ method: 'POST', body: JSON.stringify(body) }),
    );
    const headers = new Headers(upstream.mock.calls[0]?.[1]?.headers);
    expect(headers.get('x-truevine-csrf')).toBe('synthetic-csrf');
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ importId: 'synthetic-import' });
  });

  it('passes the API authentication denial through for an unauthenticated request', async () => {
    const error = { error: { code: 'unauthenticated' } };
    upstream.mockResolvedValue(Response.json(error, { status: 401 }));

    const response = await GET(
      request('GET', '/organizations/tenant-a/contact-groups', undefined, true, false),
    );

    expect(upstream).toHaveBeenCalledOnce();
    expect(new Headers(upstream.mock.calls[0]?.[1]?.headers).get('cookie')).toBe(
      'tv_csrf=synthetic-csrf',
    );
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual(error);
    expect(response.headers.get('cache-control')).toBe('no-store');
  });

  it('does not invent CSRF proof when a protected import mutation omits the token', async () => {
    upstream.mockResolvedValue(
      Response.json({ error: { code: 'csrf_token_invalid' } }, { status: 403 }),
    );

    const response = await POST(
      request('POST', '/organizations/tenant-a/contact-imports', { fileName: 'x.csv', csv: '' }, false),
    );

    const headers = new Headers(upstream.mock.calls[0]?.[1]?.headers);
    expect(headers.has('x-truevine-csrf')).toBe(false);
    expect(response.status).toBe(403);
  });

  it('refuses unlisted organization paths locally without contacting the API', async () => {
    const response = await GET(request('GET', '/organizations/tenant-a/contacts/def/roles'));

    expect(response.status).toBe(404);
    expect(upstream).not.toHaveBeenCalled();
  });
});
