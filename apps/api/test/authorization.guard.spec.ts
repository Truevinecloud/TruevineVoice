/**
 * Authorization enforcement, tested through the guards.
 *
 * These are the assertions RBAC-001 is judged on. Each maps to a stated
 * requirement, and each is a *negative* test where negative testing is what
 * proves the control exists.
 *
 * No database, no Redis: every store is an in-memory fake, so the whole suite
 * runs in milliseconds in `npm test`.
 */

import { AuthError, hashToken } from '@truevine/auth';
import { beforeEach, describe, expect, it } from 'vitest';

import { ORGANIZATION_PERMISSION, PLATFORM_PERMISSION } from '../src/auth/permission.decorators.js';
import { OrganizationGuard, PlatformGuard } from '../src/auth/organization.guard.js';
import { SessionGuard } from '../src/auth/session.guard.js';
import { CsrfGuard } from '../src/auth/csrf.guard.js';
import { ORGANIZATION_CONTEXT, PRINCIPAL } from '../src/auth/principal.js';
import { ORGANIZATION_PERMISSIONS, ORGANIZATION_ROLE_PERMISSIONS } from '@truevine/auth';
import {
  CSRF_COOKIE,
  CSRF_HEADER,
  SESSION_COOKIE,
  generateCsrfToken,
} from '../src/auth/cookies.js';
import {
  FakeAuditStore,
  FakeAuthStore,
  FakeOrganizationStore,
  FakePlatformRoleStore,
  aMembership,
  aUser,
  seedOwner,
} from './fakes/auth.fakes.js';

const TERMS = '2026-10-01';

/** The raw cookie value the session fakes below are keyed by. */
const RAW_TOKEN = 'raw-session-token-value';

/** Minimal stand-ins for Nest's ExecutionContext and request. */
function httpContext(options: {
  handler?: object;
  params?: Record<string, string>;
  headers?: Record<string, string>;
  method?: string;
  principal?: unknown;
  organization?: unknown;
}) {
  const request: Record<string, unknown> = {
    params: options.params ?? {},
    headers: options.headers ?? {},
    method: options.method ?? 'GET',
  };

  if (options.principal) request[PRINCIPAL] = options.principal;
  if (options.organization) request[ORGANIZATION_CONTEXT] = options.organization;

  return {
    request,
    context: {
      getType: () => 'http',
      getHandler: () => options.handler ?? {},
      getClass: () => class {},
      switchToHttp: () => ({ getRequest: () => request }),
    } as never,
  };
}

/** A handler carrying a permission requirement. */
function handlerRequiring(metadataKey: string, value: string): Record<symbol, unknown> {
  const handler = (): undefined => undefined;
  Reflect.defineMetadata(metadataKey, value, handler);
  return handler as never;
}

