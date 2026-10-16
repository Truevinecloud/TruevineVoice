import type { AuditStore, AuthStore, OrganizationStore } from './auth.store.js';

/** One PostgreSQL transaction for a security mutation and its audit records. */
export interface SecurityStores {
  readonly auth: AuthStore;
  readonly organizations: OrganizationStore;
  readonly audit: AuditStore;
  lockUser(id: string): Promise<void>;
  lockOrganization(id: string): Promise<void>;
}

export interface SecurityTransaction {
  run<T>(work: (stores: SecurityStores) => Promise<T>): Promise<T>;
}

export const SECURITY_TRANSACTION = Symbol('SECURITY_TRANSACTION');
