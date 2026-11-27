/**
 * Customer analytics API contract helpers.
 *
 * The analytics API is read-only and organization-scoped. This module contains
 * no access decisions: the server pages gate `reporting:read`, and the API
 * re-checks the session, tenant membership and permission on every request.
 * Its job is to build exact URLs, keep money as integer minor units, and turn
 * API failures into safe, specific messages for the UI.
 */

import { ApiError, messageFor } from './api';
import { browserApiUrl } from './api-target';
import { isoFromLocalDateTime } from './datetime';

export const ANALYTICS_CALL_STATES = [
  'ANSWERED',
  'BUSY',
  'CANCELLED',
  'COMPLETED',
  'DIALING',
  'FAILED',
  'NO_ANSWER',
  'QUEUED',
  'RINGING',
  'TIMEOUT',
] as const;

export type AnalyticsCallState = (typeof ANALYTICS_CALL_STATES)[number];
export type AnalyticsStatusCounts = Readonly<Record<AnalyticsCallState, number>>;

export interface AnalyticsMoney {
  readonly amountMinor: string;
  readonly currency: 'UGX';
}

export interface AnalyticsTotals {
  readonly attempts: number;
  /** Current-state proxy: attempts in ANSWERED or COMPLETED, not a rate. */
  readonly answered: number;
  readonly statusCounts: AnalyticsStatusCounts;
  readonly spend: AnalyticsMoney;
}

export interface AnalyticsFilters {
  readonly from: string | null;
  readonly to: string | null;
  readonly campaignIds: readonly string[];
}

export interface AnalyticsReconciliation {
  readonly status: 'RECONCILED';
  readonly usageEvents: number;
  readonly ledgerEntries: number;
}

export interface AnalyticsCampaignMetadata {
  readonly campaignId: string;
  readonly name: string;
  readonly status: string;
  readonly createdAt: string;
}

export interface AnalyticsCampaign extends AnalyticsTotals, AnalyticsCampaignMetadata {}

export interface AnalyticsCallLog {
  readonly campaignId: string;
  readonly attemptId: string;
  readonly state: AnalyticsCallState;
  readonly answered: boolean;
  readonly spend: AnalyticsMoney;
}

export interface AnalyticsSummaryResponse {
  readonly organizationId: string;
  readonly totals: AnalyticsTotals;
  readonly reconciliation: AnalyticsReconciliation;
  readonly filters: AnalyticsFilters;
}

export interface AnalyticsCampaignsResponse extends AnalyticsSummaryResponse {
  readonly campaigns: readonly AnalyticsCampaign[];
}

export interface AnalyticsCampaignResponse {
  readonly organizationId: string;
  readonly campaign: AnalyticsCampaign;
  readonly reconciliation: AnalyticsReconciliation;
  readonly filters: AnalyticsFilters;
}

export interface AnalyticsCallLogsResponse extends AnalyticsSummaryResponse {
  readonly page: number;
  readonly pageSize: number;
  readonly total: number;
  readonly totalPages: number;
  readonly items: readonly AnalyticsCallLog[];
}

export interface AnalyticsCampaignCallLogsResponse extends AnalyticsCallLogsResponse {
  readonly campaign: AnalyticsCampaignMetadata;
}

/** Query values the UI applies after the operator submits the filter form. */
export interface AnalyticsQuery {
  readonly from?: string;
  readonly to?: string;
  readonly campaignIds?: readonly string[];
}

export interface AnalyticsPageQuery extends AnalyticsQuery {
  readonly page?: number;
  readonly pageSize?: number;
}

/** Maximum page size accepted by the API. */
export const ANALYTICS_PAGE_SIZE = 20;
/** The API rejects exports above this many rows. */
export const ANALYTICS_EXPORT_LIMIT = 10_000;

function appendFilters(params: URLSearchParams, query: AnalyticsQuery): void {
  if (query.from) params.set('from', query.from);
  if (query.to) params.set('to', query.to);
  for (const campaignId of query.campaignIds ?? []) params.append('campaignIds', campaignId);
}

/** Builds a query string with repeated campaign IDs, never a JSON array. */
export function analyticsQueryString(query: AnalyticsQuery = {}): string {
  const params = new URLSearchParams();
  appendFilters(params, query);
  const encoded = params.toString();
  return encoded.length === 0 ? '' : `?${encoded}`;
}

/** Builds one of the six documented organization-scoped API paths. */
export function analyticsPath(organizationId: string, resource: string, query = ''): string {
  return `/organizations/${encodeURIComponent(organizationId)}/analytics/${resource}${query}`;
}

export function analyticsPageQueryString(query: AnalyticsPageQuery): string {
  const params = new URLSearchParams();
  appendFilters(params, query);
  if (query.page !== undefined) params.set('page', String(query.page));
  if (query.pageSize !== undefined) params.set('pageSize', String(query.pageSize));
  const encoded = params.toString();
  return encoded.length === 0 ? '' : `?${encoded}`;
}

/**
 * Formats minor units without ever converting them to a JavaScript number.
 * UGX has no sub-unit; the comma grouping is presentation only.
 */
