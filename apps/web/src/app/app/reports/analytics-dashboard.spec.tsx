// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  ANALYTICS_CALL_STATES,
  type AnalyticsCallLogsResponse,
  type AnalyticsCampaign,
  type AnalyticsCampaignsResponse,
  type AnalyticsStatusCounts,
  type AnalyticsSummaryResponse,
  type AnalyticsTotals,
} from '../../../lib/analytics';
import { AnalyticsDashboard } from './analytics-dashboard';

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

function error(status: number, code: string): Response {
  return json({ error: { code, message: 'Synthetic failure.' } }, status);
}

function statusCounts(overrides: Partial<AnalyticsStatusCounts> = {}): AnalyticsStatusCounts {
  const counts = Object.fromEntries(ANALYTICS_CALL_STATES.map((state) => [state, 0])) as Record<
    (typeof ANALYTICS_CALL_STATES)[number],
    number
  >;
  return { ...counts, ...overrides };
}

function totals(amountMinor: string, overrides: Partial<AnalyticsTotals> = {}): AnalyticsTotals {
  return {
    attempts: 3,
    answered: 2,
    statusCounts: statusCounts({ ANSWERED: 1, COMPLETED: 1, BUSY: 1 }),
    spend: { amountMinor, currency: 'UGX' },
    ...overrides,
  };
}

function report(organizationId: string): {
  readonly summary: AnalyticsSummaryResponse;
  readonly campaigns: AnalyticsCampaignsResponse;
  readonly calls: AnalyticsCallLogsResponse;
} {
  const summaryTotals = totals('9007199254740993');
  const campaign: AnalyticsCampaign = {
    ...totals('2500', {
      attempts: 2,
      answered: 1,
      statusCounts: statusCounts({ ANSWERED: 1, BUSY: 1 }),
    }),
    campaignId: 'campaign-a',
    name: 'Campaign A',
    status: 'ACTIVE',
    createdAt: '2026-10-01T08:00:00.000Z',
  };
  const summary: AnalyticsSummaryResponse = {
    organizationId,
    totals: summaryTotals,
    reconciliation: { status: 'RECONCILED', usageEvents: 3, ledgerEntries: 3 },
    filters: { from: null, to: null, campaignIds: [] },
  };

  return {
    summary,
    campaigns: { ...summary, campaigns: [campaign] },
    calls: {
      ...summary,
      page: 1,
      pageSize: 20,
      total: 1,
      totalPages: 1,
      items: [
        {
          campaignId: 'campaign-a',
          attemptId: 'attempt-1',
          state: 'COMPLETED',
          answered: true,
          spend: { amountMinor: '2500', currency: 'UGX' },
        },
      ],
    },
  };
}

function emptyReport(organizationId: string): {
  readonly summary: AnalyticsSummaryResponse;
  readonly campaigns: AnalyticsCampaignsResponse;
  readonly calls: AnalyticsCallLogsResponse;
} {
  const summary: AnalyticsSummaryResponse = {
    organizationId,
    totals: totals('0', {
      attempts: 0,
      answered: 0,
      statusCounts: statusCounts(),
    }),
    reconciliation: { status: 'RECONCILED', usageEvents: 0, ledgerEntries: 0 },
    filters: { from: null, to: null, campaignIds: [] },
  };

  return {
    summary,
    campaigns: { ...summary, campaigns: [] },
    calls: { ...summary, page: 1, pageSize: 20, total: 0, totalPages: 0, items: [] },
  };
}

function installFetch(): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: unknown) => {
      const url = String(input);
      urls.push(url);
      return respond(url);
    }),
  );
}

function defaultResponder(data: ReturnType<typeof report>): (url: string) => Response {
  return (url: string) => {
    if (url.includes('/analytics/calls.csv')) {
      return new Response('organization_id,attempt_id\norg-a,attempt-1\n', {
        status: 200,
        headers: { 'content-type': 'text/csv' },
      });
    }
    if (url.includes('/analytics/summary')) return json(data.summary);
    if (url.includes('/analytics/campaigns')) return json(data.campaigns);
    if (url.includes('/analytics/calls')) return json(data.calls);
    throw new Error(`Unexpected URL: ${url}`);
  };
}

async function settle(): Promise<void> {
  await act(async () => {
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 0);
    });
  });
}

async function mount(organizationId: string): Promise<void> {
  await act(async () => {
    root.render(<AnalyticsDashboard organizationId={organizationId} />);
  });
  await settle();
}

