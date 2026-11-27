import { isCustomDelegable } from '../auth/effective-organization-permissions.js';
import {
  can,
  type OrganizationPermission,
  type OrganizationRole,
  ORGANIZATION_ROLE_PERMISSIONS,
} from '@truevine/auth';

export type RoleType = 'SYSTEM' | 'CUSTOM';

export interface CustomRolePrincipal {
  readonly organizationId: string;
  readonly userId: string;
  readonly builtInRole: OrganizationRole | null;
  readonly customRolePermissions: readonly OrganizationPermission[];
}

export interface CustomRoleAuthorizationResult {
  readonly allowed: boolean;
  readonly reason: string;
}

/**
 * Evaluates whether a principal may perform `permission` in their organization.
 *
 * Deny by default: returns `allowed: false` unless a granted permission
 * (built-in role or custom role) explicitly covers `permission`.
 *
 * This is a pure function - no database, no side effects. It is the single
 * authorization decision point for custom-role-aware checks.
 */
export function authorizeCustomRole(
  principal: CustomRolePrincipal,
  permission: OrganizationPermission,
): CustomRoleAuthorizationResult {
  if (principal.builtInRole !== null && can(principal.builtInRole, permission)) {
    return { allowed: true, reason: 'built_in_role' };
  }
  if (principal.builtInRole !== null && isCustomDelegable(permission) && principal.customRolePermissions.includes(permission)) {
    return { allowed: true, reason: 'custom_role' };
  }
  return { allowed: false, reason: 'insufficient_permission' };
}

/**
 * Whether a principal may manage custom roles in their organization.
 *
 * Gated on `organization:update` (held by OWNER and ADMIN). Custom role
 * management is organization administration.
 */
export function canManageCustomRoles(principal: CustomRolePrincipal): CustomRoleAuthorizationResult {
  return authorizeCustomRole(principal, 'organization:update');
}

/**
 * Whether a principal may assign custom roles to members.
 *
 * Gated on `member:update` (held by OWNER and ADMIN). Assignment is membership
 * administration.
 */
export function canAssignCustomRoles(principal: CustomRolePrincipal): CustomRoleAuthorizationResult {
  return authorizeCustomRole(principal, 'member:update');
}

/**
 * Whether `actor` may grant `permissions` on a custom role they are creating or
 * editing.
 *
 * The granted permissions must be allowlisted and held by the actor's built-in
 * permissions. This is the delegation rule: you cannot delegate authority you
 * do not hold. Returns the subset of permissions that are authorized, or the
 * full list with `allowed: false` if any are unauthorized.
 */
export function delegationScope(
  actor: CustomRolePrincipal,
  requested: readonly OrganizationPermission[],
): CustomRoleAuthorizationResult {
  const actorPermissions = new Set([
    ...(actor.builtInRole !== null ? ORGANIZATION_ROLE_PERMISSIONS[actor.builtInRole] : []),
  ]);
  const unauthorized = requested.filter((permission) => !isCustomDelegable(permission) || !actorPermissions.has(permission));
  if (unauthorized.length > 0) {
    return { allowed: false, reason: 'permission_not_delegable' };
  }
  return { allowed: true, reason: 'delegable' };
}

/**
 * Whether `actor` may grant `targetPermissions` as a custom role. The target
 * role's permissions must be strictly downward: fewer permissions than the
 * actor, all held by the actor. Prevents manufacturing a peer or superior role.
 */
export function canDelegateCustomRole(
  actor: CustomRolePrincipal,
  targetPermissions: readonly OrganizationPermission[],
): CustomRoleAuthorizationResult {
  const actorPermissions = new Set([
    ...(actor.builtInRole !== null ? ORGANIZATION_ROLE_PERMISSIONS[actor.builtInRole] : []),
  ]);
  if (!targetPermissions.every((p) => actorPermissions.has(p))) {
    return { allowed: false, reason: 'permission_not_held' };
  }
  if (new Set(targetPermissions).size >= actorPermissions.size) {
    return { allowed: false, reason: 'not_strictly_downward' };
  }
  if (!targetPermissions.every(isCustomDelegable)) return { allowed: false, reason: 'permission_not_delegable' };
  return { allowed: true, reason: 'delegable' };
}

/**
 * Whether a custom role is protected (system role) and cannot be modified or
 * deleted through the API.
 */
export function isSystemRole(role: { readonly type: RoleType }): boolean {
  return role.type === 'SYSTEM';
}