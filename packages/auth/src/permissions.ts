/**
 * The Truevine Voice permission registry.
 *
 * This module is the single source of truth for what a principal may do. It is
 * deliberately framework-agnostic: no NestJS, no HTTP, no database. Both the API
 * guards and the frontends import it, so a permission can never be enforced in
 * one place and forgotten in another.
 *
 * WHY CODE, NOT DATABASE ROWS
 * --------------------------
 * The obvious alternative stores permissions and role mappings in tables. That
 * was rejected for one reason: it creates two sources of truth. A guard reading
 * a permission table can disagree with the registry the code was tested against,
 * and nothing fails when they do - the row is simply wrong. Here the mapping is
 * a literal in a reviewed file, so a change is a diff and a mistake is a failing
 * test.
 *
 * The database stores *assignments* only (a role on a membership, a role on a
 * platform assignment). It never stores permissions.
 *
 * TWO DISJOINT NAMESPACES
 * -----------------------
 * Organization and platform permissions are separate string unions with no
 * overlap, so `OrganizationPermission` cannot even name a platform permission at
 * the type level. This is the structural half of "an Organization Owner must
 * never reach platform administration"; the registry tests assert the runtime
 * half.
 */

/** Permissions evaluated inside one customer organization. */
export const ORGANIZATION_PERMISSIONS = [
  'organization:read',
  'organization:update',
  'ownership:transfer',
  'member:read',
  'member:invite',
  'member:update',
  'member:remove',
  'invitation:read',
  'invitation:revoke',
  'campaign:read',
  'campaign:create',
  'campaign:update',
  'campaign:delete',
  'billing:read',
  'billing:update',
  'wallet:read',
  'reporting:read',
] as const;

export type OrganizationPermission = (typeof ORGANIZATION_PERMISSIONS)[number];

/** Permissions evaluated inside the Truevine platform, outside every tenant. */
export const PLATFORM_PERMISSIONS = [
  'platform:tenant:read',
  'platform:tenant:suspend',
  'platform:operations:read',
  'platform:operations:write',
  'platform:billing:read',
  'platform:billing:refund',
  'platform:support:read',
  'platform:support:diagnostics',
  'platform:technical:read',
  'platform:technical:write',
  'platform:audit:read',
  'platform:admin:manage',
] as const;

export type PlatformPermission = (typeof PLATFORM_PERMISSIONS)[number];

/** Roles a principal can hold inside a customer organization. */
export const ORGANIZATION_ROLES = [
  'OWNER',
  'ADMIN',
  'CAMPAIGN_MANAGER',
  'BILLING',
  'VIEWER',
] as const;

export type OrganizationRole = (typeof ORGANIZATION_ROLES)[number];

/** Roles a principal can hold as a Truevine platform operator. */
export const PLATFORM_ROLES = [
  'PLATFORM_OWNER',
  'OPERATIONS_ADMIN',
  'BILLING_ADMIN',
  'SUPPORT_ADMIN',
  'TECHNICAL_ADMIN',
  'AUDITOR',
] as const;

export type PlatformRole = (typeof PLATFORM_ROLES)[number];

/**
 * Explicit organization role -> permission mapping.
 *
 * Every role lists its permissions literally. There is no inheritance between
 * roles and no wildcard, because both would let a permission appear in the
 * matrix without anyone deciding it should.
 */
export const ORGANIZATION_ROLE_PERMISSIONS: Readonly<
  Record<OrganizationRole, readonly OrganizationPermission[]>
> = Object.freeze({
  OWNER: ORGANIZATION_PERMISSIONS,

  // Deliberately without `ownership:transfer`, `billing:*` and `wallet:read`.
  // An admin administers the organization; they do not own it and do not
  // handle money. Billing is granted separately by the owner.
  ADMIN: [
    'organization:read',
    'organization:update',
    'member:read',
    'member:invite',
    'member:update',
    'member:remove',
    'invitation:read',
    'invitation:revoke',
    'campaign:read',
    'campaign:create',
    'campaign:update',
    'campaign:delete',
    'reporting:read',
  ],

  // Day-to-day campaign work. No membership administration, no ownership, no
  // billing: a campaign manager's job does not require any of them, and
  // granting them "for convenience" is how privilege creeps.
  CAMPAIGN_MANAGER: [
    'organization:read',
    'campaign:read',
    'campaign:create',
    'campaign:update',
    'campaign:delete',
    'reporting:read',
  ],

  // Sees the organization only so the billing screens can name it. Cannot see
  // members or campaigns.
  BILLING: ['organization:read', 'billing:read', 'billing:update', 'wallet:read'],

  // Read-only. See `MUTATING_ORGANIZATION_PERMISSIONS` for the invariant that
  // makes "viewer cannot mutate data" a structural fact rather than a review
  // convention.
  VIEWER: ['organization:read', 'member:read', 'campaign:read', 'reporting:read'],
});

/** Explicit platform role -> permission mapping. Independent of every tenant role. */
export const PLATFORM_ROLE_PERMISSIONS: Readonly<
  Record<PlatformRole, readonly PlatformPermission[]>
