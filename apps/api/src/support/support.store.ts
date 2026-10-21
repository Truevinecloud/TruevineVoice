/**
 * The read-only persistence contract behind RBAC-009 support lookup.
 *
 * Deliberately free of credential- and token-shaped fields: `passwordHash`,
 * `tokenHash`, `ipPrefix` and `userAgentHash` have no name here, so a store
 * implementation cannot return them and a service cannot leak them by
 * forwarding a record. Redaction is structural, not a filter someone must
 * remember to apply.
 *
 * Everything is a read. There is no write method on this interface by
 * construction; the only writes support performs are audit rows, and those go
 * through {@link AuditStore}.
 */

export type SupportOrganizationStatus = 'ACTIVE' | 'SUSPENDED';

export type SupportUserStatus = 'ACTIVE' | 'SUSPENDED';

export type SupportMembershipRole = 'OWNER' | 'ADMIN' | 'CAMPAIGN_MANAGER' | 'BILLING' | 'VIEWER';

export interface SupportOrganizationSummary {
  readonly id: string;
  readonly name: string;
  readonly slug: string;
  readonly status: SupportOrganizationStatus;
  readonly createdAt: Date;
  readonly memberCount: number;
  readonly campaignCount: number;
}

export interface SupportOrganizationDetail extends SupportOrganizationSummary {
  readonly suspendedAt: Date | null;
  readonly updatedAt: Date;
}

export interface SupportMemberRecord {
  readonly userId: string;
  readonly email: string;
  readonly userStatus: SupportUserStatus;
  readonly role: SupportMembershipRole;
  readonly joinedAt: Date;
  readonly lockedUntil: Date | null;
}

export interface SupportCampaignSummary {
  readonly id: string;
  readonly name: string;
  readonly status: 'DRAFT' | 'ACTIVE' | 'COMPLETED';
  readonly emergencyStoppedAt: Date | null;
  readonly updatedAt: Date;
}

/** Wallet totals per currency. Sum of the append-only ledger, never a column. */
export interface SupportWalletBalanceRecord {
  readonly currency: string;
  readonly amountMinor: bigint;
  readonly entryCount: number;
  readonly lastEntryAt: Date | null;
}

/** Durable top-up requests per currency. A request, never a payment. */
export interface SupportTopUpSummaryRecord {
  readonly currency: string;
  readonly requestCount: number;
  readonly totalRequestedMinor: bigint;
  readonly lastRequestedAt: Date | null;
}

export interface OrganizationDiagnosticsRecord {
  readonly memberCount: number;
  readonly auditEventCount: number;
  readonly billingProfilePresent: boolean;
  readonly campaigns: {
    readonly total: number;
    readonly byStatus: Readonly<Record<string, number>>;
    readonly emergencyStoppedCount: number;
    readonly recent: readonly SupportCampaignSummary[];
  };
  readonly walletBalances: readonly SupportWalletBalanceRecord[];
  readonly topUpRequests: readonly SupportTopUpSummaryRecord[];
}

export interface SupportPlatformRoleRecord {
  readonly role: string;
  readonly grantedAt: Date;
}

export interface SupportUserSummary {
  readonly id: string;
  readonly email: string;
  readonly status: SupportUserStatus;
  readonly createdAt: Date;
  readonly lockedUntil: Date | null;
  readonly platformRole: SupportPlatformRoleRecord | null;
  readonly membershipCount: number;
}

export interface SupportMembershipRecord {
  readonly organizationId: string;
  readonly organizationName: string;
  readonly organizationSlug: string;
  readonly role: SupportMembershipRole;
  readonly joinedAt: Date;
}

export interface SupportSessionSummary {
  readonly active: number;
  readonly revoked: number;
  readonly expired: number;
  readonly lastUsedAt: Date | null;
}

export interface SupportUserDetail extends SupportUserSummary {
  readonly failedLoginCount: number;
  readonly passwordChangedAt: Date;
  readonly updatedAt: Date;
}

export interface SupportAuditEventRecord {
  readonly id: string;
  readonly action: string;
  readonly outcome: 'SUCCESS' | 'DENIED';
  readonly scope: 'ORGANIZATION' | 'PLATFORM' | null;
  readonly targetType: string | null;
  readonly targetId: string | null;
  readonly occurredAt: Date;
  readonly actorUserId: string;
  readonly actorEmail: string;
  readonly metadata: unknown;
}

/** Position in an audit trail, resolved from a previously returned event id. */
export interface SupportAuditCursor {
  readonly eventId: string;
}

export interface SupportOrganizationSearchInput {
  readonly query?: string;
  readonly status?: SupportOrganizationStatus;
  readonly afterSlug?: string;
  readonly limit: number;
}

export interface SupportUserSearchInput {
  readonly query: string;
  readonly afterEmail?: string;
  readonly limit: number;
}

export interface SupportAuditTrailInput {
  readonly action?: string;
  readonly after?: SupportAuditCursor;
  readonly limit: number;
}

export interface SupportStore {
  searchOrganizations(
    input: SupportOrganizationSearchInput,
  ): Promise<readonly SupportOrganizationSummary[]>;
  findOrganizationDetail(
    organizationId: string,
  ): Promise<SupportOrganizationDetail | undefined>;
  listMembers(organizationId: string, limit: number): Promise<readonly SupportMemberRecord[]>;
  diagnostics(organizationId: string): Promise<OrganizationDiagnosticsRecord | undefined>;
  searchUsers(input: SupportUserSearchInput): Promise<readonly SupportUserSummary[]>;
  findUserDetail(userId: string): Promise<SupportUserDetail | undefined>;
  listUserMemberships(
    userId: string,
    limit: number,
  ): Promise<readonly SupportMembershipRecord[]>;
  sessionSummary(userId: string): Promise<SupportSessionSummary>;
  organizationAuditEvents(
    organizationId: string,
    input: SupportAuditTrailInput,
  ): Promise<readonly SupportAuditEventRecord[]>;
  userAuditEvents(
    userId: string,
    input: SupportAuditTrailInput,
  ): Promise<readonly SupportAuditEventRecord[]>;
}