describe('OrganizationGuard', () => {
  let auth: FakeAuthStore;
  let organizations: FakeOrganizationStore;
  let audit: FakeAuditStore;
  let guard: OrganizationGuard;

  /** Marks an organization suspended, the way the guard will read it. */
  const suspend = (organizationId: string) => {
    const organization = organizations.organizations.find((entry) => entry.id === organizationId);

    if (!organization) throw new Error(`No such organization in the fake: ${organizationId}`);

    organization.suspendedAt = new Date('2026-06-01T00:00:00Z');
  };

  beforeEach(() => {
    auth = new FakeAuthStore();
    organizations = new FakeOrganizationStore();
    audit = new FakeAuditStore();
    guard = new OrganizationGuard(organizations, auth, audit, TERMS);
  });

  describe('tenant isolation', () => {
    it('lets a member read their own organization', async () => {
      seedOwner(auth, organizations);
      const { context, request } = httpContext({
        handler: handlerRequiring(ORGANIZATION_PERMISSION, 'organization:read'),
        params: { organizationId: 'org-1' },
        principal: { userId: 'user-1' },
      });

      await expect(guard.canActivate(context)).resolves.toBe(true);
      expect(request[ORGANIZATION_CONTEXT]).toEqual({ organizationId: 'org-1', role: 'OWNER' });
    });

    it('refuses Customer A reading Customer B', async () => {
      // The membership exists for org-a. org-b is somebody else's tenant.
      organizations.memberships.push(aMembership({ organizationId: 'org-a', userId: 'user-a' }));
      organizations.organizations.push({
        id: 'org-b',
        slug: 'beta',
        name: 'Beta',
        suspendedAt: null,
      });

      const { context } = httpContext({
        handler: handlerRequiring(ORGANIZATION_PERMISSION, 'organization:read'),
        params: { organizationId: 'org-b' },
        principal: { userId: 'user-a' },
      });

      await expect(guard.canActivate(context)).rejects.toMatchObject({ status: 403 });
    });

    it('refuses an Organization Admin reaching a tenant they do not belong to', async () => {
      // Being an admin of *your own* organization is not a pass anywhere else.
      // The role is only ever read after the membership lookup, so a foreign
      // path never even reaches the permission check.
      organizations.memberships.push(
        aMembership({ organizationId: 'org-a', userId: 'user-a', role: 'ADMIN' }),
      );
      organizations.organizations.push({
        id: 'org-b',
        slug: 'beta',
        name: 'Beta',
        suspendedAt: null,
      });

      const { context } = httpContext({
        handler: handlerRequiring(ORGANIZATION_PERMISSION, 'member:remove'),
        params: { organizationId: 'org-b' },
        principal: { userId: 'user-a' },
      });

      await expect(guard.canActivate(context)).rejects.toMatchObject({ status: 403 });
      expect(audit.events[0]).toMatchObject({
        organizationId: 'org-b',
        action: 'authorization.denied',
        outcome: 'DENIED',
        metadata: { reason: 'no_membership' },
      });
    });

    it('refuses every request to a suspended organization, including its own Owner', async () => {
      // Suspension must not be a permission question. An Owner holds every
      // organization permission there is, so a check placed after the permission
      // lookup would wave a suspended tenant straight through.
      seedOwner(auth, organizations);
      suspend('org-1');

      const { context } = httpContext({
        handler: handlerRequiring(ORGANIZATION_PERMISSION, 'organization:read'),
        params: { organizationId: 'org-1' },
        principal: { userId: 'user-1' },
      });

      await expect(guard.canActivate(context)).rejects.toMatchObject({ status: 403 });
    });

    it('allows an Owner again once the suspension is lifted', async () => {
      // The reversibility the column exists for. If this fails, "suspend" is a
      // one-way door dressed up as a reversible action.
      seedOwner(auth, organizations);
      suspend('org-1');

      await organizations.setOrganizationSuspended('org-1', false);

      const { context } = httpContext({
        handler: handlerRequiring(ORGANIZATION_PERMISSION, 'organization:read'),
        params: { organizationId: 'org-1' },
        principal: { userId: 'user-1' },
      });

      await expect(guard.canActivate(context)).resolves.toBe(true);
    });

    it('records the suspension denial with a reason that names the cause', async () => {
      seedOwner(auth, organizations);
      suspend('org-1');

      const { context } = httpContext({
        handler: handlerRequiring(ORGANIZATION_PERMISSION, 'organization:read'),
        params: { organizationId: 'org-1' },
        principal: { userId: 'user-1' },
      });

      await expect(guard.canActivate(context)).rejects.toMatchObject({ status: 403 });
      // A generic `authorization.denied` row would leave an operator unable to
      // tell a suspension apart from a permission mistake.
      expect(audit.events[0]).toMatchObject({
        action: 'authorization.denied',
        outcome: 'DENIED',
        metadata: { reason: 'organization_suspended' },
      });
    });

    it('gives the same 403 for a tenant that does not exist', async () => {
      // A 404 for a missing organization and a 403 for someone else's would let
      // a caller enumerate which tenants exist. Both must look identical.
      const mine = httpContext({
        handler: handlerRequiring(ORGANIZATION_PERMISSION, 'organization:read'),
        params: { organizationId: 'org-does-not-exist' },
        principal: { userId: 'user-a' },
      });

      const theirs = httpContext({
        handler: handlerRequiring(ORGANIZATION_PERMISSION, 'organization:read'),
        params: { organizationId: 'org-b' },
        principal: { userId: 'user-a' },
      });

      const missing = (await guard
        .canActivate(mine.context)
        .catch((e: AuthError) => e)) as AuthError;
      const foreign = (await guard
        .canActivate(theirs.context)
        .catch((e: AuthError) => e)) as AuthError;

      expect(missing).toMatchObject({ status: 403, code: 'permission_denied' });
      expect(foreign).toMatchObject({ status: 403, code: 'permission_denied' });
      expect(missing.message).toBe(foreign.message);
    });

    it('scopes the membership lookup to the organization in the path', async () => {
      seedOwner(auth, organizations);

      const { context } = httpContext({
        handler: handlerRequiring(ORGANIZATION_PERMISSION, 'organization:read'),
        params: { organizationId: 'org-1' },
        principal: { userId: 'user-1' },
      });

      await guard.canActivate(context);

      expect(organizations.scopedCalls).toEqual(['org-1']);
    });

    it('refuses when the route carries no organization at all', async () => {
      const { context } = httpContext({
        handler: handlerRequiring(ORGANIZATION_PERMISSION, 'organization:read'),
        params: {},
        principal: { userId: 'user-1' },
      });

      await expect(guard.canActivate(context)).rejects.toMatchObject({ status: 403 });
    });

    it('refuses when the guard ran without a session', async () => {
      const { context } = httpContext({
        handler: handlerRequiring(ORGANIZATION_PERMISSION, 'organization:read'),
        params: { organizationId: 'org-1' },
      });

      await expect(guard.canActivate(context)).rejects.toMatchObject({ status: 403 });
    });
  });

  describe('role permissions', () => {
    // The Organization Admin matrix, written out literally rather than derived
    // from `ORGANIZATION_ROLE_PERMISSIONS`: a test that recomputes the expected
    // answer from the implementation passes even when the implementation is
    // wrong. RBAC-002 judges the ADMIN rows against this independent list -
    // every organization permission, allow or deny, decided here.
    const ADMIN_MATRIX = [
      { permission: 'organization:read', allowed: true },
      { permission: 'organization:update', allowed: true },
      { permission: 'member:read', allowed: true },
      { permission: 'member:invite', allowed: true },
      { permission: 'member:update', allowed: true },
      { permission: 'member:remove', allowed: true },
      { permission: 'invitation:read', allowed: true },
      { permission: 'invitation:revoke', allowed: true },
      { permission: 'campaign:read', allowed: true },
      { permission: 'campaign:create', allowed: true },
      { permission: 'campaign:update', allowed: true },
      { permission: 'campaign:delete', allowed: true },
      { permission: 'reporting:read', allowed: true },
      // The four an admin administers the organization without: ownership and
      // money. Denials are asserted here so a silent grant fails the suite.
      { permission: 'ownership:transfer', allowed: false },
      { permission: 'billing:read', allowed: false },
      { permission: 'billing:update', allowed: false },
      { permission: 'wallet:read', allowed: false },
    ] as const;

    const cases = [
      ...ADMIN_MATRIX.map(({ permission, allowed }) => ({
        role: 'ADMIN' as const,
        permission,
        allowed,
      })),
      { role: 'CAMPAIGN_MANAGER', permission: 'campaign:create', allowed: true },
      { role: 'CAMPAIGN_MANAGER', permission: 'member:invite', allowed: false },
      { role: 'CAMPAIGN_MANAGER', permission: 'ownership:transfer', allowed: false },
      { role: 'BILLING', permission: 'billing:update', allowed: true },
      { role: 'BILLING', permission: 'member:read', allowed: false },
      { role: 'VIEWER', permission: 'organization:read', allowed: true },
      { role: 'VIEWER', permission: 'organization:update', allowed: false },
      { role: 'VIEWER', permission: 'member:remove', allowed: false },
      { role: 'VIEWER', permission: 'campaign:delete', allowed: false },
    ] as const;

    for (const { role, permission, allowed } of cases) {
      it(`${allowed ? 'allows' : 'refuses'} ${role} -> ${permission}`, async () => {
        organizations.memberships.push(
          aMembership({ organizationId: 'org-1', userId: 'user-1', role }),
        );

        const { context } = httpContext({
          handler: handlerRequiring(ORGANIZATION_PERMISSION, permission),
          params: { organizationId: 'org-1' },
          principal: { userId: 'user-1' },
        });

        if (allowed) {
          await expect(guard.canActivate(context)).resolves.toBe(true);
        } else {
          await expect(guard.canActivate(context)).rejects.toMatchObject({ status: 403 });
        }
      });
    }

    it('decides every organization permission for ADMIN, so a new one forces a row here', () => {
      expect([...ADMIN_MATRIX.map(({ permission }) => permission)].sort()).toEqual(
        [...ORGANIZATION_PERMISSIONS].sort(),
      );
    });

    it('denies an ADMIN probe with the same 403 and an audit row', async () => {
      organizations.memberships.push(
        aMembership({ organizationId: 'org-1', userId: 'user-1', role: 'ADMIN' }),
      );

      const { context } = httpContext({
        handler: handlerRequiring(ORGANIZATION_PERMISSION, 'ownership:transfer'),
        params: { organizationId: 'org-1' },
        principal: { userId: 'user-1' },
      });

      await expect(guard.canActivate(context)).rejects.toMatchObject({
        status: 403,
        code: 'permission_denied',
      });
      expect(audit.events[0]).toMatchObject({
        organizationId: 'org-1',
        actorUserId: 'user-1',
        action: 'authorization.denied',
        outcome: 'DENIED',
        metadata: { permission: 'ownership:transfer', reason: 'insufficient_permission' },
      });
    });
  });

  describe('RBAC-003: Campaign Manager reach', () => {
    // The campaign permissions, decided through the guard for every
    // organization role that matters to the RBAC-003 acceptance criteria.
    // Written out independently of the registry, so a registry edit that widens
    // a campaign permission - or narrows one the campaign manager is supposed to
    // hold - fails here rather than silently changing behaviour.
    const CAMPAIGN_PERMISSIONS = [
      'campaign:read',
      'campaign:create',
      'campaign:update',
      'campaign:delete',
    ] as const;

    /**
     * Roles that must never reach a campaign *mutation*. `VIEWER` is
     * deliberately absent: read-only visibility of campaigns is part of what a
     * viewer is, and the registry grants it `campaign:read` on purpose. The
     * registry - not this test - is the design authority for that row.
     */
    const NO_CAMPAIGN_MUTATION_ROLES = ['BILLING', 'VIEWER'] as const;

    /** `BILLING` must not reach even the read route. */
    const NO_CAMPAIGN_ACCESS_ROLES = ['BILLING'] as const;

    /** What `CAMPAIGN_MANAGER` must not hold, stated as omissions from its row. */
    const CAMPAIGN_MANAGER_PROHIBITED = [
      'member:read',
      'member:invite',
      'member:update',
      'member:remove',
      'invitation:read',
      'invitation:revoke',
      'ownership:transfer',
      'organization:update',
      'billing:read',
      'billing:update',
      'wallet:read',
    ] as const;

    const asMember = (role: 'CAMPAIGN_MANAGER' | (typeof NO_CAMPAIGN_MUTATION_ROLES)[number]) => {
      organizations.memberships.push(
        aMembership({ organizationId: 'org-1', userId: 'user-1', role }),
      );
    };

    const probe = (permission: string, organizationId = 'org-1') =>
      httpContext({
        handler: handlerRequiring(ORGANIZATION_PERMISSION, permission),
        params: { organizationId },
        principal: { userId: 'user-1' },
      });

    for (const permission of CAMPAIGN_PERMISSIONS) {
      it(`allows CAMPAIGN_MANAGER -> ${permission}`, async () => {
        asMember('CAMPAIGN_MANAGER');

        await expect(guard.canActivate(probe(permission).context)).resolves.toBe(true);
      });
    }

    // Mutations are refused for both roles; read is refused only for BILLING.
    const mutationPermissions = CAMPAIGN_PERMISSIONS.filter((p) => p !== 'campaign:read');

    for (const permission of mutationPermissions) {
      for (const role of NO_CAMPAIGN_MUTATION_ROLES) {
        it(`refuses ${role} -> ${permission} with 403`, async () => {
          asMember(role);

          await expect(guard.canActivate(probe(permission).context)).rejects.toMatchObject({
            status: 403,
            code: 'permission_denied',
          });
        });
      }
    }

    for (const role of NO_CAMPAIGN_ACCESS_ROLES) {
      it(`refuses ${role} -> campaign:read with 403`, async () => {
        asMember(role);

        await expect(guard.canActivate(probe('campaign:read').context)).rejects.toMatchObject({
          status: 403,
          code: 'permission_denied',
        });
      });
    }

    it('allows VIEWER -> campaign:read, because read-only visibility is deliberate', async () => {
      asMember('VIEWER');

      await expect(guard.canActivate(probe('campaign:read').context)).resolves.toBe(true);
    });

    for (const permission of CAMPAIGN_MANAGER_PROHIBITED) {
      it(`refuses CAMPAIGN_MANAGER -> ${permission} with 403`, async () => {
        asMember('CAMPAIGN_MANAGER');

        await expect(guard.canActivate(probe(permission).context)).rejects.toMatchObject({
          status: 403,
          code: 'permission_denied',
        });
      });
    }

    it('records the campaign denial with the permission it refused and its reason', async () => {
      asMember('BILLING');

      await expect(guard.canActivate(probe('campaign:create').context)).rejects.toMatchObject({
        status: 403,
      });

      expect(audit.events[0]).toMatchObject({
        organizationId: 'org-1',
        actorUserId: 'user-1',
        action: 'authorization.denied',
        outcome: 'DENIED',
        metadata: { permission: 'campaign:create', reason: 'insufficient_permission' },
      });
    });

    it("refuses a CAMPAIGN_MANAGER of one tenant reaching another tenant's campaigns", async () => {
      // Being a campaign manager of *your own* organization is not a pass
      // anywhere else. The role is only ever read after the membership lookup,
      // so a foreign path never even reaches the permission check.
      asMember('CAMPAIGN_MANAGER');
      organizations.organizations.push({
        id: 'org-b',
        slug: 'beta',
        name: 'Beta',
        suspendedAt: null,
      });

      await expect(
        guard.canActivate(probe('campaign:read', 'org-b').context),
      ).rejects.toMatchObject({
        status: 403,
        code: 'permission_denied',
      });

      expect(audit.events[0]).toMatchObject({
        organizationId: 'org-b',
        action: 'authorization.denied',
        outcome: 'DENIED',
        metadata: { reason: 'no_membership' },
      });
    });

    it('still refuses before the current terms are accepted', async () => {
      // The campaign routes carry `@RequireAcceptedTerms()`; reaching the
      // permission check without accepted terms must not be possible.
      asMember('CAMPAIGN_MANAGER');

      const handler = handlerRequiring(ORGANIZATION_PERMISSION, 'campaign:create');
      Reflect.defineMetadata('truevine:accepted-terms', true, handler);

      const { context } = httpContext({
        handler,
        params: { organizationId: 'org-1' },
        principal: { userId: 'user-1' },
      });

      await expect(guard.canActivate(context)).rejects.toMatchObject({
        code: 'terms_acceptance_required',
        status: 403,
      });
    });
  });

  describe('terms acceptance', () => {
    it('refuses protected use before the current terms are accepted', async () => {
      seedOwner(auth, organizations);

      const handler = handlerRequiring(ORGANIZATION_PERMISSION, 'organization:read');
      Reflect.defineMetadata('truevine:accepted-terms', true, handler);

      const { context } = httpContext({
        handler,
        params: { organizationId: 'org-1' },
        principal: { userId: 'user-1' },
      });

      await expect(guard.canActivate(context)).rejects.toMatchObject({
        code: 'terms_acceptance_required',
        status: 403,
      });
    });

    it('allows protected use once accepted', async () => {
      seedOwner(auth, organizations);
      auth.terms.push({ userId: 'user-1', termsVersion: TERMS });

      const handler = handlerRequiring(ORGANIZATION_PERMISSION, 'organization:read');
      Reflect.defineMetadata('truevine:accepted-terms', true, handler);

      const { context } = httpContext({
        handler,
        params: { organizationId: 'org-1' },
        principal: { userId: 'user-1' },
      });

      await expect(guard.canActivate(context)).resolves.toBe(true);
    });

    it('treats acceptance of an older version as not accepted', async () => {
      seedOwner(auth, organizations);
      auth.terms.push({ userId: 'user-1', termsVersion: '2026-01-01' });

      const handler = handlerRequiring(ORGANIZATION_PERMISSION, 'organization:read');
      Reflect.defineMetadata('truevine:accepted-terms', true, handler);

      const { context } = httpContext({
        handler,
        params: { organizationId: 'org-1' },
        principal: { userId: 'user-1' },
      });

      await expect(guard.canActivate(context)).rejects.toMatchObject({
        code: 'terms_acceptance_required',
      });
    });
  });

  describe('audit of denials', () => {
    it('records a refusal with DENIED', async () => {
      organizations.memberships.push(
        aMembership({ organizationId: 'org-1', userId: 'user-1', role: 'VIEWER' }),
      );

      const { context } = httpContext({
        handler: handlerRequiring(ORGANIZATION_PERMISSION, 'organization:update'),
        params: { organizationId: 'org-1' },
        principal: { userId: 'user-1' },
      });

      await expect(guard.canActivate(context)).rejects.toMatchObject({ status: 403 });

      expect(audit.events).toHaveLength(1);
      expect(audit.events[0]).toMatchObject({
        organizationId: 'org-1',
        actorUserId: 'user-1',
        action: 'authorization.denied',
        outcome: 'DENIED',
        metadata: { permission: 'organization:update', reason: 'insufficient_permission' },
      });
    });

    it('records a cross-tenant attempt', async () => {
      const { context } = httpContext({
        handler: handlerRequiring(ORGANIZATION_PERMISSION, 'organization:read'),
        params: { organizationId: 'org-b' },
        principal: { userId: 'user-a' },
      });

      await expect(guard.canActivate(context)).rejects.toMatchObject({ status: 403 });

      expect(audit.events[0]).toMatchObject({
        outcome: 'DENIED',
        metadata: { reason: 'no_membership' },
      });
    });

    it('does not record a refusal as a success', async () => {
      organizations.memberships.push(
        aMembership({ organizationId: 'org-1', userId: 'user-1', role: 'VIEWER' }),
      );

      const { context } = httpContext({
        handler: handlerRequiring(ORGANIZATION_PERMISSION, 'member:invite'),
        params: { organizationId: 'org-1' },
        principal: { userId: 'user-1' },
      });

      await guard.canActivate(context).catch(() => undefined);

      expect(audit.events.every((event) => event.outcome === 'DENIED')).toBe(true);
    });

    it('still refuses when the audit write fails', async () => {
      const failing = new FakeAuditStore();
      failing.record = () => Promise.reject(new Error('audit store unavailable'));
      const guarded = new OrganizationGuard(organizations, auth, failing, TERMS);

      organizations.memberships.push(
        aMembership({ organizationId: 'org-1', userId: 'user-1', role: 'VIEWER' }),
      );

      const { context } = httpContext({
        handler: handlerRequiring(ORGANIZATION_PERMISSION, 'organization:update'),
        params: { organizationId: 'org-1' },
        principal: { userId: 'user-1' },
      });

      // A broken audit sink must not turn into a 500 that reveals the difference
      // between "refused" and "refused and recorded".
      await expect(guarded.canActivate(context)).rejects.toMatchObject({
        status: 403,
        code: 'permission_denied',
      });
    });
  });

  it('fails closed when a guarded route omits its organization requirement', async () => {
    const { context } = httpContext({ params: {}, principal: { userId: 'user-1' } });

    await expect(guard.canActivate(context)).rejects.toMatchObject({ status: 403 });
  });

  it('never records a platform-scoped action in the organization namespace', () => {
    // Structural check: an OrganizationOwner permission set must not contain a
    // single `platform:` string.
    for (const permission of ORGANIZATION_ROLE_PERMISSIONS.OWNER) {
      expect(permission.startsWith('platform:')).toBe(false);
    }
  });
});

