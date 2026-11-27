import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import type { CallState } from '@truevine/domain';

import { analyticsHttpError, rethrowAnalyticsError } from './analytics-errors.js';
import { serializeAnalyticsCsv } from './analytics-csv.js';
import type {
  AnalyticsCampaignCallLogsResponseDto,
  AnalyticsCampaignDto,
  AnalyticsCampaignMetadataDto,
  AnalyticsCampaignResponseDto,
  AnalyticsCampaignsResponseDto,
  AnalyticsCallLogsResponseDto,
  AnalyticsFiltersDto,
  AnalyticsPaginationQueryInput,
  AnalyticsQueryInput,
  AnalyticsSummaryDto,
  AnalyticsSummaryResponseDto,
} from './analytics.dto.js';
import { ANALYTICS_CALL_STATES, type AnalyticsReport } from './analytics-metrics.js';
import {
  type AnalyticsIntegrationReport as ReaderReport,
  type AnalyticsReadFilters,
} from './analytics-read-adapter.js';
import { ANALYTICS_READER } from './analytics.tokens.js';

/** The narrow port the HTTP layer needs from the W5-03B adapter. */
export interface AnalyticsReader {
  report(organizationId: string, filters?: AnalyticsReadFilters): Promise<ReaderReport>;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MAX_CAMPAIGN_FILTERS = 100;
const MAX_DATE_RANGE_MS = 366 * 24 * 60 * 60 * 1000;
const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 100;
const MAX_EXPORT_ROWS = 10_000;

interface ParsedFilters extends AnalyticsReadFilters {
  readonly from: Date | undefined;
  readonly to: Date | undefined;
  readonly campaignIds: readonly string[];
}

interface ParsedPagination {
  readonly page: number;
  readonly pageSize: number;
}

function invalid(message: string): never {
  throw analyticsHttpError(HttpStatus.BAD_REQUEST, 'invalid_request', message);
}

function requireUuid(value: unknown, label: string): string {
  if (typeof value !== 'string' || !UUID.test(value)) invalid(`${label} must be a UUID.`);
  return value.toLowerCase();
}

function parseDate(value: unknown, label: string): Date {
  if (typeof value !== 'string' || value.trim().length === 0) {
    invalid(`${label} must be an ISO 8601 date-time string.`);
  }
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) invalid(`${label} is not a valid date.`);
  return parsed;
}

function parseCampaignIds(value: unknown): readonly string[] {
  if (value === undefined) return [];
  const rawValues = Array.isArray(value) ? value : [value];
  const ids: string[] = [];
  for (const raw of rawValues) {
    if (typeof raw !== 'string') invalid('campaignIds must contain only strings.');
    for (const part of raw.split(',')) {
      const trimmed = part.trim();
      if (trimmed.length > 0) ids.push(requireUuid(trimmed, 'campaignId'));
    }
  }
  const unique = [...new Set(ids)];
  if (unique.length > MAX_CAMPAIGN_FILTERS) {
    invalid(`At most ${MAX_CAMPAIGN_FILTERS} campaign IDs may be supplied.`);
  }
  return unique;
}

function parsePaginationInt(
  value: unknown,
  label: string,
  minimum: number,
  maximum: number,
  fallback: number,
): number {
  if (value === undefined) return fallback;
  if (typeof value !== 'string' || !/^\d+$/.test(value.trim())) {
    invalid(`${label} must be an integer.`);
  }
  const parsed = Number(value.trim());
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    invalid(`${label} must be between ${minimum} and ${maximum}.`);
  }
  return parsed;
}

function parseFilters(query: AnalyticsQueryInput): ParsedFilters {
  const hasFrom = query.from !== undefined;
  const hasTo = query.to !== undefined;
  if (hasFrom !== hasTo) invalid('from and to must be supplied together.');

  const from = hasFrom ? parseDate(query.from, 'from') : undefined;
  const to = hasTo ? parseDate(query.to, 'to') : undefined;
  if (from && to) {
    if (from.getTime() >= to.getTime()) invalid('from must be earlier than to.');
    if (to.getTime() - from.getTime() > MAX_DATE_RANGE_MS) {
      invalid('The date range may not exceed 366 days.');
    }
  }

  return { from, to, campaignIds: parseCampaignIds(query.campaignIds) };
}

