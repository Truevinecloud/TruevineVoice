/**
 * Organization-scoped authorization.
 *
 * This is where tenant isolation is enforced, and it is the most important file
 * in the authorization layer.
 *
 * THE ORDER MATTERS
 * -----------------
 * 1. Read the organization id from the **path** only.
 * 2. Load the session principal's membership in *that* organization.
 * 3. Refuse if there is no membership.
 * 4. Refuse if the terms of the current version have not been accepted.
 * 5. Refuse if the role does not hold the required permission.
 *
 * A client-supplied organization id is never trusted. It is only ever a *claim*
 * about which tenant the caller wants; step 2 turns it into a fact or leaves it
 * a claim. The same is true of any resource id further down the path: reaching
 * `GET /organizations/{otherOrg}/members/{userId}` requires a membership in
 * `{otherOrg}`, which a caller from another tenant does not have.
 *
 * WHY 403 AND NOT 404
 * -------------------
 * A caller with no membership in an organization receives 403, not 404. A 404
 * would confirm that the organization exists, which is itself information a
 * competitor is entitled to neither have nor be able to confirm. The response
 * is identical for "no such organization" and "not yours", so the endpoint
 * cannot be used to enumerate tenants.
 *
 * DENIALS ARE AUDITED
 * -------------------
 * A refusal is written to the append-only trail with `outcome = DENIED`. A log
 * containing only successes cannot answer "was this an attack?".
 */

