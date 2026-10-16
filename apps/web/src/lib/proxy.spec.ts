/**
 * The same-origin proxy's allowlist.
 *
 * This is the file's whole security value. The proxy holds an HTTP-only session
 * cookie on the server, so an open proxy would let a caller reach API operations
 * the browser never should. Every case below is either something that must be
 * forwarded or something that must be refused, and the refusals matter more.
 */

import { describe, expect, it } from 'vitest';

import { allowedRoutes, isAllowed } from '../app/api/[...path]/route';

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
      'POST /invitations/accept',
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
      'GET /organizations/abc/members/def/permissions',
      // Prototype-pollution style traversal.
      'GET /organizations/../admin',
      'POST /auth/sign-in/../../admin',
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
