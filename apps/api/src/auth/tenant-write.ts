import {
  can,
  canActAsPlatform,
  type PlatformRole,
  permissionDenied,
  type OrganizationPermission,
  type OrganizationRole,
} from '@truevine/auth';

/** Recheck authority after taking membership administration's organization lock.
 * Separate statements at READ COMMITTED see revocation committed while waiting.
 * Structural interface keeps unit tests independent of Prisma and infrastructure.
 */
export interface TenantWriteSql {
  $queryRaw<T = unknown>(sql: TemplateStringsArray, ...values: unknown[]): Promise<T>;
}
export async function authorizeTenantWrite(
  tx: TenantWriteSql,
  organizationId: string,
  actorUserId: string,
  permission: OrganizationPermission,
): Promise<void> {
  await tx.$queryRaw`SELECT id FROM organizations WHERE id=${organizationId}::uuid FOR UPDATE`;
  const rows = await tx.$queryRaw<{ role: OrganizationRole }[]>`
    SELECT m.role FROM memberships m
    JOIN organizations o ON o.id=m.organization_id
    JOIN users u ON u.id=m.user_id
    WHERE m.organization_id=${organizationId}::uuid AND m.user_id=${actorUserId}::uuid
      AND o.suspended_at IS NULL AND u.status='ACTIVE'
    FOR SHARE OF m,u`;
  if (!rows[0] || !can(rows[0].role, permission)) throw permissionDenied();
}

/** A platform grant is re-read and locked, never replaced by a tenant role. */
export async function authorizeEmergencyWrite(
  tx: TenantWriteSql,
  actorUserId: string,
): Promise<void> {
  const rows = await tx.$queryRaw<{ role: PlatformRole }[]>`
    SELECT p.role FROM platform_role_assignments p JOIN users u ON u.id=p.user_id
    WHERE p.user_id=${actorUserId}::uuid AND p.revoked_at IS NULL AND u.status='ACTIVE'
    FOR SHARE OF p,u`;
  if (!rows[0] || !canActAsPlatform(rows[0].role, 'platform:operations:write'))
    throw permissionDenied();
}
