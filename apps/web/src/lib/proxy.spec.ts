/**
 * The same-origin proxy's allowlist.
 *
 * This is the file's whole security value. The proxy holds an HTTP-only session
 * cookie on the server, so an open proxy would let a caller reach API operations
 * the browser never should. Every case below is either something that must be
 * forwarded or something that must be refused, and the refusals matter more.
 */

import { describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

import { allowedRoutes, buildUpstreamResponse, isAllowed, POST } from '../app/api/[...path]/route';

describe('proxy allowlist', () => {
  describe('forwards the operations the application actually calls', () => {
    const allowed = [
      'POST /auth/sign-in',
      'POST /auth/sign-out',
      'GET /auth/terms',
      'POST /auth/terms/accept',
      'POST /auth/password-reset/request',
      'POST /auth/password-reset/complete',
      'GET /me',
      'GET /organizations/abc',
      'PATCH /organizations/abc',
      'GET /organizations/abc/members',
      'PATCH /organizations/abc/members/def',
      'DELETE /organizations/abc/members/def',
      'GET /organizations/abc/invitations',
      'POST /organizations/abc/invitations',
      'DELETE /organizations/abc/invitations/ghi',
      'POST /organizations/abc/ownership/transfer',
      'GET /organizations/abc/contacts',
      'GET /organizations/abc/audio-assets',
      'GET /organizations/abc/audio-assets/voices',
      'POST /organizations/abc/audio-assets/recordings',
      'POST /organizations/abc/audio-assets/tts',
      'POST /organizations/abc/audio-assets/asset-id/playback-link',
      'GET /organizations/abc/campaigns',
      'POST /organizations/abc/campaigns',
      'PATCH /organizations/abc/campaigns/campaign-id',
      'POST /organizations/abc/contacts',
      'PATCH /organizations/abc/contacts/def',
      'DELETE /organizations/abc/contacts/def',
      'POST /organizations/abc/contacts/def/voice-consent',
      'POST /organizations/abc/contacts/def/suppress',
      'GET /organizations/abc/contact-groups',
      'POST /organizations/abc/contact-groups',
      'GET /organizations/abc/contact-groups/def',
      'PATCH /organizations/abc/contact-groups/def',
      'DELETE /organizations/abc/contact-groups/def',
      'GET /organizations/abc/contact-groups/def/contacts',
      'POST /organizations/abc/contact-groups/def/contacts/ghi',
      'DELETE /organizations/abc/contact-groups/def/contacts/ghi',
      'POST /organizations/abc/contact-imports',
      'POST /organizations/abc/contact-imports/def/batches',
      'POST /organizations/abc/contact-imports/def/complete',
      'GET /organizations/abc/contact-imports/def',
      'POST /invitations/accept',
      'POST /invitations/activate',
    ] as const;

    for (const [method, path] of allowed.map((entry) => entry.split(' '))) {
      it(`${method} ${path}`, () => {
        expect(isAllowed(method!, path!)).toBe(true);
      });
    }
  });

  describe('refuses anything not listed', () => {
    const refused = [
      // Administrative operations that no customer route should ever reach.
      'GET /admin',
      'POST /admin/users',
      'DELETE /users',
      'GET /organizations',
      // Health and diagnostics are not for the browser.
      'GET /health',
      // A path that merely looks similar to an allowed one.
      'GET /organizations/abc/settings/secret',
      'POST /organizations/abc/audio-assets',
      'DELETE /organizations/abc/audio-assets/asset-id',
      'PUT /organizations/abc/audio-assets/asset-id/playback-link',
      'POST /organizations/abc/audio-assets/asset-id/extra',
      'GET /organizations/abc/members/def/permissions',
      // Contact routing stays exact and method-qualified.
      'DELETE /organizations/abc/contacts/def/voice-consent',
      'DELETE /organizations/abc/contacts/def/extra',
      'POST /organizations/abc/contact-groups/def/contacts',
      'DELETE /organizations/abc/contact-groups/def/contacts',
      'PATCH /organizations/abc/contact-groups/def/contacts/ghi',
      'GET /organizations/abc/contact-groups/def/contacts/ghi',
      'POST /organizations/abc/contact-groups/def/contacts/ghi/extra',
      'PUT /organizations/abc/contact-groups/def',
      'PUT /organizations/abc/contact-imports/def/batches',
      'GET /organizations/abc/contact-imports/def/batches',
      'POST /organizations/abc/contact-imports/def/batches/extra',
      // Prototype-pollution style traversal.
      'GET /organizations/../admin',
      'POST /auth/sign-in/../../admin',
      'GET /invitations/activate',
      'PUT /invitations/activate',
      'POST /invitations/activate/extra',
      // Platform-scoped operations belong to RBAC-002 and have no route yet.
      'GET /platform/tenants',
    ] as const;

    for (const [method, path] of refused.map((entry) => entry.split(' '))) {
      it(`${method} ${path}`, () => {
        expect(isAllowed(method!, path!)).toBe(false);
      });
    }
  });

  describe('the method is part of the match', () => {
    it('does not let a GET rule authorise a DELETE', () => {
      // Matching on the path alone would let `DELETE /organizations/x` through on
      // the strength of a `GET` rule, which is how destructive operations get
      // exposed by accident.
      expect(isAllowed('GET', '/organizations/abc')).toBe(true);
      expect(isAllowed('DELETE', '/organizations/abc')).toBe(false);
    });

    it('does not let a read rule authorise a member mutation', () => {
      expect(isAllowed('GET', '/organizations/abc/members')).toBe(true);
      expect(isAllowed('POST', '/organizations/abc/members')).toBe(false);
    });

    it('does not let a member-update rule authorise a member-delete', () => {
      expect(isAllowed('PATCH', '/organizations/abc/members/def')).toBe(true);
      expect(isAllowed('DELETE', '/organizations/abc/members/def')).toBe(true);
      expect(isAllowed('PUT', '/organizations/abc/members/def')).toBe(false);
    });
  });

  describe('path segments', () => {
    it('accepts one organization segment', () => {
      expect(isAllowed('GET', '/organizations/2c3e1f9a-1111-4111-8111-111111111111')).toBe(true);
    });

    it('refuses a nested path that would carry more authority', () => {
      expect(isAllowed('GET', '/organizations/abc/members/def/roles')).toBe(false);
    });

    it('refuses an empty organization segment', () => {
      expect(isAllowed('GET', '/organizations/')).toBe(false);
    });
  });

  it('preserves multipart bytes, boundary and idempotency header for recordings', async () => {
    const priorApiUrl = process.env['TRUEVINE_API_URL'];
    process.env['TRUEVINE_API_URL'] = 'http://api.test';
    const bytes = Uint8Array.from([0x00, 0xff, 0x61, 0x1a, 0x45, 0xdf, 0xa3]);
    const boundary = 'audio-upload-boundary';
    const contentType = `multipart/form-data; boundary=${boundary}`;
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(
        new Response('{"id":"asset"}', {
          status: 201,
          headers: { 'content-type': 'application/json' },
        }),
      );
    try {
      const request = new NextRequest(
        'http://web.test/api/organizations/tenant-a/audio-assets/recordings',
        {
          method: 'POST',
          headers: {
            'content-type': contentType,
            'x-truevine-csrf': 'csrf',
            'idempotency-key': 'recording-key-001',
            cookie: 'tv_session=session',
          },
          body: bytes,
        },
      );
      await POST(request);
      const [, init] = fetchSpy.mock.calls[0]!;
      expect(new Uint8Array(init!.body as ArrayBuffer)).toEqual(bytes);
      expect(new Headers(init!.headers).get('content-type')).toBe(contentType);
      expect(new Headers(init!.headers).get('idempotency-key')).toBe('recording-key-001');
      expect(new Headers(init!.headers).get('cookie')).toBe('tv_session=session');
    } finally {
      fetchSpy.mockRestore();
      if (priorApiUrl === undefined) delete process.env['TRUEVINE_API_URL'];
      else process.env['TRUEVINE_API_URL'] = priorApiUrl;
    }
  });

  describe('building the response the browser receives', () => {
    /**
     * Every operation the browser calls that answers 204.
     *
     * These are the ones that broke. `new Response('', { status: 204 })` throws
     * `Invalid response status code 204`, so a proxy that passed the upstream
     * text through unconditionally returned 500 for all of them — which is the
     * entire write side of the application, including sign-out.
     */
    const BODILESS = [
      'POST /auth/sign-out',
      'POST /auth/terms/accept',
      'DELETE /organizations/:organizationId/members/:userId',
      'DELETE /organizations/:organizationId/invitations/:invitationId',
    ];

    for (const entry of BODILESS) {
      const [method, path] = entry.split(' ');

      it(`returns ${method} ${path} as a 204, not a 500`, async () => {
        // With a header set, because the API's 204s clear the session and CSRF
        // cookies on the way out and those must survive the proxy.
        const upstream = new Response(null, {
          status: 204,
          headers: { 'set-cookie': 'tv_session=; Max-Age=0; Path=/; HttpOnly' },
        });

        const proxied = await buildUpstreamResponse(upstream);

        expect(proxied.status).toBe(204);
        expect(proxied.headers.get('set-cookie')).toContain('tv_session=');
      });
    }

    it('forwards every cookie when the upstream sends more than one', async () => {
      // A sign-in response sets the session cookie and the CSRF cookie
      // together. Forwarding them as one joined header loses everything after
      // the first cookie: the browser cannot read the CSRF token, and every
      // mutation that follows fails the double-submit check.
      const upstreamHeaders = new Headers();
      upstreamHeaders.append('set-cookie', 'tv_session=abc; Path=/; HttpOnly');
      upstreamHeaders.append('set-cookie', 'tv_csrf=xyz; Path=/');

      const proxied = await buildUpstreamResponse(
        new Response(null, { status: 200, headers: upstreamHeaders }),
      );

      expect(proxied.headers.getSetCookie()).toEqual([
        'tv_session=abc; Path=/; HttpOnly',
        'tv_csrf=xyz; Path=/',
      ]);
    });

    it('never caches an authenticated response', async () => {
      for (const status of [200, 204, 401, 403, 404, 500]) {
        const proxied = await buildUpstreamResponse(new Response(null, { status }));

        expect(proxied.headers.get('cache-control')).toBe('no-store');
      }
    });

    it('preserves the upstream status and body on an ordinary response', async () => {
      const upstream = new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });

      const proxied = await buildUpstreamResponse(upstream);

      expect(proxied.status).toBe(200);
      expect(await proxied.text()).toBe('{"ok":true}');
      expect(proxied.headers.get('content-type')).toContain('application/json');
    });

    it('passes a 401 through rather than converting it', async () => {
      // A proxy that turned 401 into 500 would make an expired session look like
      // a server fault, and the browser would show the wrong message.
      const proxied = await buildUpstreamResponse(
        new Response('{"error":{"code":"unauthenticated"}}', { status: 401 }),
      );

      expect(proxied.status).toBe(401);
    });

    it('does not forward a hop-by-hop or body-bearing response header', async () => {
      const proxied = await buildUpstreamResponse(
        new Response('x', {
          status: 200,
          headers: { 'content-length': '999', 'transfer-encoding': 'chunked' },
        }),
      );

      // `content-length: 999` on a one-byte body is how a proxy breaks framing.
      expect(proxied.headers.get('content-length')).toBeNull();
      expect(proxied.headers.get('transfer-encoding')).toBeNull();
    });
  });

  describe('the allowlist itself', () => {
    it('contains no wildcard', () => {
      // A single permissive pattern would void every other assertion above.
      for (const route of allowedRoutes()) {
        expect(route).not.toContain('.*');
        expect(route).not.toMatch(/\\\./);
      }
    });

    it('lists only methods the application uses', () => {
      for (const route of allowedRoutes()) {
        expect(route.split(' ')[0]).toMatch(/^(GET|POST|PATCH|DELETE)$/);
      }
    });
  });
});
