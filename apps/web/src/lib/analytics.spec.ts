// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from './api';
import {
  ANALYTICS_EXPORT_LIMIT,
  analyticsFilterError,
  analyticsPath,
  analyticsQueryString,
  describeAnalyticsError,
  downloadAnalyticsCsv,
  formatAnalyticsMoney,
} from './analytics';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('analytics API helpers', () => {
  it('builds organization-scoped paths and repeated campaign filters', () => {
    const query = analyticsQueryString({
      from: '2026-01-01T00:00:00.000Z',
      to: '2026-02-01T00:00:00.000Z',
      campaignIds: ['campaign-a', 'campaign-b'],
    });
    const params = new URLSearchParams(query.slice(1));

    expect(analyticsPath('org a', 'calls')).toBe('/organizations/org%20a/analytics/calls');
    expect(params.get('from')).toBe('2026-01-01T00:00:00.000Z');
    expect(params.get('to')).toBe('2026-02-01T00:00:00.000Z');
    expect(params.getAll('campaignIds')).toEqual(['campaign-a', 'campaign-b']);
  });

  it('formats exact minor units without a floating-point conversion', () => {
    expect(
      formatAnalyticsMoney({ amountMinor: '9007199254740993', currency: 'UGX' }),
    ).toBe('UGX 9,007,199,254,740,993');
    expect(formatAnalyticsMoney({ amountMinor: '1234', currency: 'UGX' })).toBe('UGX 1,234');
  });

  it('validates paired, ordered and bounded date ranges', () => {
    expect(analyticsFilterError('', '')).toBeNull();
    expect(analyticsFilterError('2026-01-01T00:00', '')).toMatch(/both/i);
    expect(analyticsFilterError('2026-02-01T00:00', '2026-01-01T00:00')).toMatch(/after/i);
    expect(analyticsFilterError('2026-01-01T00:00', '2029-01-01T00:00')).toMatch(/366 days/i);
  });

  it('gives stable messages for every customer-facing failure class', () => {
    expect(describeAnalyticsError(new ApiError(401, 'unauthenticated', 'x')).kind).toBe('auth');
    expect(describeAnalyticsError(new ApiError(403, 'forbidden', 'x')).kind).toBe('permission');
    expect(describeAnalyticsError(new ApiError(404, 'not_found', 'x')).kind).toBe('not-found');
    expect(describeAnalyticsError(new ApiError(409, 'LEDGER_MISMATCH', 'x')).message).toMatch(
      /could not be reconciled/i,
    );
    expect(describeAnalyticsError(new ApiError(413, 'export_too_large', 'x')).message).toContain(
      ANALYTICS_EXPORT_LIMIT.toLocaleString('en-UG'),
    );
  });

  it('downloads an actual CSV blob and translates an oversized export', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response('organization_id,attempt_id\norg-a,attempt-a\n', {
        status: 200,
        headers: { 'content-type': 'text/csv' },
      }),
    );
    const createObjectURL = vi.fn(() => 'blob:analytics');
    const revokeObjectURL = vi.fn();
    class StubURL extends URL {
      static createObjectURL = createObjectURL;
      static revokeObjectURL = revokeObjectURL;
    }
    vi.stubGlobal('fetch', fetchMock);
    vi.stubGlobal('URL', StubURL);
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);

    await downloadAnalyticsCsv('org-a', { campaignIds: ['campaign-a'] });

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/organizations/org-a/analytics/calls.csv?campaignIds=campaign-a',
      expect.objectContaining({ credentials: 'same-origin', cache: 'no-store' }),
    );
    expect(click).toHaveBeenCalledOnce();

    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: { code: 'export_too_large', message: 'Too large.' } }), {
        status: 413,
        headers: { 'content-type': 'application/json' },
      }),
    );
    await expect(downloadAnalyticsCsv('org-a', {})).rejects.toMatchObject({
      status: 413,
      code: 'export_too_large',
    });
  });
});