> = Object.freeze({
  PLATFORM_OWNER: PLATFORM_PERMISSIONS,

  OPERATIONS_ADMIN: [
    'platform:tenant:read',
    'platform:tenant:suspend',
    'platform:operations:read',
    'platform:operations:write',
  ],

  BILLING_ADMIN: ['platform:billing:read', 'platform:billing:refund'],

  // Sees tenant metadata to answer tickets. `platform:support:read` is lookup
  // only - organizations, users and their membership - so AUDITOR, which also
  // holds it, never gains anything more.
  //
  // `platform:support:diagnostics` (RBAC-009) is the deliberate exception, and
  // it is granted here alone: read-only tenant-content diagnostics - campaign
  // records, wallet totals, billing presence - so a support admin can answer
  // "what is happening in this account?" without any write capability. It is a
  // separate permission rather than a widening of `platform:support:read`
  // precisely so that AUDITOR's reach does not change as a side effect.
  SUPPORT_ADMIN: [
    'platform:tenant:read',
    'platform:support:read',
    'platform:support:diagnostics',
    'platform:audit:read',
  ],

  // RBAC-010, deliberately read-only. `platform:technical:write` exists in the
  // vocabulary and is granted to PLATFORM_OWNER alone, so a future technical
  // mutation (restarting a job, clearing a queue) has a permission to claim -
  // but TECHNICAL_ADMIN does not hold it yet, because nothing the role can do
  // today requires a write and a permission nobody consumes is a permission
  // nobody reviews.
  TECHNICAL_ADMIN: ['platform:technical:read', 'platform:audit:read'],

  AUDITOR: [
    'platform:tenant:read',
    'platform:operations:read',
    'platform:support:read',
    'platform:audit:read',
  ],
});

/**
 * Every organization permission that changes state.
 *
 * Kept as a derived list rather than a hand-maintained one, because a
 * hand-maintained list drifts: someone adds a mutating permission, forgets the
 * list, and a viewer or auditor silently gains it.
 */
export const MUTATING_ORGANIZATION_PERMISSIONS: readonly OrganizationPermission[] =
  ORGANIZATION_PERMISSIONS.filter((permission) => !permission.endsWith(':read'));

/** Whether `role` grants `permission` inside an organization. */
export function can(role: OrganizationRole, permission: OrganizationPermission): boolean {
  return ORGANIZATION_ROLE_PERMISSIONS[role].includes(permission);
}

/** Whether `role` grants `permission` inside the platform. */
export function canActAsPlatform(role: PlatformRole, permission: PlatformPermission): boolean {
  return PLATFORM_ROLE_PERMISSIONS[role].includes(permission);
}

/** Whether the organization permission changes state. */
export function isMutating(permission: OrganizationPermission): boolean {
  return MUTATING_ORGANIZATION_PERMISSIONS.includes(permission);
}

/**
 * Whether `actor` may grant `target` to somebody.
 *
 * Two conditions, and both are load-bearing:
 *
 * 1. **Subset.** The target's permissions must all be held by the actor. You
 *    cannot delegate authority you do not have.
 * 2. **Strictly downward.** The target must hold *fewer* permissions than the
 *    actor, not the same number.
 *
 * Condition 2 is not a detail. Without it an Owner could assign the `OWNER`
 * role like any other, which would quietly become a second, undeliberate way to
 * create an owner and would bypass `ownership:transfer` - the deliberate,
 * audited act ADR 0006 requires. It would also let any role manufacture more
 * copies of itself.
 *
 * Together they make authority flow down a ladder:
 *
 *   OWNER -> ADMIN, CAMPAIGN_MANAGER, BILLING, VIEWER
 *   ADMIN -> CAMPAIGN_MANAGER, VIEWER
 *   CAMPAIGN_MANAGER, BILLING, VIEWER -> nothing
 *
 * This is what makes "an Organization Admin cannot exceed delegated authority"
 * enforceable rather than aspirational. An admin cannot create an owner, cannot
 * hand out `BILLING` (admins lack every `billing:*` permission), and cannot even
 * mint a peer admin. There is no per-edge allowlist to keep in sync, because the
 * permission sets themselves are the rule.
 */
export function canDelegate(actor: OrganizationRole, target: OrganizationRole): boolean {
  const held = ORGANIZATION_ROLE_PERMISSIONS[actor];
  const granting = ORGANIZATION_ROLE_PERMISSIONS[target];

  return granting.length < held.length && granting.every((permission) => held.includes(permission));
}

/** The roles `actor` may grant, in registry order. */
export function delegableRoles(actor: OrganizationRole): readonly OrganizationRole[] {
  return ORGANIZATION_ROLES.filter((target) => canDelegate(actor, target));
}

/**
 * Whether a role is permitted to administer membership, which is the capability
 * behind inviting, changing and removing members.
 *
 * Used by the owner-transfer flow, where removing the last remaining
 * administrator would otherwise be possible and would strand the organization.
 */
export function canAdministerMemberships(role: OrganizationRole): boolean {
  return can(role, 'member:update');
}
