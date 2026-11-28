import type { CustomRoleStore } from '../custom-roles/custom-role.store.js';
import type { AuditStore, AuthStore, OrganizationStore } from './auth.store.js';
import type { Prisma } from '@truevine/database';

/** One PostgreSQL transaction for a security mutation and its audit records. */
export interface SecurityStores {
  readonly auth: AuthStore;
  readonly organizations: OrganizationStore;
  readonly audit: AuditStore;
  readonly customRoles: CustomRoleStore;
  lockUser(id: string): Promise<void>;
  lockOrganization(id: string): Promise<void>;
}

export interface SecurityTransactionOptions {
  readonly isolationLevel: Prisma.TransactionIsolationLevel;
}

export interface SecurityTransaction {
  run<T>(
    work: (stores: SecurityStores) => Promise<T>,
    options?: SecurityTransactionOptions,
  ): Promise<T>;
}

export const SECURITY_TRANSACTION = Symbol('SECURITY_TRANSACTION');
