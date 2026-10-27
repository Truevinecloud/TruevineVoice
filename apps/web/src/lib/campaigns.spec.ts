import { describe, expect, it } from 'vitest';

import {
  campaignStatusLabel,
  campaignStatusTone,
  filterCampaigns,
  isDraft,
  paginate,
  summarizeCampaigns,
} from './campaigns';
import type { Campaign } from './org-api';

function campaign(
  id: string,
  name: string,
  status: Campaign['status'],
  scheduledAt: string | null = null,
): Campaign {
  return {
    id,
    name,
    status,
    scheduledAt,
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-02T00:00:00.000Z',
  };
}

describe('campaign list helpers', () => {
  const rows = [
    campaign('1', 'October members', 'DRAFT', '2026-11-01T10:00:00.000Z'),
    campaign('2', 'November follow-up', 'DRAFT'),
    campaign('3', 'Spring reminder', 'COMPLETED'),
    campaign('4', 'Paused record', 'PAUSED'),
  ];

  it('filters by a case-insensitive name fragment and an exact status', () => {
    expect(filterCampaigns(rows, { query: 'MEMBER', status: 'ALL' }).map((row) => row.id)).toEqual([
      '1',
    ]);
    expect(filterCampaigns(rows, { query: '', status: 'DRAFT' }).map((row) => row.id)).toEqual([
      '1',
      '2',
    ]);
    expect(filterCampaigns(rows, { query: 'nothing', status: 'ALL' })).toEqual([]);
    expect(filterCampaigns(rows, { query: '   ', status: 'ALL' })).toHaveLength(rows.length);
  });

  it('labels statuses without implying a call happened', () => {
    expect(campaignStatusLabel('DRAFT')).toBe('Draft');
    expect(campaignStatusLabel('ACTIVE')).toBe('Active record');
    expect(campaignStatusLabel('COMPLETED')).toBe('Completed record');
    expect(campaignStatusLabel('PAUSED')).toBe('Paused');
    expect(campaignStatusTone('DRAFT')).toBe('info');
    expect(campaignStatusTone('COMPLETED')).toBe('neutral');
    expect(isDraft({ status: 'DRAFT' })).toBe(true);
    expect(isDraft({ status: 'ACTIVE' })).toBe(false);
  });

  it('paginates, clamps a page outside the range, and reports the visible slice', () => {
    const items = Array.from({ length: 23 }, (_, index) => index + 1);

    const first = paginate(items, 1, 10);
    expect(first).toMatchObject({ page: 1, pageCount: 3, total: 23, from: 1, to: 10 });
    expect(first.items).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);

    const last = paginate(items, 9, 10);
    expect(last).toMatchObject({ page: 3, from: 21, to: 23 });
    expect(last.items).toEqual([21, 22, 23]);

    expect(paginate([], 4, 10)).toMatchObject({
      page: 1,
      pageCount: 1,
      total: 0,
      from: 0,
      to: 0,
    });
  });

  it('summarizes only the records that were loaded', () => {
    expect(summarizeCampaigns(rows)).toEqual({
      total: 4,
      drafts: 2,
      scheduledDrafts: 1,
      otherStatuses: 2,
    });
  });
});