function parsePagination(query: AnalyticsPaginationQueryInput): ParsedPagination {
  return {
    page: parsePaginationInt(query.page, 'page', 1, Number.MAX_SAFE_INTEGER, 1),
    pageSize: parsePaginationInt(query.pageSize, 'pageSize', 1, MAX_PAGE_SIZE, DEFAULT_PAGE_SIZE),
  };
}

function mapMoney(value: AnalyticsReport['totals']['spend']): AnalyticsSummaryDto['spend'] {
  return {
    amountMinor: value.amountMinor.toString(),
    currency: value.currency as 'UGX',
  };
}

function mapSummary(summary: AnalyticsReport['totals']): AnalyticsSummaryDto {
  return {
    attempts: summary.attempts,
    answered: summary.answered,
    statusCounts: { ...summary.statusCounts },
    spend: mapMoney(summary.spend),
  };
}

function zeroSummary(): AnalyticsReport['totals'] {
  return {
    attempts: 0,
    answered: 0,
    statusCounts: Object.fromEntries(ANALYTICS_CALL_STATES.map((state) => [state, 0])) as Readonly<
      Record<CallState, number>
    >,
    spend: { amountMinor: 0n, currency: 'UGX' },
  };
}

function mapFilters(filters: AnalyticsReadFilters): AnalyticsFiltersDto {
  return {
    from: filters.from instanceof Date ? filters.from.toISOString() : null,
    to: filters.to instanceof Date ? filters.to.toISOString() : null,
    campaignIds: [...(filters.campaignIds ?? [])],
  };
}

function mapMetadata(
  metadata: ReaderReport['campaignMetadata'][number],
): AnalyticsCampaignMetadataDto {
  return {
    campaignId: metadata.campaignId,
    name: metadata.name,
    status: metadata.status,
    createdAt: metadata.createdAt.toISOString(),
  };
}

/**
 * Read-only application service for W5-03 analytics.
 *
 * All data comes from the accepted adapter and metrics engine. This layer only
 * validates request parameters, adds pagination and serialises bigint money as
 * exact decimal strings for JSON.
 */
@Injectable()
export class AnalyticsService {
  constructor(@Inject(ANALYTICS_READER) private readonly reader: AnalyticsReader) {}

  private async read(organizationId: string, filters: AnalyticsReadFilters): Promise<ReaderReport> {
    const organization = requireUuid(organizationId, 'organizationId');
    try {
      return await this.reader.report(organization, filters);
    } catch (error) {
      rethrowAnalyticsError(error);
    }
  }

  async summary(
    organizationId: string,
    query: AnalyticsQueryInput,
  ): Promise<AnalyticsSummaryResponseDto> {
    const filters = parseFilters(query);
    const report = await this.read(organizationId, filters);
    return {
      organizationId: requireUuid(organizationId, 'organizationId'),
      totals: mapSummary(report.totals),
      reconciliation: report.reconciliation,
      filters: mapFilters(filters),
    };
  }

  async campaigns(
    organizationId: string,
    query: AnalyticsQueryInput,
  ): Promise<AnalyticsCampaignsResponseDto> {
    const filters = parseFilters(query);
    const report = await this.read(organizationId, filters);
    const metadataById = new Map(
      report.campaignMetadata.map((metadata) => [metadata.campaignId, metadata]),
    );
    const summaryById = new Map(report.campaigns.map((summary) => [summary.campaignId, summary]));

    for (const campaignId of summaryById.keys()) {
      if (!metadataById.has(campaignId)) {
        throw analyticsHttpError(
          HttpStatus.CONFLICT,
          'analytics_evidence_conflict',
          'Campaign metrics have no matching campaign record.',
        );
      }
    }

    const campaigns: AnalyticsCampaignDto[] = [...metadataById.values()]
      .sort((a, b) => (a.campaignId < b.campaignId ? -1 : a.campaignId > b.campaignId ? 1 : 0))
      .map((metadata) => {
        const summary = summaryById.get(metadata.campaignId);
        return { ...mapMetadata(metadata), ...mapSummary(summary ?? zeroSummary()) };
      });

    return {
      organizationId: requireUuid(organizationId, 'organizationId'),
      totals: mapSummary(report.totals),
      campaigns,
      reconciliation: report.reconciliation,
      filters: mapFilters(filters),
    };
  }