describe('PlatformGuard', () => {
  let audit: FakeAuditStore;
  let guard: PlatformGuard;

  beforeEach(() => {
    audit = new FakeAuditStore();
    guard = new PlatformGuard(audit);
  });

  it('refuses an Organization Owner with no platform role', async () => {
    const { context } = httpContext({
      handler: handlerRequiring(PLATFORM_PERMISSION, 'platform:tenant:read'),
      principal: { userId: 'user-1', platformRole: null },
    });

    await expect(guard.canActivate(context)).rejects.toMatchObject({ status: 403 });
  });

  it('refuses a platform role that does not hold the permission', async () => {
    const { context } = httpContext({
      handler: handlerRequiring(PLATFORM_PERMISSION, 'platform:admin:manage'),
      principal: { userId: 'user-1', platformRole: 'SUPPORT_ADMIN' },
    });

    await expect(guard.canActivate(context)).rejects.toMatchObject({ status: 403 });
  });

  it('allows a platform role that holds the permission', async () => {
    const { context } = httpContext({
      handler: handlerRequiring(PLATFORM_PERMISSION, 'platform:support:read'),
      principal: { userId: 'user-1', platformRole: 'SUPPORT_ADMIN' },
    });

    await expect(guard.canActivate(context)).resolves.toBe(true);
  });

  it('allows Operations Admin emergency-stop permission and denies billing/customer roles', async () => {
    const allowed = httpContext({
      handler: handlerRequiring(PLATFORM_PERMISSION, 'platform:operations:write'),
      principal: { userId: 'operator-1', platformRole: 'OPERATIONS_ADMIN' },
    });
    await expect(guard.canActivate(allowed.context)).resolves.toBe(true);

    for (const principal of [
      { userId: 'billing-1', platformRole: 'BILLING_ADMIN' as const },
      { userId: 'owner-1', platformRole: null },
    ]) {
      const denied = httpContext({
        handler: handlerRequiring(PLATFORM_PERMISSION, 'platform:operations:write'),
        principal,
      });
      await expect(guard.canActivate(denied.context)).rejects.toMatchObject({ status: 403 });
    }
  });

  it('records a platform denial against the caller own organization', async () => {
    const { context } = httpContext({
      handler: handlerRequiring(PLATFORM_PERMISSION, 'platform:tenant:read'),
      principal: { userId: 'user-1', platformRole: null },
      organization: { organizationId: 'org-1', role: 'OWNER' },
    });

    await expect(guard.canActivate(context)).rejects.toMatchObject({ status: 403 });

    expect(audit.events[0]).toMatchObject({
      organizationId: 'org-1',
      action: 'platform.access.denied',
      scope: 'PLATFORM',
      outcome: 'DENIED',
    });
  });

  it('refuses an Organization Admin probing platform administration', async () => {
    // RBAC-002: an ADMIN arriving from their own organization carries that
    // context, so the denial is recorded - but the organization role itself
    // grants nothing here. No organization permission can satisfy a platform
    // requirement, and there is no platform role on the principal to fall
    // back to.
    const { context } = httpContext({
      handler: handlerRequiring(PLATFORM_PERMISSION, 'platform:admin:manage'),
      principal: { userId: 'user-1', platformRole: null },
      organization: { organizationId: 'org-1', role: 'ADMIN' },
    });

    await expect(guard.canActivate(context)).rejects.toMatchObject({
      status: 403,
      code: 'permission_denied',
    });

    expect(audit.events[0]).toMatchObject({
      organizationId: 'org-1',
      action: 'platform.access.denied',
      scope: 'PLATFORM',
      outcome: 'DENIED',
    });
  });

  it('refuses a Campaign Manager probing platform administration', async () => {
    // RBAC-003: campaign permissions live in the organization namespace; none
    // of them can satisfy a platform requirement, and the campaign manager
    // holds no platform role.
    const { context } = httpContext({
      handler: handlerRequiring(PLATFORM_PERMISSION, 'platform:admin:manage'),
      principal: { userId: 'user-1', platformRole: null },
      organization: { organizationId: 'org-1', role: 'CAMPAIGN_MANAGER' },
    });

    await expect(guard.canActivate(context)).rejects.toMatchObject({
      status: 403,
      code: 'permission_denied',
    });

    expect(audit.events[0]).toMatchObject({
      organizationId: 'org-1',
      action: 'platform.access.denied',
      scope: 'PLATFORM',
      outcome: 'DENIED',
    });
  });

  it('does not invent an organization when there is no context', async () => {
    // `organization_id` is NOT NULL with a foreign key. Writing a placeholder
    // would either fail or, worse, fabricate a tenant association.
    const { context } = httpContext({
      handler: handlerRequiring(PLATFORM_PERMISSION, 'platform:tenant:read'),
      principal: { userId: 'user-1', platformRole: null },
    });

    await expect(guard.canActivate(context)).rejects.toMatchObject({ status: 403 });
    expect(audit.events).toHaveLength(0);
  });
});

