import { can, ORGANIZATION_PERMISSIONS, ORGANIZATION_ROLE_PERMISSIONS, type OrganizationPermission, type OrganizationRole } from '@truevine/auth';

export const CUSTOM_DELEGABLE_PERMISSIONS = [
  'organization:read', 'campaign:read', 'campaign:create', 'campaign:delete',
  'audio:read', 'contact:read', 'contact:create', 'reporting:read',
] as const satisfies readonly OrganizationPermission[];

const registry: ReadonlySet<string> = new Set(ORGANIZATION_PERMISSIONS);
const delegable: ReadonlySet<string> = new Set(CUSTOM_DELEGABLE_PERMISSIONS);

export function isCustomDelegable(permission: OrganizationPermission): boolean {
  return delegable.has(permission);
}

export function effectiveOrganizationPermissions(
  role: OrganizationRole,
  grants: readonly unknown[],
): readonly OrganizationPermission[] {
  if (!grants.every((grant) => typeof grant === 'string' && registry.has(grant))) {
    throw new Error('Invalid organization permission lookup.');
  }
  return ORGANIZATION_PERMISSIONS.filter(
    (permission) =>
      ORGANIZATION_ROLE_PERMISSIONS[role].includes(permission) ||
      (isCustomDelegable(permission) && grants.includes(permission)),
  );
}

export async function checkEffectiveOrganizationPermission(
  role: OrganizationRole,
  permission: OrganizationPermission,
  load: () => Promise<readonly unknown[]>,
): Promise<'allowed' | 'insufficient_permission' | 'custom_grants_unavailable'> {
  if (can(role, permission)) return 'allowed';
  if (!isCustomDelegable(permission)) return 'insufficient_permission';
  try {
    return effectiveOrganizationPermissions(role, await load()).includes(permission)
      ? 'allowed'
      : 'insufficient_permission';
  } catch {
    return 'custom_grants_unavailable';
  }
}
