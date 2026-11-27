import type { OrganizationPermission, OrganizationRole } from '@truevine/auth';

export type RoleType = 'SYSTEM' | 'CUSTOM';

// Re-export for consumers
export type { OrganizationPermission, OrganizationRole };

export interface CustomRoleRecord {
  readonly id: string;
  readonly organizationId: string;
  readonly name: string;
  readonly description: string | null;
  readonly type: RoleType;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface RolePermissionRecord {
  readonly roleId: string;
  readonly organizationId: string;
  readonly permission: OrganizationPermission;
  readonly createdAt: Date;
}

export interface RoleAssignmentRecord {
  readonly roleId: string;
  readonly organizationId: string;
  readonly userId: string;
  readonly createdAt: Date;
}

export interface NewCustomRole {
  readonly organizationId: string;
  readonly name: string;
  readonly description: string | null;
  readonly type: RoleType;
  readonly permissions: readonly OrganizationPermission[];
  readonly createdByUserId: string;
}

export interface UpdateCustomRole {
  readonly name?: string;
  readonly description?: string | null;
  readonly permissions?: readonly OrganizationPermission[];
}

/**
 * Persistence for custom roles, permissions and assignments.
 *
 * All methods are tenant-scoped: every query takes an explicit `organizationId`
 * so a caller cannot build an unscoped query. This follows the same pattern as
 * {@link OrganizationStore} in `@truevine/auth`.
 */
export interface CustomRoleStore {
  /**
   * Finds a custom role by its ID within an organization.
   */
  findCustomRole(organizationId: string, roleId: string): Promise<CustomRoleRecord | undefined>;

  /**
   * Finds a custom role by name within an organization.
   */
  findCustomRoleByName(organizationId: string, name: string): Promise<CustomRoleRecord | undefined>;

  /**
   * Lists all custom roles in an organization, including system roles if any.
   */
  listCustomRoles(organizationId: string): Promise<readonly CustomRoleRecord[]>;

  /**
   * Creates a new custom role with its permissions.
   *
   * The permissions are written atomically alongside the role.
   */
  createCustomRole(input: NewCustomRole): Promise<CustomRoleRecord>;

  /**
   * Updates a custom role.
   *
   * System roles cannot be updated - the service layer enforces this.
   */
  updateCustomRole(
    organizationId: string,
    roleId: string,
    input: UpdateCustomRole,
  ): Promise<CustomRoleRecord>;

  /**
   * Deletes a custom role.
   *
   * System roles cannot be deleted - the service layer enforces this.
   * Returns false if the role was not found.
   */
  deleteCustomRole(organizationId: string, roleId: string): Promise<boolean>;

  /**
   * Lists permissions granted to a custom role.
   */
  listRolePermissions(organizationId: string, roleId: string): Promise<readonly OrganizationPermission[]>;

  /**
   * Replaces the permissions of a custom role atomically.
   *
   * System roles cannot have their permissions changed - the service layer
   * enforces this.
   */
  setRolePermissions(
    organizationId: string,
    roleId: string,
    permissions: readonly OrganizationPermission[],
  ): Promise<void>;

  /**
   * Lists users assigned to a custom role.
   */
  listRoleAssignments(organizationId: string, roleId: string): Promise<readonly RoleAssignmentRecord[]>;

  /**
   * Assigns a user to a custom role.
   *
   * Returns false if the assignment already exists or the user is not a member
   * of the organization.
   */
  assignUserToRole(
    organizationId: string,
    roleId: string,
    userId: string,
  ): Promise<boolean>;

  /**
   * Removes a user from a custom role.
   *
   * Returns false if the assignment did not exist.
   */
  unassignUserFromRole(
    organizationId: string,
    roleId: string,
    userId: string,
  ): Promise<boolean>;

  /**
   * Gets all custom role permissions for a user in an organization.
   *
   * Used by the authorization layer to compute effective permissions.
   */
  getCustomRolePermissionsForUser(
    organizationId: string,
    userId: string,
  ): Promise<readonly OrganizationPermission[]>;

  /**
   * Counts how many users are assigned to a custom role.
   */
  countRoleAssignments(organizationId: string, roleId: string): Promise<number>;
}