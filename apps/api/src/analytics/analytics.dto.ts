import type { CallState } from '@truevine/domain';

/** Exact integer minor units. Never a JSON number. */
export interface MoneyDto {
  readonly amountMinor: string;
  readonly currency: 'UGX';
}

export interface AnalyticsSummaryDto {
  readonly attempts: number;
  readonly answered: number;
  readonly statusCounts: Readonly<Record<CallState, number>>;
  readonly spend: MoneyDto;
}

export interface AnalyticsCampaignMetadataDto {
  readonly campaignId: string;
  readonly name: string;
  readonly status: string;
  readonly createdAt: string;
}

export interface AnalyticsCampaignDto extends AnalyticsSummaryDto, AnalyticsCampaignMetadataDto {}

export interface AnalyticsFiltersDto {
  /** Inclusive ISO instant, or null when no date filter was applied. */
  readonly from: string | null;
  /** Exclusive ISO instant, or null when no date filter was applied. */
  readonly to: string | null;
  readonly campaignIds: readonly string[];
}

export interface AnalyticsReconciliationDto {
  readonly status: 'RECONCILED';
  readonly usageEvents: number;
  readonly ledgerEntries: number;
}

export interface AnalyticsSummaryResponseDto {
  readonly organizationId: string;
  readonly totals: AnalyticsSummaryDto;
  readonly reconciliation: AnalyticsReconciliationDto;
  readonly filters: AnalyticsFiltersDto;
}

export interface AnalyticsCampaignsResponseDto {
  readonly organizationId: string;
  readonly totals: AnalyticsSummaryDto;
  readonly campaigns: readonly AnalyticsCampaignDto[];
  readonly reconciliation: AnalyticsReconciliationDto;
  readonly filters: AnalyticsFiltersDto;
}

export interface AnalyticsCampaignResponseDto {
  readonly organizationId: string;
  readonly campaign: AnalyticsCampaignDto;
  readonly reconciliation: AnalyticsReconciliationDto;
  readonly filters: AnalyticsFiltersDto;
}

export interface AnalyticsCallLogDto {
  readonly campaignId: string;
  readonly attemptId: string;
  readonly state: CallState;
  readonly answered: boolean;
  readonly spend: MoneyDto;
}

export interface AnalyticsCallLogsResponseDto {
  readonly organizationId: string;
  readonly page: number;
  readonly pageSize: number;
  /** Total matching rows before pagination. */
  readonly total: number;
  readonly totalPages: number;
  readonly items: readonly AnalyticsCallLogDto[];
  /** Totals for the full filtered result, not just this page. */
  readonly totals: AnalyticsSummaryDto;
  readonly reconciliation: AnalyticsReconciliationDto;
  readonly filters: AnalyticsFiltersDto;
}

export interface AnalyticsCampaignCallLogsResponseDto extends AnalyticsCallLogsResponseDto {
  readonly campaign: AnalyticsCampaignMetadataDto;
}

/** Raw, untrusted query values accepted by the request parsers. */
export interface AnalyticsQueryInput {
  readonly from?: unknown;
  readonly to?: unknown;
  readonly campaignIds?: unknown;
}

export interface AnalyticsPaginationQueryInput extends AnalyticsQueryInput {
  readonly page?: unknown;
  readonly pageSize?: unknown;
}
