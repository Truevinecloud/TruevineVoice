import { describe, it, expect } from 'vitest';
import {
  authorizeCustomRole,
  canManageCustomRoles,
  canAssignCustomRoles,
  delegationScope,
  canDelegateCustomRole,
  isSystemRole,
} from './custom-role-authorization.js';
import {
  type OrganizationRole,
  type OrganizationPermission,
  ORGANIZATION_ROLE_PERMISSIONS,
} from '@truevine/auth';

function makePrincipal(
  builtInRole: OrganizationRole | null,
  customRolePermissions: readonly OrganizationPermission[] = [],
): {
  readonly organizationId: string;
  readonly userId: string;
  readonly builtInRole: OrganizationRole | null;
  readonly customRolePermissions: readonly OrganizationPermission[];
} {
  return {
    organizationId: 'org-1',
    userId: 'user-1',
    builtInRole,
    customRolePermissions,
  };
}

describe('custom-role-authorization', () => {
  describe('authorizeCustomRole', () => {
    it('allows OWNER built-in role for any permission', () => {
      const principal = makePrincipal('OWNER');
      const result = authorizeCustomRole(principal, 'member:remove');
      expect(result.allowed).toBe(true);
      expect(result.reason).toBe('built_in_role');
    });

    it('denies VIEWER built-in role for mutating permission', () => {
      const principal = makePrincipal('VIEWER');
      const result = authorizeCustomRole(principal, 'member:remove');
      expect(result.allowed).toBe(false);
      expect(result.reason).toBe('insufficient_permission');
    });

    it('allows VIEWER built-in role for read permission', () => {
      const principal = makePrincipal('VIEWER');
      const result = authorizeCustomRole(principal, 'organization:read');
      expect(result.allowed).toBe(true);
      expect(result.reason).toBe('built_in_role');
    });

    it('allows custom role permission when built-in role does not have it', () => {
      const principal = makePrincipal('VIEWER', ['campaign:create']);
      const result = authorizeCustomRole(principal, 'campaign:create');
      expect(result.allowed).toBe(true);
      expect(result.reason).toBe('custom_role');
    });

    it('denies when neither built-in nor custom role grants permission', () => {
      const principal = makePrincipal('VIEWER');
      const result = authorizeCustomRole(principal, 'member:remove');
      expect(result.allowed).toBe(false);
      expect(result.reason).toBe('insufficient_permission');
    });

    it('denies by default for unknown permission', () => {
      const principal = makePrincipal('OWNER');
      const result = authorizeCustomRole(principal, 'unknown:permission' as OrganizationPermission);
      expect(result.allowed).toBe(false);
    });
  });

  describe('canManageCustomRoles', () => {
    it('allows OWNER', () => {
      const principal = makePrincipal('OWNER');
      expect(canManageCustomRoles(principal).allowed).toBe(true);
    });

    it('allows ADMIN', () => {
      const principal = makePrincipal('ADMIN');
      expect(canManageCustomRoles(principal).allowed).toBe(true);
    });

    it('denies CAMPAIGN_MANAGER', () => {
      const principal = makePrincipal('CAMPAIGN_MANAGER');
      expect(canManageCustomRoles(principal).allowed).toBe(false);
    });

    it('denies BILLING', () => {
      const principal = makePrincipal('BILLING');
      expect(canManageCustomRoles(principal).allowed).toBe(false);
    });

    it('denies VIEWER', () => {
      const principal = makePrincipal('VIEWER');
      expect(canManageCustomRoles(principal).allowed).toBe(false);
    });

    it('denies VIEWER with custom role granting organization:update', () => {
      const principal = makePrincipal('VIEWER', ['organization:update']);
      expect(canManageCustomRoles(principal).allowed).toBe(false);
    });
  });

  describe('canAssignCustomRoles', () => {
    it('allows OWNER', () => {
      const principal = makePrincipal('OWNER');
      expect(canAssignCustomRoles(principal).allowed).toBe(true);
    });

    it('allows ADMIN', () => {
      const principal = makePrincipal('ADMIN');
      expect(canAssignCustomRoles(principal).allowed).toBe(true);
    });

    it('denies CAMPAIGN_MANAGER', () => {
      const principal = makePrincipal('CAMPAIGN_MANAGER');
      expect(canAssignCustomRoles(principal).allowed).toBe(false);
    });

    it('denies VIEWER with custom role granting member:update', () => {
      const principal = makePrincipal('VIEWER', ['member:update']);
      expect(canAssignCustomRoles(principal).allowed).toBe(false);
    });
  });

  describe('delegationScope', () => {
    it('allows when all requested permissions are held by actor', () => {
      const principal = makePrincipal('ADMIN');
      const requested = ['organization:read', 'contact:read'] as const;
      const result = delegationScope(principal, requested);
      expect(result.allowed).toBe(true);
    });

    it('denies when any requested permission is not held by actor', () => {
      const principal = makePrincipal('ADMIN');
      const requested = ['ownership:transfer'] as const; // ADMIN doesn't have this
      const result = delegationScope(principal, requested);
      expect(result.allowed).toBe(false);
      expect(result.reason).toBe('permission_not_delegable');
    });

    it('refuses re-delegating received custom permissions', () => {
      const principal = makePrincipal('VIEWER', ['campaign:create']);
      const requested = ['campaign:create'] as const;
      const result = delegationScope(principal, requested);
      expect(result.allowed).toBe(false);
    });

    it('never lets even an OWNER delegate campaign launch to a custom role', () => {
      const principal = makePrincipal('OWNER');
      const result = delegationScope(principal, ['campaign:launch']);
      expect(result).toEqual({ allowed: false, reason: 'permission_not_delegable' });
    });
  });

  describe('canDelegateCustomRole', () => {
    it('allows when target permissions are strict subset of actor permissions', () => {
      const principal = makePrincipal('ADMIN');
      const target = ['organization:read', 'campaign:create'] as const;
      const result = canDelegateCustomRole(principal, target);
      expect(result.allowed).toBe(true);
    });

    it('denies when target has a permission actor does not hold', () => {
      const principal = makePrincipal('ADMIN');
      const target = ['ownership:transfer'] as const; // ADMIN doesn't have this
      const result = canDelegateCustomRole(principal, target);
      expect(result.allowed).toBe(false);
      expect(result.reason).toBe('permission_not_held');
    });

    it('denies when target has same number of permissions as actor (not strictly downward)', () => {
      const principal = makePrincipal('ADMIN');
      const adminPerms = ORGANIZATION_ROLE_PERMISSIONS.ADMIN;
      const target = [...adminPerms]; // Same size
      const result = canDelegateCustomRole(principal, target);
      expect(result.allowed).toBe(false);
      expect(result.reason).toBe('not_strictly_downward');
    });

    it('denies when target has more permissions than actor', () => {
      const principal = makePrincipal('ADMIN');
      const target = [...ORGANIZATION_ROLE_PERMISSIONS.OWNER]; // OWNER has more
      const result = canDelegateCustomRole(principal, target);
      expect(result.allowed).toBe(false);
      expect(result.reason).toBe('permission_not_held');
    });
  });

  describe('isSystemRole', () => {
    it('returns true for SYSTEM type', () => {
      expect(isSystemRole({ type: 'SYSTEM' })).toBe(true);
    });

    it('returns false for CUSTOM type', () => {
      expect(isSystemRole({ type: 'CUSTOM' })).toBe(false);
    });
  });
});