function button(label: string): HTMLButtonElement {
  const element = [...host.querySelectorAll('button')].find(
    (entry) => entry.textContent?.trim() === label,
  );
  if (!element) throw new Error(`Missing button: ${label}`);
  return element;
}

async function click(label: string): Promise<void> {
  await act(async () => {
    button(label).click();
  });
}

async function fillInput(index: number, value: string): Promise<void> {
  await act(async () => {
    const input = host.querySelectorAll('input')[index]!;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

async function selectCampaign(campaignId: string): Promise<void> {
  await act(async () => {
    const select = host.querySelector('select')!;
    for (const option of [...select.options]) option.selected = option.value === campaignId;
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
}

function paramsFor(url: string): URLSearchParams {
  const query = url.slice(url.indexOf('?'));
  return new URLSearchParams(query);
}

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  urls = [];
  installFetch();
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('AnalyticsDashboard', () => {
  it('renders only organization-scoped API values, with exact minor-unit money', async () => {
    respond = defaultResponder(report('org-a'));

    await mount('org a');

    expect(urls).toContain('/api/organizations/org%20a/analytics/summary');
    expect(urls).toContain('/api/organizations/org%20a/analytics/campaigns');
    expect(urls).toContain(
      '/api/organizations/org%20a/analytics/calls?page=1&pageSize=20',
    );
    expect(urls.every((url) => !url.includes('organizationId='))).toBe(true);
    expect(host.textContent).toContain('UGX 9,007,199,254,740,993');
    expect(host.textContent).toContain('UGX 2,500');
    expect(host.textContent).toContain('Campaign A');
    expect(host.textContent).toContain('Completed');
    expect(host.textContent).toContain('attempt-1');
    expect(host.textContent).not.toContain('Timestamp');
    expect(host.querySelector('[data-testid="analytics-metrics"]')).not.toBeNull();
  });

  it('applies filters to every report request and exports the same applied filters', async () => {
    respond = defaultResponder(report('org-a'));
    await mount('org-a');

    await fillInput(0, '2026-01-01T08:00');
    await fillInput(1, '2026-01-02T08:00');
    await selectCampaign('campaign-a');
    urls = [];
    await click('Apply filters');
    await settle();

    const filtered = urls.filter((url) => !url.includes('calls.csv'));
    expect(filtered).toHaveLength(3);
    for (const url of filtered) {
      const params = paramsFor(url);
      expect(params.get('from')).not.toBeNull();
      expect(params.get('to')).not.toBeNull();
      expect(params.getAll('campaignIds')).toEqual(['campaign-a']);
    }

    const createObjectURL = vi.fn(() => 'blob:analytics');
    const revokeObjectURL = vi.fn();
    class StubURL extends URL {
      static createObjectURL = createObjectURL;
      static revokeObjectURL = revokeObjectURL;
    }
    vi.stubGlobal('URL', StubURL);
    const downloadClick = vi
      .spyOn(HTMLAnchorElement.prototype, 'click')
      .mockImplementation(() => undefined);
    urls = [];

    await click('Download CSV');
    await settle();

    const csvUrl = urls.find((url) => url.includes('/analytics/calls.csv'));
    expect(csvUrl).toBeDefined();
    const csvParams = paramsFor(csvUrl!);
    expect(csvParams.get('from')).not.toBeNull();
    expect(csvParams.get('to')).not.toBeNull();
    expect(csvParams.getAll('campaignIds')).toEqual(['campaign-a']);
    expect(downloadClick).toHaveBeenCalledOnce();
  });

  it('shows an actual empty result without substituting failure figures', async () => {
    respond = defaultResponder(emptyReport('org-a'));

    await mount('org-a');

    expect(host.textContent).toContain('No call attempts yet');
    expect(host.textContent).toContain('No campaigns to report');
    expect(host.querySelector('[data-testid="analytics-metrics"]')).toBeNull();
    expect(host.querySelector('[data-analytics-error]')).toBeNull();
  });

  it('clears stale figures when a new organization fails reconciliation', async () => {
    respond = defaultResponder(report('org-a'));
    await mount('org-a');
    expect(host.textContent).toContain('UGX 9,007,199,254,740,993');

    respond = () => error(409, 'LEDGER_MISMATCH');
    await act(async () => {
      root.render(<AnalyticsDashboard organizationId="org-b" />);
    });
    await settle();

    expect(host.querySelector('[data-analytics-error="conflict"]')).not.toBeNull();
    expect(host.textContent).toContain('could not be reconciled');
    expect(host.querySelector('[data-testid="analytics-metrics"]')).toBeNull();
    expect(host.textContent).not.toContain('UGX 9,007,199,254,740,993');
  });
});