describe('SessionGuard', () => {
  let auth: FakeAuthStore;
  let platformRoles: FakePlatformRoleStore;
  let guard: SessionGuard;

  beforeEach(() => {
    auth = new FakeAuthStore();
    platformRoles = new FakePlatformRoleStore();
    guard = new SessionGuard(auth, platformRoles, TERMS, new FakeAuditStore());
  });

  function withSession(user: ReturnType<typeof aUser>, expiresAt: Date) {
    auth.users.push(user);
    auth.sessions.push({
      session: {
        id: 'session-1',
        userId: user.id,
        // The guard looks up by digest of the raw cookie value, so the fake must
        // store the same digest. A literal here would make every "valid session"
        // case fail on lookup rather than on the check actually under test.
        tokenHash: hashToken(RAW_TOKEN),
        previousTokenHash: null,
        expiresAt,
        userAgentHash: null,
        ipPrefix: null,
      },
      revokedAt: null,
    });
  }

  const cookie = (value: string) => ({ cookie: `${SESSION_COOKIE}=${value}` });

  it('refuses a request with no cookie', async () => {
    const { context } = httpContext({ headers: {} });

    await expect(guard.canActivate(context)).rejects.toMatchObject({ status: 401 });
  });

  it('refuses an unknown session token', async () => {
    const { context } = httpContext({ headers: cookie('not-a-real-token') });

    await expect(guard.canActivate(context)).rejects.toMatchObject({ status: 401 });
  });

  it('attaches a principal for a valid session', async () => {
    const user = aUser();
    withSession(user, new Date(Date.now() + 60_000));

    const { context, request } = httpContext({ headers: cookie(RAW_TOKEN) });

    await expect(guard.canActivate(context)).resolves.toBe(true);
    expect(request[PRINCIPAL]).toMatchObject({ userId: user.id, sessionId: 'session-1' });
  });

  it('never puts the raw session token on the principal', async () => {
    const user = aUser();
    withSession(user, new Date(Date.now() + 60_000));

    const { context, request } = httpContext({ headers: cookie(RAW_TOKEN) });

    await guard.canActivate(context);

    expect(JSON.stringify(request[PRINCIPAL])).not.toContain(RAW_TOKEN);
  });

  it('does not fail a valid session when usage tracking fails', async () => {
    const user = aUser();
    withSession(user, new Date(Date.now() + 60_000));
    auth.touchSession = () => Promise.reject(new Error('write failed'));

    const { context } = httpContext({ headers: cookie(RAW_TOKEN) });

    await expect(guard.canActivate(context)).resolves.toBe(true);
  });

  it('refuses an expired session', async () => {
    const user = aUser();
    withSession(user, new Date(Date.now() - 1_000));

    const { context } = httpContext({ headers: cookie(RAW_TOKEN) });

    // The store's contract already excludes expired rows, so this refusal comes
    // from the lookup rather than from the guard's own check. What matters is
    // that it is a 401 and not a pass.
    await expect(guard.canActivate(context)).rejects.toMatchObject({ status: 401 });
  });

  it('refuses an expired session even from a store that does not filter', async () => {
    // Defence in depth. If a store implementation forgets the `expiresAt`
    // predicate its contract requires, the guard must still refuse rather than
    // honour an expired credential.
    const user = aUser({ id: 'user-stale' });
    auth.users.push(user);
    auth.sessions.push({
      session: {
        id: 'session-stale',
        userId: user.id,
        tokenHash: hashToken('stale-token'),
        previousTokenHash: null,
        expiresAt: new Date(Date.now() - 60_000),
        userAgentHash: null,
        ipPrefix: null,
      },
      revokedAt: null,
    });

    const leaky = new FakeAuthStore();
    leaky.users = auth.users;
    leaky.sessions = auth.sessions;
    // Deliberately drops the expiry predicate the contract requires.
    leaky.findActiveSessionByTokenHash = async (tokenHash) => {
      const entry = leaky.sessions.find((candidate) => candidate.session.tokenHash === tokenHash);
      if (!entry) return undefined;

      return {
        id: entry.session.id,
        userId: entry.session.userId,
        tokenHash: entry.session.tokenHash,
        previousTokenHash: entry.session.previousTokenHash,
        expiresAt: entry.session.expiresAt,
        revokedAt: entry.revokedAt,
      };
    };

    const guarded = new SessionGuard(leaky, platformRoles, TERMS, new FakeAuditStore());
    const { context } = httpContext({ headers: cookie('stale-token') });

    await expect(guarded.canActivate(context)).rejects.toMatchObject({
      status: 401,
      code: 'session_expired',
    });
  });

  it('refuses a session whose user has been suspended', async () => {
    const user = aUser({ status: 'SUSPENDED' });
    withSession(user, new Date(Date.now() + 60_000));

    const { context } = httpContext({ headers: cookie(RAW_TOKEN) });

    await expect(guard.canActivate(context)).rejects.toMatchObject({ status: 401 });
  });

  it('refuses a revoked session', async () => {
    const user = aUser();
    withSession(user, new Date(Date.now() + 60_000));
    auth.sessions[0]!.revokedAt = new Date();

    const { context } = httpContext({ headers: cookie(RAW_TOKEN) });

    await expect(guard.canActivate(context)).rejects.toMatchObject({
      status: 401,
      code: 'session_revoked',
    });
  });

  it('reports a revoked platform role as no role at all', async () => {
    const user = aUser();
    withSession(user, new Date(Date.now() + 60_000));
    platformRoles.setAssignment({
      userId: user.id,
      role: 'PLATFORM_OWNER',
      revokedAt: new Date(),
    });

    const { context, request } = httpContext({ headers: cookie(RAW_TOKEN) });

    await guard.canActivate(context);

    expect(request[PRINCIPAL]).toMatchObject({ platformRole: null });
  });

  it('refuses a non-HTTP context', async () => {
    const context = {
      getType: () => 'rpc',
      switchToHttp: () => ({ getRequest: () => ({}) }),
    } as never;

    await expect(guard.canActivate(context)).resolves.toBe(false);
  });
});