export function formatAnalyticsMoney(amount: AnalyticsMoney): string {
  try {
    return `UGX ${BigInt(amount.amountMinor).toLocaleString('en-UG')}`;
  } catch {
    return 'UGX unavailable';
  }
}

/** Validates the operator's local datetime inputs before any request is made. */
export function analyticsFilterError(fromLocal: string, toLocal: string): string | null {
  const from = isoFromLocalDateTime(fromLocal);
  const to = isoFromLocalDateTime(toLocal);

  if ((fromLocal.trim().length > 0 && from === null) || (toLocal.trim().length > 0 && to === null)) {
    return 'Enter a valid start and end date.';
  }
  if ((from === null) !== (to === null)) {
    return 'Select both a start and an end date.';
  }
  if (from === null || to === null) return null;
  if (Date.parse(from) >= Date.parse(to)) {
    return 'The end date must be after the start date.';
  }
  if (Date.parse(to) - Date.parse(from) > 366 * 24 * 60 * 60 * 1000) {
    return 'Choose a date range of 366 days or less.';
  }
  return null;
}

/** Converts validated local datetime inputs into the API's paired instants. */
export function analyticsQueryFromLocal(
  fromLocal: string,
  toLocal: string,
  campaignIds: readonly string[],
): AnalyticsQuery {
  const from = isoFromLocalDateTime(fromLocal);
  const to = isoFromLocalDateTime(toLocal);
  if (from === null || to === null) return { campaignIds: [...campaignIds] };
  return { from, to, campaignIds: [...campaignIds] };
}

const CALL_STATE_LABELS: Readonly<Record<AnalyticsCallState, string>> = {
  ANSWERED: 'Answered',
  BUSY: 'Busy',
  CANCELLED: 'Cancelled',
  COMPLETED: 'Completed',
  DIALING: 'Dialing',
  FAILED: 'Failed',
  NO_ANSWER: 'No answer',
  QUEUED: 'Queued',
  RINGING: 'Ringing',
  TIMEOUT: 'Timeout',
};

export function callStateLabel(state: AnalyticsCallState): string {
  return CALL_STATE_LABELS[state] ?? state;
}

export function callStateTone(
  state: AnalyticsCallState,
): 'neutral' | 'success' | 'warning' | 'danger' | 'info' {
  switch (state) {
    case 'ANSWERED':
    case 'COMPLETED':
      return 'success';
    case 'FAILED':
    case 'TIMEOUT':
    case 'CANCELLED':
      return 'danger';
    case 'BUSY':
    case 'NO_ANSWER':
    case 'RINGING':
      return 'warning';
    case 'DIALING':
    case 'QUEUED':
      return 'info';
    default:
      return 'neutral';
  }
}

export type AnalyticsErrorKind =
  | 'auth'
  | 'permission'
  | 'not-found'
  | 'conflict'
  | 'export'
  | 'generic';

/** Stable, non-sensitive messages for the failures the customer UI must handle. */
export function describeAnalyticsError(error: unknown): {
  readonly message: string;
  readonly kind: AnalyticsErrorKind;
} {
  if (error instanceof ApiError) {
    switch (error.status) {
      case 401:
        return {
          kind: 'auth',
          message: 'Your session has expired. Sign in again to view analytics.',
        };
      case 403:
        return {
          kind: 'permission',
          message: 'You do not have reporting access in this organization.',
        };
      case 404:
        return {
          kind: 'not-found',
          message: 'This campaign could not be found in the selected organization.',
        };
      case 409:
        return {
          kind: 'conflict',
          message:
            'Analytics could not be reconciled with the immutable ledger. No figures are shown.',
        };
      case 413:
        return {
          kind: 'export',
          message: `The export contains more than ${ANALYTICS_EXPORT_LIMIT.toLocaleString('en-UG')} rows. Narrow the filters and try again.`,
        };
      default:
        return { kind: 'generic', message: messageFor(error) };
    }
  }

  return { kind: 'generic', message: messageFor(error) };
}

/**
 * Downloads the real CSV through the same-origin proxy and preserves its exact
 * bytes. Filters are the applied filters, so the file always matches the table.
 */
export async function downloadAnalyticsCsv(
  organizationId: string,
  query: AnalyticsQuery,
): Promise<void> {
  const target = browserApiUrl(
    analyticsPath(organizationId, 'calls.csv', analyticsQueryString(query)),
  );
  const response = await fetch(target, {
    credentials: 'same-origin',
    cache: 'no-store',
    headers: { accept: 'text/csv' },
  });

  if (!response.ok) {
    const text = await response.text();
    let code = 'unexpected_error';
    let message = 'The export could not be downloaded. Please try again.';
    try {
      const body = JSON.parse(text) as {
        readonly error?: { readonly code?: string; readonly message?: string };
      };
      code = body.error?.code ?? code;
      message = body.error?.message ?? message;
    } catch {
      // A gateway error need not be JSON; the safe fallback above is enough.
    }
    throw new ApiError(response.status, code, message);
  }

  const blob = await response.blob();
  const objectUrl = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = objectUrl;
  anchor.download = 'analytics-calls.csv';
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(objectUrl), 0);
}
