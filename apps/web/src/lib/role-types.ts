/** Shared read models for organization role screens. */

export interface Role {
  readonly id: string;
  readonly name: string;
  readonly description: string | null;
  readonly type: 'SYSTEM' | 'CUSTOM';
  readonly permissions: readonly string[];
  readonly assignedUserCount: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface RolesResponse {
  readonly system: readonly Role[];
  readonly custom: readonly Role[];
}

export interface Member {
  readonly userId: string;
  readonly email: string;
  readonly role: string;
  readonly joinedAt: string;
}

export interface RoleAssignment {
  readonly userId: string;
  readonly email: string;
  readonly assignedAt: string;
}
