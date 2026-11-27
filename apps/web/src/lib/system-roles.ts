/**
 * Built-in organization roles rendered by the role management screen.
 *
 * The API only stores and returns custom roles. System roles are defined by the
 * shared permission registry in `@truevine/auth`, so they are derived here from
 * that registry rather than duplicated in the UI or fetched as fake database
 * records.
 */

import {
  ORGANIZATION_ROLES,
  ORGANIZATION_ROLE_PERMISSIONS,
  type OrganizationRole,
} from '@truevine/auth';

import type { Role } from './role-types';

const SYSTEM_ROLE_DETAILS: Readonly<Record<OrganizationRole, { readonly name: string; readonly description: string }>> = {
  OWNER: {
    name: 'Owner',
    description: 'Full organization control, including ownership transfer and billing.',
  },
  ADMIN: {
    name: 'Admin',
    description: 'Manages members, campaigns and settings; no billing or ownership transfer.',
  },
  CAMPAIGN_MANAGER: {
    name: 'Campaign Manager',
    description: 'Prepares campaigns, audiences and audio; no member or billing administration.',
  },
  BILLING: {
    name: 'Billing',
    description: 'Reads and updates billing and wallet information only.',
  },
  VIEWER: {
    name: 'Viewer',
    description: 'Read-only access to organization information and campaigns.',
  },
};

/** Stable timestamp for registry-defined roles, which have no database record. */
const REGISTRY_TIMESTAMP = '1970-01-01T00:00:00.000Z';

export function systemRoles(): readonly Role[] {
  return ORGANIZATION_ROLES.map((id) => ({
    id,
    name: SYSTEM_ROLE_DETAILS[id].name,
    description: SYSTEM_ROLE_DETAILS[id].description,
    type: 'SYSTEM',
    permissions: ORGANIZATION_ROLE_PERMISSIONS[id],
    assignedUserCount: 0,
    createdAt: REGISTRY_TIMESTAMP,
    updatedAt: REGISTRY_TIMESTAMP,
  }));
}