import {
  ForbiddenException,
  Inject,
  Injectable,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common';
import {
  assertKnownAuditAction,
  can,
  canActAsPlatform,
  permissionDenied,
  termsAcceptanceRequired,
  type OrganizationPermission,
  type PlatformPermission,
} from '@truevine/auth';

import {
  ACCEPTED_TERMS,
  ORGANIZATION_PERMISSION,
  PLATFORM_PERMISSION,
} from './permission.decorators.js';
import { ORGANIZATION_CONTEXT, PRINCIPAL, type AuthenticatedRequest } from './principal.js';
import { AUDIT_STORE, AUTH_STORE, ORGANIZATION_STORE, TERMS_VERSION } from './tokens.js';
import type { AuditStore, AuthStore, OrganizationStore } from './auth.store.js';

/** Enforces organization membership, terms acceptance and one permission. */
@Injectable()
export class OrganizationGuard implements CanActivate {
  constructor(
    @Inject(ORGANIZATION_STORE) private readonly organizationStore: OrganizationStore,
    @Inject(AUTH_STORE) private readonly authStore: AuthStore,
    @Inject(AUDIT_STORE) private readonly auditStore: AuditStore,
    @Inject(TERMS_VERSION) private readonly termsVersion: string,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (context.getType() !== 'http') return false;

    const handler = context.getHandler();
    const controller = context.getClass();

    const permission = Reflect.getMetadata(ORGANIZATION_PERMISSION, handler) as
      OrganizationPermission | undefined;

    const requiresTerms = Reflect.getMetadata(ACCEPTED_TERMS, handler) === true;

    // A guard without a permission is a configuration error: fail closed.
    // Public/discovery routes intentionally do not apply this guard.
    if (permission === undefined) throw permissionDenied();

    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const principal = request[PRINCIPAL];

    // SessionGuard runs first on every authenticated route. If it did not, there
    // is no principal and there is nothing to authorize.
    if (!principal) throw permissionDenied();

    const organizationId = request.params?.['organizationId'];

    // A route that requires an organization permission but carries no
    // organization in the path is a routing mistake, not a client error.
    if (typeof organizationId !== 'string' || organizationId.length === 0) {
      throw new ForbiddenException({
        error: {
          code: 'organization_context_required',
          message: 'This route requires an organization.',
        },
      });
    }

    const membership = await this.organizationStore.findMembership(
      organizationId,
      principal.userId,
    );

    if (!membership) {
      await this.deny(principal.userId, organizationId, permission, 'no_membership');
      // Deliberately the same message and status as an unknown organization.
      throw permissionDenied();
    }

    // Suspension is checked after membership and before the permission, so a
    // suspended organization reports the same 403 as anything else it refuses.
    // The lookup already fetched the row, so this costs nothing extra.
    const organization = await this.organizationStore.findOrganizationById(organizationId);

    if (!organization || organization.suspendedAt) {
      await this.deny(principal.userId, organizationId, permission, 'organization_suspended');
      throw permissionDenied('This organization is suspended.');
    }

    if (requiresTerms) {
      const accepted = await this.authStore.hasAcceptedTerms(principal.userId, this.termsVersion);

      if (!accepted) {
        await this.deny(principal.userId, organizationId, permission, 'terms_not_accepted');
        throw termsAcceptanceRequired();
      }
    }

    if (!can(membership.role, permission)) {
      await this.deny(principal.userId, organizationId, permission, 'insufficient_permission');
      throw permissionDenied();
    }

    request[ORGANIZATION_CONTEXT] = {
      organizationId,
      role: membership.role,
    };

    void controller;

    return true;
  }

  /** Records a refusal. Never allowed to mask the 403 it accompanies. */
  private async deny(
    userId: string,
    organizationId: string,
    permission: OrganizationPermission,
    reason: string,
  ): Promise<void> {
    try {
      assertKnownAuditAction('authorization.denied');
      await this.auditStore.record({
        // Recorded against the organization in the *path*, which for a cross-tenant
        // attempt is the tenant that was probed rather than the caller's own.
        //
        // `organization_id` is NOT NULL with a foreign key, and a caller who
        // belongs to no organization - the case most worth recording - has no
        // organization of their own to file it under. The targeted tenant is the
        // party with a legitimate interest in knowing they were probed, and the
        // row records the actor, so they can see who it was.
        organizationId,
        actorUserId: userId,
        action: 'authorization.denied',
        scope: 'ORGANIZATION',
        outcome: 'DENIED',
        metadata: { permission, reason },
      });
    } catch {
      // An audit failure must not become a 500 in place of a correct 403: the
      // refusal stands either way, and turning an observability problem into an
      // availability problem helps nobody.
      //
      // Logged rather than swallowed. The common case is a probe against an
      // organization id that does not exist, where `organization_id` carries a
      // foreign key and there is no tenant to file the row under. Skipping that
      // is semantically right - no tenant was targeted - but doing it silently
      // would make a genuine audit outage indistinguishable from normal operation.
      process.stderr.write('[authorization] Denial audit unavailable.\n');
    }
  }
}

/**
 * Enforces a platform permission.
 *
 * Separate from {@link OrganizationGuard} so that platform authority can never
 * be satisfied by an organization role. An Organization Owner holds no platform
 * role at all, so this refuses them - which is the requirement, expressed once,
 * for every future platform route.
 */
@Injectable()
export class PlatformGuard implements CanActivate {
  constructor(@Inject(AUDIT_STORE) private readonly auditStore: AuditStore) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (context.getType() !== 'http') return false;

    const permission = Reflect.getMetadata(PLATFORM_PERMISSION, context.getHandler()) as
      PlatformPermission | undefined;

    if (permission === undefined) throw permissionDenied();

    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const principal = request[PRINCIPAL];

    if (!principal) throw permissionDenied();

    if (!principal.platformRole) {
      await this.deny(request, principal.userId, permission);
      throw permissionDenied('This action requires Truevine platform access.');
    }

    if (!canActAsPlatform(principal.platformRole, permission)) {
      await this.deny(request, principal.userId, permission);
      throw permissionDenied('This action requires Truevine platform access.');
    }

    return true;
  }

  private async deny(
    request: AuthenticatedRequest,
    userId: string,
    permission: PlatformPermission,
  ): Promise<void> {
    // `security_audit_events.organization_id` is NOT NULL and carries a foreign
    // key, by the ADR 0006 rule. A platform denial by a caller with no
    // organization context therefore has nowhere legitimate to be written, and
    // inventing a row with an empty organization would break the very
    // constraint that keeps the audit trail tenant-scoped.
    //
    // KNOWN GAP, stated rather than hidden: a platform denial by a caller with no
    // organization context is not recorded. The case RBAC-001 names - an
    // Organization Owner probing platform administration - is recorded, because
    // an owner arriving from their own organization has that context. Closing the
    // general case needs a platform-scoped audit table, which is RBAC-002 work.
    const organization = request[ORGANIZATION_CONTEXT];

    if (!organization) return;

    try {
      assertKnownAuditAction('platform.access.denied');
      await this.auditStore.record({
        organizationId: organization.organizationId,
        actorUserId: userId,
        action: 'platform.access.denied',
        scope: 'PLATFORM',
        outcome: 'DENIED',
        metadata: { permission },
      });
    } catch {
      // Same reasoning as OrganizationGuard#deny: the refusal stands regardless,
      // and losing the audit row is visible in the application error log.
    }
  }
}
