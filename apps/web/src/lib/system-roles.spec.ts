import { describe, expect, it } from 'vitest';
import { ORGANIZATION_ROLES, ORGANIZATION_ROLE_PERMISSIONS } from '@truevine/auth';

import { systemRoles } from './system-roles';

describe('systemRoles', () => {
  const roles = systemRoles();

  it('covers every built-in organization role exactly once', () => {
    expect(roles.map((role) => role.id)).toEqual([...ORGANIZATION_ROLES]);
  });

  it('uses the shared permission registry as the source of truth', () => {
    for (const role of roles) {
      expect(role.type).toBe('SYSTEM');
      expect(role.permissions).toEqual(
        ORGANIZATION_ROLE_PERMISSIONS[role.id as keyof typeof ORGANIZATION_ROLE_PERMISSIONS],
      );
      expect(role.name.length).toBeGreaterThan(0);
      expect(role.description).not.toBeNull();
      expect(role.description?.length ?? 0).toBeGreaterThan(0);
    }
  });
});