  async campaign(
    organizationId: string,
    campaignId: string,
    query: AnalyticsQueryInput,
  ): Promise<AnalyticsCampaignResponseDto> {
    const id = requireUuid(campaignId, 'campaignId');
    const filters: ParsedFilters = { ...parseFilters(query), campaignIds: [id] };
    const report = await this.read(organizationId, filters);
    const metadata = report.campaignMetadata.find((entry) => entry.campaignId === id);

    // A campaign belonging to another tenant is indistinguishable from a
    // non-existent one here; the organization guard has already proved the
    // caller's tenancy.
    if (!metadata) {
      throw analyticsHttpError(
        HttpStatus.NOT_FOUND,
        'analytics_campaign_not_found',
        'Campaign analytics are not available for this organization.',
      );
    }

    const summary = report.campaigns.find((entry) => entry.campaignId === id);
    return {
      organizationId: requireUuid(organizationId, 'organizationId'),
      campaign: { ...mapMetadata(metadata), ...mapSummary(summary ?? zeroSummary()) },
      reconciliation: report.reconciliation,
      filters: mapFilters(filters),
    };
  }

  async callLogs(
    organizationId: string,
    query: AnalyticsPaginationQueryInput,
  ): Promise<AnalyticsCallLogsResponseDto> {
    const filters = parseFilters(query);
    const pagination = parsePagination(query);
    const report = await this.read(organizationId, filters);
    return this.buildCallLogsPage(organizationId, filters, pagination, report);
  }

  async campaignCallLogs(
    organizationId: string,
    campaignId: string,
    query: AnalyticsPaginationQueryInput,
  ): Promise<AnalyticsCampaignCallLogsResponseDto> {
    const id = requireUuid(campaignId, 'campaignId');
    const filters: ParsedFilters = { ...parseFilters(query), campaignIds: [id] };
    const pagination = parsePagination(query);
    const report = await this.read(organizationId, filters);
    const metadata = report.campaignMetadata.find((entry) => entry.campaignId === id);
    if (!metadata) {
      throw analyticsHttpError(
        HttpStatus.NOT_FOUND,
        'analytics_campaign_not_found',
        'Campaign analytics are not available for this organization.',
      );
    }
    return {
      ...this.buildCallLogsPage(organizationId, filters, pagination, report),
      campaign: mapMetadata(metadata),
    };
  }

  private buildCallLogsPage(
    organizationId: string,
    filters: AnalyticsReadFilters,
    pagination: ParsedPagination,
    report: ReaderReport,
  ): AnalyticsCallLogsResponseDto {
    const start = (pagination.page - 1) * pagination.pageSize;
    const items = report.callLogs.slice(start, start + pagination.pageSize).map((row) => ({
      campaignId: row.campaignId,
      attemptId: row.attemptId,
      state: row.state,
      answered: row.answered,
      spend: mapMoney(row.spend),
    }));

    return {
      organizationId: requireUuid(organizationId, 'organizationId'),
      page: pagination.page,
      pageSize: pagination.pageSize,
      total: report.callLogs.length,
      totalPages: Math.ceil(report.callLogs.length / pagination.pageSize),
      items,
      totals: mapSummary(report.totals),
      reconciliation: report.reconciliation,
      filters: mapFilters(filters),
    };
  }

  async csv(organizationId: string, query: AnalyticsQueryInput): Promise<string> {
    const filters = parseFilters(query);
    const report = await this.read(organizationId, filters);
    if (report.callLogs.length > MAX_EXPORT_ROWS) {
      throw analyticsHttpError(
        HttpStatus.PAYLOAD_TOO_LARGE,
        'export_too_large',
        `The export contains more than ${MAX_EXPORT_ROWS} rows. Narrow the filters and retry.`,
      );
    }
    return serializeAnalyticsCsv(report);
  }
}
