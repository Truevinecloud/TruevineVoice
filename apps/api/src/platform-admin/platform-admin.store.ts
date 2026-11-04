import type { PlatformRole } from '@truevine/auth';

export interface PlatformAdminAssignment {
  readonly userId: string;
  readonly email: string;
  readonly status: 'ACTIVE' | 'SUSPENDED';
  readonly role: PlatformRole;
  readonly grantedByUserId: string | null;
  readonly grantedAt: Date;
  readonly revokedAt: Date | null;
}

export interface PlatformAdminUser {
  readonly id: string;
  readonly email: string;
  readonly status: 'ACTIVE' | 'SUSPENDED';
  readonly platformRole: PlatformRole | null;
}

export interface PlatformAdminStore {
  listAssignments(): Promise<readonly PlatformAdminAssignment[]>;
  findUser(userId: string): Promise<{ readonly id: string; readonly email: string; readonly status: 'ACTIVE' | 'SUSPENDED' } | undefined>;
  searchEligibleUsers(query: string): Promise<readonly PlatformAdminUser[]>;
  grantRole(input: {
    readonly userId: string;
    readonly role: PlatformRole;
    readonly grantedByUserId: string;
  }): Promise<PlatformAdminAssignment>;
  revokeRole(userId: string): Promise<'revoked' | 'not_found' | 'last_owner'>;
  countActiveOwners(excludingUserId?: string): Promise<number>;
}
