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

import { CampaignsController } from '../src/campaigns/campaigns.controller.js';
import { BillingController } from '../src/billing/billing.controller.js';
import { OrganizationGuard } from '../src/auth/organization.guard.js';
import { AuditController } from '../src/audit/audit.controller.js';
import { CsrfGuard } from '../src/auth/csrf.guard.js';
import { AuthController } from '../src/auth/auth.controller.js';
import { PlatformGuard } from '../src/auth/organization.guard.js';
import { OperationsController } from '../src/operations/operations.controller.js';
import { OrganizationsController } from '../src/organizations/organizations.controller.js';
import { SessionGuard } from '../src/auth/session.guard.js';
import { SupportController } from '../src/support/support.controller.js';
import { SupportAccessGuard } from '../src/support/support-access.guard.js';
import { SupportRateLimitGuard } from '../src/support/support-rate-limit.guard.js';
import { TechnicalController } from '../src/technical/technical.controller.js';

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
  'OrganizationsController.activateInvitation',
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
  'SupportController.startSupportAccess',
  'SupportController.terminateSupportAccess',
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
  'OrganizationsController.activateInvitation',
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
  ...handlersOf(CampaignsController),
  ...handlersOf(BillingController),
  ...handlersOf(AuthController),
  ...handlersOf(OrganizationsController),
  ...handlersOf(SupportController),
  ...handlersOf(TechnicalController),
  ...handlersOf(AuditController),
  ...handlersOf(OperationsController),
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

  it('declares CsrfGuard on every mutating authenticated route', () => {
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
        name !== 'activateInvitation' &&
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
    activateInvitation: null,
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
    startSupportAccess: 'platform:support:access',
    terminateSupportAccess: 'platform:support:access',
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
    expect(supportHandlers().length).toBe(10);
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

  it('keeps only the session lifecycle routes mutating and requires CSRF', () => {
    const mutations = new Set(['startSupportAccess', 'terminateSupportAccess']);
    for (const name of supportHandlers()) {
      if (mutations.has(name)) {
        expect(Reflect.getMetadata(METHOD_METADATA, supportHandler(name)), name).toBe(
          RequestMethod.POST,
        );
        const guards = Reflect.getMetadata(GUARDS_METADATA, supportHandler(name)) as unknown[];
        expect(guards).toContain(SessionGuard);
        expect(guards).toContain(PlatformGuard);
        expect(guards).toContain(SupportRateLimitGuard);
        expect(guards).toContain(CsrfGuard);
        continue;
      }
      expect(Reflect.getMetadata(METHOD_METADATA, supportHandler(name)), name).toBe(
        RequestMethod.GET,
      );
    }
    expect(mutations.size).toBe(2);
  });

  it('requires verified support context on tenant diagnostics', () => {
    const guards = Reflect.getMetadata(GUARDS_METADATA, supportHandler('diagnostics')) as unknown[];
    expect(guards).toContain(SessionGuard);
    expect(guards).toContain(PlatformGuard);
    expect(guards).toContain(SupportRateLimitGuard);
    expect(guards).toContain(SupportAccessGuard);
  });

  it('declares no organization permission on any support route', () => {
    for (const name of supportHandlers()) {
      expect(
        Reflect.getMetadata(ORGANIZATION_PERMISSION, supportHandler(name)),
        name,
      ).toBeUndefined();
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

describe('technical route declarations (RBAC-010)', () => {
  /**
   * The platform permission each technical route must declare, written
   * literally. Both directions of the comparison run, so a renamed or newly
   * added route must be decided here. `PlatformGuard` reads this metadata at
   * runtime; the guard suite asserts the allow/deny matrix for each pair.
   */
  const EXPECTED: Record<string, string> = {
    operatorContext: 'platform:technical:read',
    overview: 'platform:technical:read',
    providers: 'platform:technical:read',
    queues: 'platform:technical:read',
    logs: 'platform:technical:read',
    audit: 'platform:audit:read',
  };

  function technicalHandlers(): string[] {
    return Object.getOwnPropertyNames(TechnicalController.prototype).filter(
      (name) =>
        name !== 'constructor' &&
        Reflect.getMetadata(
          PATH_METADATA,
          (TechnicalController.prototype as unknown as Record<string, object>)[name]!,
        ) !== undefined,
    );
  }

  function technicalHandler(name: string): object {
    return (TechnicalController.prototype as unknown as Record<string, object>)[name]!;
  }

  it('finds handlers, so an empty map cannot pass vacuously', () => {
    expect(technicalHandlers().length).toBe(6);
  });

  it('declares the expected permission on every technical route', () => {
    const handlers = technicalHandlers();

    expect([...handlers].sort()).toEqual(Object.keys(EXPECTED).sort());

    for (const name of handlers) {
      expect(Reflect.getMetadata(PLATFORM_PERMISSION, technicalHandler(name)), name).toBe(
        EXPECTED[name],
      );
    }
  });

  it('declares only GET routes, so technical views cannot mutate through this controller', () => {
    for (const name of technicalHandlers()) {
      expect(Reflect.getMetadata(METHOD_METADATA, technicalHandler(name)), name).toBe(
        RequestMethod.GET,
      );
    }
  });

  it('declares no technical write permission on any route', () => {
    // RBAC-010 is read-only. `platform:technical:write` exists in the
    // vocabulary but nothing consumes it; a route claiming it would be the
    // first consumer and must be a deliberate, reviewed change.
    for (const name of technicalHandlers()) {
      expect(Reflect.getMetadata(PLATFORM_PERMISSION, technicalHandler(name)), name).not.toBe(
        'platform:technical:write',
      );
    }
  });

  it('declares no organization permission on any technical route', () => {
    for (const name of technicalHandlers()) {
      expect(
        Reflect.getMetadata(ORGANIZATION_PERMISSION, technicalHandler(name)),
        name,
      ).toBeUndefined();
    }
  });
});

describe('auditor route declarations (RBAC-011)', () => {
  /**
   * The platform permission each auditor route must declare, written literally.
   * Both directions of the comparison run, so a renamed or newly added route
   * must be decided here. `PlatformGuard` reads this metadata at runtime; the
   * guard suite asserts the allow/deny matrix for each pair.
   */
  const EXPECTED: Record<string, string> = {
    operatorContext: 'platform:audit:read',
    overview: 'platform:audit:read',
    organizations: 'platform:tenant:read',
    auditTrail: 'platform:audit:read',
  };

  function auditHandlers(): string[] {
    return Object.getOwnPropertyNames(AuditController.prototype).filter(
      (name) =>
        name !== 'constructor' &&
        Reflect.getMetadata(
          PATH_METADATA,
          (AuditController.prototype as unknown as Record<string, object>)[name]!,
        ) !== undefined,
    );
  }

  function auditHandler(name: string): object {
    return (AuditController.prototype as unknown as Record<string, object>)[name]!;
  }

  it('finds handlers, so an empty map cannot pass vacuously', () => {
    expect(auditHandlers().length).toBe(4);
  });

  it('declares the expected permission on every auditor route', () => {
    const handlers = auditHandlers();

    expect([...handlers].sort()).toEqual(Object.keys(EXPECTED).sort());

    for (const name of handlers) {
      expect(Reflect.getMetadata(PLATFORM_PERMISSION, auditHandler(name)), name).toBe(
        EXPECTED[name],
      );
    }
  });

  it('declares only GET routes, so the auditor cannot mutate through this controller', () => {
    // RBAC-011 acceptance: "all mutation attempts denied". The strongest form
    // of that guarantee is that no mutating route exists to reach in the first
    // place; this is the assertion of it.
    for (const name of auditHandlers()) {
      expect(Reflect.getMetadata(METHOD_METADATA, auditHandler(name)), name).toBe(
        RequestMethod.GET,
      );
    }
  });

  it('declares no permission outside the auditor four', () => {
    // Each route must ask for one of exactly the four permissions the role
    // holds. A route reaching for a fifth capability is a widening of the role
    // by the back door and fails here.
    const auditorPermissions = new Set([
      'platform:tenant:read',
      'platform:operations:read',
      'platform:support:read',
      'platform:audit:read',
    ]);

    for (const name of auditHandlers()) {
      const declared = Reflect.getMetadata(PLATFORM_PERMISSION, auditHandler(name));
      expect(auditorPermissions.has(declared as string), `${name} declares ${declared}`).toBe(true);
    }
  });

  it('declares no organization permission on any auditor route', () => {
    for (const name of auditHandlers()) {
      expect(
        Reflect.getMetadata(ORGANIZATION_PERMISSION, auditHandler(name)),
        name,
      ).toBeUndefined();
    }
  });
});

describe('every platform route is guarded and none is a mutation reachable by an auditor (RBAC-011)', () => {
  /**
   * The auditor must be refused at every platform route it does not hold a
   * permission for. The guard suite proves the per-permission matrix; this
   * proves the *route* side: no platform controller exposes an unguarded route,
   * and every mutating platform route declares a permission the auditor does
   * not hold (the auditor holds only `*:read`).
   *
   * `OperationsController` is included because it is the platform mutation
   * surface an auditor most plausibly might be pointed at (emergency stop), and
   * its routes must be guarded exactly like the read-only ones.
   */
  const PLATFORM_CONTROLLERS: readonly [string, AnyController][] = [
    ['SupportController', SupportController],
    ['TechnicalController', TechnicalController],
    ['AuditController', AuditController],
    ['OperationsController', OperationsController],
  ];

  it('declares PlatformGuard on every route of every platform controller', () => {
    const unguarded: string[] = [];

    for (const [label, controller] of PLATFORM_CONTROLLERS) {
      for (const route of handlersOf(controller)) {
        if (!route.guards.includes(PlatformGuard)) unguarded.push(`${label}:${route.name}`);
      }
    }

    expect(unguarded).toEqual([]);
  });

  it('declares no mutating permission on the three read-only platform controllers', () => {
    // Technical and audit are read-only consoles. Support has explicit session
    // lifecycle routes, but their dedicated permission does not grant customer
    // writes. The set is written literally so new capabilities require review.
    //
    // Checked by set membership rather than a `:read` suffix: `platform:support:
    // diagnostics` is a read whose name does not end in `:read`, so a suffix
    // rule would both miss `platform:tenant:suspend` and falsely reject a
    // legitimate diagnostic read.
    const PLATFORM_MUTATING_PERMISSIONS = new Set([
      'platform:tenant:suspend',
      'platform:operations:write',
      'platform:billing:refund',
      'platform:technical:write',
      'platform:admin:manage',
      'platform:support:access',
    ]);

    for (const [label, controller] of PLATFORM_CONTROLLERS) {
      if (label === 'OperationsController' || label === 'SupportController') continue;

      for (const route of handlersOf(controller)) {
        const method = route.name.split('.')[1]!;
        const meta = Reflect.getMetadata(
          PLATFORM_PERMISSION,
          (controller.prototype as unknown as Record<string, object>)[method]!,
        ) as string | undefined;
        expect(
          PLATFORM_MUTATING_PERMISSIONS.has(meta as string),
          `${route.name} declares mutating ${meta}`,
        ).toBe(false);
      }
    }
  });

  it('guards the operations mutation surface with a permission the auditor lacks', () => {
    // The auditor-most-plausible mutation target is the Operations Admin
    // emergency stop. RBAC-011 requires it to be refused. Two facts together
    // prove it: the route is guarded, and it declares a mutating permission the
    // auditor does not hold (the auditor holds only the four read permissions,
    // asserted in @truevine/auth). The E2E suite exercises the real endpoint.
    const AUDITOR_PERMISSIONS = new Set([
      'platform:tenant:read',
      'platform:operations:read',
      'platform:support:read',
      'platform:audit:read',
    ]);

    const mutating = handlersOf(OperationsController).filter((route) => {
      const method = route.name.split('.')[1]!;
      const verb = Reflect.getMetadata(
        METHOD_METADATA,
        (OperationsController.prototype as unknown as Record<string, object>)[method]!,
      );
      return verb !== RequestMethod.GET;
    });

    // Non-vacuity: there must be at least one mutating operations route to
    // check, or this test proves nothing.
    expect(mutating.length).toBeGreaterThan(0);

    for (const route of mutating) {
      const method = route.name.split('.')[1]!;
      const declared = Reflect.getMetadata(
        PLATFORM_PERMISSION,
        (OperationsController.prototype as unknown as Record<string, object>)[method]!,
      ) as string | undefined;

      expect(route.guards.includes(PlatformGuard), route.name).toBe(true);
      expect(declared, route.name).toBeDefined();
      expect(
        AUDITOR_PERMISSIONS.has(declared as string),
        `${route.name} declares ${declared}, which the auditor holds`,
      ).toBe(false);
    }
  });
});

describe('RBAC-012 tenant route contract', () => {
  it('requires session, organization permission, terms and CSRF on all tenant controllers', () => {
    for (const controller of [OrganizationsController, CampaignsController, BillingController]) {
      for (const name of Object.getOwnPropertyNames(controller.prototype)) {
        const handler = (controller.prototype as unknown as Record<string, object>)[name];
        if (
          name === 'constructor' ||
          !handler ||
          Reflect.getMetadata(PATH_METADATA, handler) === undefined
        )
          continue;
        if (name === 'me' || name === 'acceptInvitation' || name === 'activateInvitation') continue;
        const guards = Reflect.getMetadata(GUARDS_METADATA, handler) as unknown[];
        expect(guards, name).toEqual(
          expect.arrayContaining([SessionGuard, OrganizationGuard, CsrfGuard]),
        );
        expect(Reflect.getMetadata(ORGANIZATION_PERMISSION, handler), name).toBeDefined();
        expect(Reflect.getMetadata(ACCEPTED_TERMS, handler), name).toBe(true);
      }
    }
  });
});
