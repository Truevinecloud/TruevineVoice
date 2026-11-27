// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  ANALYTICS_CALL_STATES,
  type AnalyticsCampaignCallLogsResponse,
  type AnalyticsCampaignResponse,
  type AnalyticsStatusCounts,
  type AnalyticsTotals,
} from '../../../lib/analytics';
import type { Campaign } from '../../../lib/org-api';
import { CampaignAnalytics } from './campaign-analytics';
import { CampaignDetail } from './campaign-detail';
import type { CampaignAudioAsset, CampaignGroup } from './campaign-builder';

let root: Root;
let host: HTMLDivElement;
let urls: string[];
let respond: (url: string) => Response;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function statusCounts(overrides: Partial<AnalyticsStatusCounts> = {}): AnalyticsStatusCounts {
  const counts = Object.fromEntries(ANALYTICS_CALL_STATES.map((state) => [state, 0])) as Record<
    (typeof ANALYTICS_CALL_STATES)[number],
    number
  >;
  return { ...counts, ...overrides };
}

function totals(): AnalyticsTotals {
  return {
    attempts: 2,
    answered: 1,
    statusCounts: statusCounts({ ANSWERED: 1, BUSY: 1 }),
    spend: { amountMinor: '9007199254740993', currency: 'UGX' },
  };
}

function report(
  organizationId: string,
  campaignId: string,
  empty = false,
): {
  readonly detail: AnalyticsCampaignResponse;
  readonly calls: AnalyticsCampaignCallLogsResponse;
} {
  const campaign = {
    ...(empty
      ? {
          ...totals(),
          attempts: 0,
          answered: 0,
          statusCounts: statusCounts(),
          spend: { amountMinor: '0', currency: 'UGX' as const },
        }
      : totals()),
    campaignId,
    name: 'Campaign A',
    status: 'ACTIVE',
    createdAt: '2026-10-01T08:00:00.000Z',
  };
  const reconciliation = { status: 'RECONCILED' as const, usageEvents: 2, ledgerEntries: 2 };
  const filters = { from: null, to: null, campaignIds: [] };
  const detail: AnalyticsCampaignResponse = {
    organizationId,
    campaign,
    reconciliation,
    filters,
  };

  return {
    detail,
    calls: {
      organizationId,
      totals: campaign,
      reconciliation,
      filters,
      page: 1,
      pageSize: 20,
      total: empty ? 0 : 1,
      totalPages: empty ? 0 : 1,
      items: empty
        ? []
        : [
            {
              campaignId,
              attemptId: 'attempt-1',
              state: 'ANSWERED',
              answered: true,
              spend: { amountMinor: '2500', currency: 'UGX' },
            },
          ],
      campaign: {
        campaignId,
        name: 'Campaign A',
        status: 'ACTIVE',
        createdAt: '2026-10-01T08:00:00.000Z',
      },
    },
  };
}

function defaultResponder(
  data: ReturnType<typeof report>,
): (url: string) => Response {
  return (url: string) => {
    if (url.includes('/calls')) return json(data.calls);
    return json(data.detail);
  };
}

async function settle(): Promise<void> {
  await act(async () => {
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 0);
    });
  });
}

async function mountAnalytics(organizationId: string, campaignId: string): Promise<void> {
  await act(async () => {
    root.render(<CampaignAnalytics organizationId={organizationId} campaignId={campaignId} />);
  });
  await settle();
}

function campaign(): Campaign {
  return {
    id: 'campaign-a',
    name: 'Campaign A',
    status: 'DRAFT',
    audioAssetId: null,
    scheduledAt: null,
    retryMaxAttempts: 1,
    retryDelayMinutes: 60,
    audienceGroupIds: [],
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-02T00:00:00.000Z',
  };
}

async function mountDetail(canReadReports: boolean): Promise<void> {
  await act(async () => {
    root.render(
      <CampaignDetail
        organizationId="org-a"
        campaign={campaign()}
        groups={[] as readonly CampaignGroup[]}
        assets={[] as readonly CampaignAudioAsset[]}
        canUpdate={false}
        canDelete={false}
        canPause={false}
        canResume={false}
        canCancel={false}
        canReadReports={canReadReports}
        onEdit={vi.fn()}
        onDeleted={vi.fn()}
        onDispatchChange={vi.fn()}
        onClose={vi.fn()}
      />,
    );
  });
  await settle();
}

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  urls = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: unknown) => {
      const url = String(input);
      urls.push(url);
      return respond(url);
    }),
  );
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('CampaignAnalytics', () => {
  it('uses only the two campaign endpoints and exact API money', async () => {
    respond = defaultResponder(report('org-a', 'campaign a'));

    await mountAnalytics('org-a', 'campaign a');

    expect(urls).toEqual([
      '/api/organizations/org-a/analytics/campaigns/campaign%20a',
      '/api/organizations/org-a/analytics/campaigns/campaign%20a/calls?page=1&pageSize=20',
    ]);
    expect(host.textContent).toContain('UGX 9,007,199,254,740,993');
    expect(host.textContent).toContain('UGX 2,500');
    expect(host.textContent).toContain('attempt-1');
    expect(host.querySelector('[data-testid="analytics-metrics"]')).not.toBeNull();
  });

  it('reports an actual empty campaign result without inventing activity', async () => {
    respond = defaultResponder(report('org-a', 'campaign-a', true));

    await mountAnalytics('org-a', 'campaign-a');

    expect(host.textContent).toContain('No call attempts for this campaign');
    expect(host.textContent).toContain('UGX 0');
    expect(host.querySelector('[data-testid="analytics-metrics"]')).not.toBeNull();
    expect(host.querySelector('[data-analytics-error]')).toBeNull();
  });

  it('clears stale campaign figures when a not-found response arrives', async () => {
    respond = defaultResponder(report('org-a', 'campaign-a'));
    await mountAnalytics('org-a', 'campaign-a');
    expect(host.textContent).toContain('UGX 9,007,199,254,740,993');

    respond = () => json({ error: { code: 'not_found', message: 'Missing.' } }, 404);
    await act(async () => {
      root.render(<CampaignAnalytics organizationId="org-a" campaignId="campaign-b" />);
    });
    await settle();

    expect(host.querySelector('[data-analytics-error="not-found"]')).not.toBeNull();
    expect(host.textContent).toContain('could not be found');
    expect(host.querySelector('[data-testid="analytics-metrics"]')).toBeNull();
    expect(host.textContent).not.toContain('UGX 9,007,199,254,740,993');
  });
});

describe('campaign review reporting gate', () => {
  it('only mounts or requests campaign analytics with reporting access', async () => {
    respond = defaultResponder(report('org-a', 'campaign-a'));

    await mountDetail(false);
    expect(host.querySelector('.campaign-analytics')).toBeNull();
    expect(urls).toEqual([]);

    await mountDetail(true);
    expect(host.querySelector('.campaign-analytics')).not.toBeNull();
    expect(urls).toEqual([
      '/api/organizations/org-a/analytics/campaigns/campaign-a',
      '/api/organizations/org-a/analytics/campaigns/campaign-a/calls?page=1&pageSize=20',
    ]);
  });
});
