import {
  ACCEPTED_TERMS,
  ORGANIZATION_PERMISSION,
  PLATFORM_PERMISSION,
} from '../src/auth/permission.decorators.js';
/**
 * Every route that needs a session must declare {@link SessionGuard}.
 *
 * A missing guard does not fail a type check and does not fail a build. It fails
 * at *runtime*, as a 500 from the decorator's own error, and only on the route
 * somebody forgets to click. That is exactly what happened to `POST
 * /auth/sign-out`: the end-to-end suite exercised sign-in thoroughly and
 * sign-out not at all, and the full activation-journey verification caught it.
 *
 * Guard *identity* is checked rather than guard count. `@UseGuards(SessionGuard,
 * CsrfGuard)` stores the actual class references, so `includes(SessionGuard)` is
 * exact - counting guards would pass for a route guarded only by CSRF, which is
 * precisely the bug.
 */

import { RequestMethod } from '@nestjs/common';
import { GUARDS_METADATA, METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { describe, expect, it } from 'vitest';

import { CsrfGuard } from '../src/auth/csrf.guard.js';
import { AuthController } from '../src/auth/auth.controller.js';
import { OrganizationsController } from '../src/organizations/organizations.controller.js';
import { SessionGuard } from '../src/auth/session.guard.js';
import { SupportController } from '../src/support/support.controller.js';

type AnyController = new (...args: never[]) => object;

/** Prototype members that are not route handlers. */
const INHERITED = new Set(['constructor']);

/**
 * Routes that are deliberately reachable without a session.
 *
 * Listed individually rather than inferred, because a new public route should be
 * a deliberate edit here rather than something that silently passes.
 */
const PUBLIC_ROUTES = new Set([
  'AuthController.currentTerms',
  'AuthController.signIn',
  'AuthController.requestPasswordReset',
  'AuthController.completePasswordReset',
]);

/**
 * Auth handlers that change state.
 *
 * Anchored on the whole handler name: an unanchored `acceptTerms` pattern also
 * matches `currentTerms`, which is a read.
 */
const MUTATING_AUTH_HANDLERS = new Set([
  'AuthController.signIn',
  'AuthController.signOut',
  'AuthController.requestPasswordReset',
  'AuthController.completePasswordReset',
  'AuthController.acceptTerms',
  'AuthController.deactivate',
]);

/**
 * Every mutating organization route, named individually.
 *
 * Listing them is the point: a new mutation that forgets `CsrfGuard` shows up as
 * an unknown route rather than quietly inheriting whatever the others do.
 */
const MUTATING_HANDLERS = new Set([
  ...MUTATING_AUTH_HANDLERS,
  'OrganizationsController.updateProfile',
  'OrganizationsController.changeMemberRole',
  'OrganizationsController.removeMember',
  'OrganizationsController.invite',
  'OrganizationsController.revokeInvitation',
  'OrganizationsController.acceptInvitation',
  'OrganizationsController.transferOwnership',
]);

/**
 * Route handlers of a controller.
 *
 * Filtered on `PATH_METADATA`, which Nest sets only on decorated route methods.
 * Without it a private helper such as `membershipSummaries` looks like a route
 * that forgot its guards, which is noise rather than a finding.
 */
function handlersOf(
  controller: AnyController,
): Array<{ name: string; guards: readonly unknown[] }> {
  const prototype = controller.prototype as object;

  return Object.getOwnPropertyNames(prototype)
    .filter((name) => !INHERITED.has(name))
    .flatMap((name) => {
      const handler = (prototype as Record<string, unknown>)[name];

      if (typeof handler !== 'function') return [];
      if (Reflect.getMetadata(PATH_METADATA, handler as object) === undefined) return [];

      return [
        {
          name: `${controller.name}.${name}`,
          guards: (Reflect.getMetadata(GUARDS_METADATA, handler as object) ?? []) as unknown[],
        },
      ];
    });
}

const ROUTES = [
  ...handlersOf(AuthController),
  ...handlersOf(OrganizationsController),
  ...handlersOf(SupportController),
];

describe('route guard coverage', () => {
  it('finds routes, so an empty result cannot pass vacuously', () => {
    expect(ROUTES.length).toBeGreaterThan(8);
  });

  it('declares SessionGuard on every non-public route', () => {
    const missing = ROUTES.filter(
      (route) => !PUBLIC_ROUTES.has(route.name) && !route.guards.includes(SessionGuard),
    ).map((route) => route.name);

    expect(missing).toEqual([]);
  });

  it('declares CsrfGuard on every mutating auth route', () => {
    const missing = ROUTES.filter(
      (route) => MUTATING_AUTH_HANDLERS.has(route.name) && !route.guards.includes(CsrfGuard),
    ).map((route) => route.name);

    expect(missing).toEqual([]);
  });

  it('declares SessionGuard on POST /auth/sign-out specifically', () => {
    // Named explicitly so that removing the guard again produces a failure that
    // names the route rather than a list.
    const signOut = ROUTES.find((route) => route.name === 'AuthController.signOut');

    expect(signOut).toBeDefined();
    expect(signOut?.guards.includes(SessionGuard)).toBe(true);
  });

  it('declares CsrfGuard on every mutating route, not only the auth ones', () => {
    // This is the second regression this file exists for. Every organization
    // mutation - rename, role change, member removal, invitation, ownership
    // transfer - was reachable without a CSRF token, because `Protected` listed
    // only the session and organization guards. Every test that exercised those
    // routes sent a valid token, so nothing noticed.
    const missing = ROUTES.filter(
      (route) => MUTATING_HANDLERS.has(route.name) && !route.guards.includes(CsrfGuard),
    ).map((route) => route.name);

    expect(missing).toEqual([]);
  });

  it('declares a guard on every organization route', () => {
    const unguarded = ROUTES.filter(
      (route) => route.name.startsWith('OrganizationsController.') && route.guards.length === 0,
    ).map((route) => route.name);

    expect(unguarded).toEqual([]);
  });
});

describe('customer API terms coverage', () => {
  it('requires current terms on every organization handler except caller discovery', () => {
    const prototype = OrganizationsController.prototype;
    const handlers = Object.getOwnPropertyNames(prototype).filter(
      (name) =>
        name !== 'me' &&
        name !== 'constructor' &&
        Reflect.getMetadata(
          PATH_METADATA,
          (prototype as unknown as Record<string, object>)[name]!,
        ) !== undefined,
    );
    expect(handlers.length).toBeGreaterThan(8);
    for (const name of handlers)
      expect(
        Reflect.getMetadata(
          ACCEPTED_TERMS,
          (prototype as unknown as Record<string, object>)[name]!,
        ),
        name,
      ).toBe(true);
  });
});

describe('organization route permission declarations', () => {
  /**
   * The permission each organization route must declare, written literally.
   *
   * `OrganizationGuard` reads this metadata at runtime, so this map is the
   * route-level half of the RBAC-002 allow/deny matrix: an ADMIN reaches a
   * route exactly when the registry grants the permission named here, and the
   * guard suite decides every cell of that matrix. `null` means the route is
   * deliberately reachable without an organization permission (session only).
   */
  const EXPECTED: Record<string, string | null> = {
    me: null,
    getProfile: 'organization:read',
    updateProfile: 'organization:update',
    listMembers: 'member:read',
    changeMemberRole: 'member:update',
    removeMember: 'member:remove',
    listInvitations: 'invitation:read',
    invite: 'member:invite',
    revokeInvitation: 'invitation:revoke',
    acceptInvitation: null,
    transferOwnership: 'ownership:transfer',
  };

  function organizationHandlers(): string[] {
    return Object.getOwnPropertyNames(OrganizationsController.prototype).filter(
      (name) =>
        name !== 'constructor' &&
        Reflect.getMetadata(
          PATH_METADATA,
          (OrganizationsController.prototype as unknown as Record<string, object>)[name]!,
        ) !== undefined,
    );
  }

  it('finds handlers, so an empty map cannot pass vacuously', () => {
    expect(organizationHandlers().length).toBeGreaterThan(8);
  });

  it('declares the expected permission on every organization route', () => {
    const handlers = organizationHandlers();

    // Both directions: a renamed or newly added route must be decided here
    // rather than silently inheriting whatever the suite does not check.
    expect([...handlers].sort()).toEqual(Object.keys(EXPECTED).sort());

    for (const name of handlers) {
      const declared =
        Reflect.getMetadata(
          ORGANIZATION_PERMISSION,
          (OrganizationsController.prototype as unknown as Record<string, object>)[name]!,
        ) ?? null;

      expect(declared, name).toBe(EXPECTED[name]);
    }
  });

  it('keeps ownership transfer behind the owner-only permission', () => {
    // RBAC-002 acceptance: an Organization Admin must be refused. The route
    // declares `ownership:transfer`; the registry grants that to OWNER alone;
    // the guard suite asserts the ADMIN denial against exactly that pair.
    const transfer = (OrganizationsController.prototype as unknown as Record<string, object>)
      .transferOwnership!;

    expect(Reflect.getMetadata(ORGANIZATION_PERMISSION, transfer)).toBe('ownership:transfer');
  });

  it('declares no platform permission on any organization route', () => {
    for (const name of organizationHandlers()) {
      expect(
        Reflect.getMetadata(
          PLATFORM_PERMISSION,
          (OrganizationsController.prototype as unknown as Record<string, object>)[name]!,
        ),
        name,
      ).toBeUndefined();
    }
  });
});

describe('support route declarations (RBAC-009)', () => {
  /**
   * The platform permission each support route must declare, written
   * literally. Both directions of the comparison run, so a renamed or newly
   * added route must be decided here. `PlatformGuard` reads this metadata at
   * runtime; the guard suite asserts the allow/deny matrix for each pair.
   */
  const EXPECTED: Record<string, string> = {
    operatorContext: 'platform:support:read',
    searchOrganizations: 'platform:support:read',
    organization: 'platform:support:read',
    diagnostics: 'platform:support:diagnostics',
    organizationAudit: 'platform:audit:read',
    searchUsers: 'platform:support:read',
    user: 'platform:support:read',
    userAudit: 'platform:audit:read',
  };

  function supportHandlers(): string[] {
    return Object.getOwnPropertyNames(SupportController.prototype).filter(
      (name) =>
        name !== 'constructor' &&
        Reflect.getMetadata(
          PATH_METADATA,
          (SupportController.prototype as unknown as Record<string, object>)[name]!,
        ) !== undefined,
    );
  }

  function supportHandler(name: string): object {
    return (SupportController.prototype as unknown as Record<string, object>)[name]!;
  }

  it('finds handlers, so an empty map cannot pass vacuously', () => {
    expect(supportHandlers().length).toBe(8);
  });

  it('declares the expected permission on every support route', () => {
    const handlers = supportHandlers();

    expect([...handlers].sort()).toEqual(Object.keys(EXPECTED).sort());

    for (const name of handlers) {
      expect(Reflect.getMetadata(PLATFORM_PERMISSION, supportHandler(name)), name).toBe(
        EXPECTED[name],
      );
    }
  });

  it('declares only GET routes, so support cannot mutate through this controller', () => {
    for (const name of supportHandlers()) {
      expect(Reflect.getMetadata(METHOD_METADATA, supportHandler(name)), name).toBe(RequestMethod.GET);
    }
  });

  it('declares no organization permission on any support route', () => {
    for (const name of supportHandlers()) {
      expect(Reflect.getMetadata(ORGANIZATION_PERMISSION, supportHandler(name)), name).toBeUndefined();
    }
  });

  it('keeps support routes free of impersonation-style paths', () => {
    // RBAC-009 is read-only lookup. An impersonation or "act as" route is a
    // different capability with different review requirements, and must never
    // appear under this controller by accident.
    for (const name of supportHandlers()) {
      const path = Reflect.getMetadata(PATH_METADATA, supportHandler(name)) as string;
      expect(path, name).not.toMatch(/impersonat|act-as|switch[-_]user|sudo/i);
    }
  });
});
