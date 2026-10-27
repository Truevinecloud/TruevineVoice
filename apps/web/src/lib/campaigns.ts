/**
 * Campaign list helpers.
 *
 * The API returns the organization's full campaign collection and takes no
 * query parameters. Search, filtering and paging therefore happen in the
 * browser over data the caller is already authorized to read. Nothing here
 * decides access; it only arranges rows the API already returned.
 */

import type { Campaign } from './org-api';

/** Every status the API can report. `PAUSED` is an emergency-stopped record. */
export type CampaignStatus = Campaign['status'];

export const CAMPAIGN_STATUS_FILTERS = ['ALL', 'DRAFT', 'ACTIVE', 'COMPLETED', 'PAUSED'] as const;

export type CampaignStatusFilter = (typeof CAMPAIGN_STATUS_FILTERS)[number];

export interface CampaignFilters {
  readonly query: string;
  readonly status: CampaignStatusFilter;
}

/** What the status means for the operator, without implying any call happened. */
export function campaignStatusLabel(status: CampaignStatus): string {
  switch (status) {
    case 'DRAFT':
      return 'Draft';
    case 'ACTIVE':
      return 'Active record';
    case 'COMPLETED':
      return 'Completed record';
    case 'PAUSED':
      return 'Paused';
    default:
      return status;
  }
}

export function campaignStatusTone(
  status: CampaignStatus,
): 'neutral' | 'success' | 'warning' | 'info' {
  switch (status) {
    case 'DRAFT':
      return 'info';
    case 'ACTIVE':
      return 'success';
    case 'PAUSED':
      return 'warning';
    default:
      return 'neutral';
  }
}

/** Only draft records may be edited, deleted or sent to preflight. */
export function isDraft(campaign: Pick<Campaign, 'status'>): boolean {
  return campaign.status === 'DRAFT';
}

/** Case-insensitive name search plus an exact status filter. */
export function filterCampaigns(
  campaigns: readonly Campaign[],
  filters: CampaignFilters,
): readonly Campaign[] {
  const text = filters.query.trim().toLocaleLowerCase();

  return campaigns.filter((campaign) => {
    if (filters.status !== 'ALL' && campaign.status !== filters.status) return false;
    if (text.length === 0) return true;

    return campaign.name.toLocaleLowerCase().includes(text);
  });
}

export interface Page<T> {
  readonly items: readonly T[];
  readonly page: number;
  readonly pageCount: number;
  readonly total: number;
  /** 1-based index of the first visible row, or 0 for an empty page. */
  readonly from: number;
  /** 1-based index of the last visible row, or 0 for an empty page. */
  readonly to: number;
}

/**
 * Slices `items` into a page.
 *
 * A page number outside the range is clamped rather than rejected, so deleting
 * the last row of the last page cannot strand the operator on a blank screen.
 */
export function paginate<T>(items: readonly T[], requested: number, size: number): Page<T> {
  const pageSize = Math.max(1, Math.trunc(size) || 1);
  const total = items.length;
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const raw = Math.trunc(requested) || 1;
  const page = Math.min(Math.max(1, raw), pageCount);
  const start = (page - 1) * pageSize;
  const slice = items.slice(start, start + pageSize);

  return {
    items: slice,
    page,
    pageCount,
    total,
    from: total === 0 ? 0 : start + 1,
    to: start + slice.length,
  };
}

/** Summary counts derived from the records already loaded. Never estimated. */
export interface CampaignSummary {
  readonly total: number;
  readonly drafts: number;
  readonly scheduledDrafts: number;
  readonly otherStatuses: number;
}

export function summarizeCampaigns(campaigns: readonly Campaign[]): CampaignSummary {
  let drafts = 0;
  let scheduledDrafts = 0;
  let otherStatuses = 0;

  for (const campaign of campaigns) {
    if (campaign.status === 'DRAFT') {
      drafts += 1;
      if (campaign.scheduledAt) scheduledDrafts += 1;
    } else {
      otherStatuses += 1;
    }
  }

  return { total: campaigns.length, drafts, scheduledDrafts, otherStatuses };
}
