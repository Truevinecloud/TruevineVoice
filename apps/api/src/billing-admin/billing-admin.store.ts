export interface BillingAdminWalletBalance {
  readonly currency: string;
  readonly amountMinor: bigint;
  readonly entryCount: number;
  readonly lastEntryAt: Date | null;
}

export interface BillingAdminTopUpSummary {
  readonly currency: string;
  readonly requestCount: number;
  readonly totalRequestedMinor: bigint;
  readonly lastRequestedAt: Date | null;
}

export interface BillingAdminOrganizationSummary {
  readonly id: string;
  readonly name: string;
  readonly slug: string;
  readonly status: 'ACTIVE' | 'SUSPENDED';
  readonly createdAt: Date;
  readonly memberCount: number;
  readonly campaignCount: number;
  readonly billingProfilePresent: boolean;
  readonly walletBalances: readonly BillingAdminWalletBalance[];
  readonly topUpRequests: readonly BillingAdminTopUpSummary[];
}

export interface BillingAdminWalletEntry {
  readonly id: string;
  readonly amountMinor: bigint;
  readonly currency: string;
  readonly reference: string;
  readonly description: string;
  readonly createdAt: Date;
}

export interface BillingAdminTopUpRequest {
  readonly id: string;
  readonly organizationId: string;
  readonly organizationName: string;
  readonly organizationSlug: string;
  readonly amountMinor: bigint;
  readonly currency: string;
  readonly createdById: string;
  readonly createdAt: Date;
}

export interface BillingAdminOrganizationQuery {
  readonly query?: string;
  readonly status?: 'ACTIVE' | 'SUSPENDED';
  readonly afterSlug?: string;
  readonly limit: number;
}

export interface BillingAdminStore {
  listOrganizations(input: BillingAdminOrganizationQuery): Promise<readonly BillingAdminOrganizationSummary[]>;
  findOrganization(id: string): Promise<BillingAdminOrganizationSummary | undefined>;
  walletEntries(organizationId: string, cursor: string | undefined, limit: number): Promise<readonly BillingAdminWalletEntry[]>;
  topUpRequests(input: { organizationId?: string; limit: number }): Promise<readonly BillingAdminTopUpRequest[]>;
}