describe('CsrfGuard', () => {
  const guard = new CsrfGuard();

  it('allows a GET without a token', () => {
    const { context } = httpContext({ method: 'GET' });

    expect(guard.canActivate(context)).toBe(true);
  });

  it('refuses a mutation with no CSRF header', () => {
    const { context } = httpContext({ method: 'POST' });

    expect(() => guard.canActivate(context)).toThrowError();
  });

  it('refuses a mutation whose header does not match the cookie', () => {
    const token = generateCsrfToken();
    const { context } = httpContext({
      method: 'POST',
      headers: { cookie: `${CSRF_COOKIE}=${token}`, [CSRF_HEADER]: 'a-different-token' },
    });

    expect(() => guard.canActivate(context)).toThrowError();
  });

  it('allows a mutation whose header matches the cookie', () => {
    const token = generateCsrfToken();
    const { context } = httpContext({
      method: 'POST',
      headers: { cookie: `${CSRF_COOKIE}=${token}`, [CSRF_HEADER]: token },
    });

    expect(guard.canActivate(context)).toBe(true);
  });

  it('issues tokens that differ every time', () => {
    expect(generateCsrfToken()).not.toBe(generateCsrfToken());
  });
});

describe('RBAC-012 non-HTTP contexts', () => {
  it('does not authorize worker or callback payloads through HTTP guards', async () => {
    const context = { getType: () => 'rpc' } as never;
    const audit = new FakeAuditStore();
    const organization = new OrganizationGuard(new FakeOrganizationStore(), new FakeAuthStore(), audit, TERMS);
    expect(await organization.canActivate(context)).toBe(false);
    expect(await new PlatformGuard(audit).canActivate(context)).toBe(false);
  });
});
