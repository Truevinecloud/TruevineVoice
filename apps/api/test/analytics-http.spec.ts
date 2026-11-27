import { randomUUID } from 'node:crypto';

import { UGX } from '@truevine/domain';
import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { serializeAnalyticsCsv } from '../src/analytics/analytics-csv.js';
import type { AnalyticsIntegrationReport } from '../src/analytics/analytics-read-adapter.js';
import type { AnalyticsReader } from '../src/analytics/analytics.service.js';
import {
  buildAnalyticsReport,
  AnalyticsMetricsError,
  type AnalyticsInput,
} from '../src/analytics/analytics-metrics.js';
import {
  createAnalyticsHttpApp,
  seedAnalyticsCaller,
  type AnalyticsHttpHarness,
} from './helpers/analytics-http.js';

const ORGANIZATION = randomUUID();
const OTHER_ORGANIZATION = randomUUID();
const CAMPAIGN = randomUUID();
const ATTEMPT = randomUUID();

function defaultInput(): AnalyticsInput {
  const usageEventId = randomUUID();
  const debitEntryId = randomUUID();
  return {
    organizationId: ORGANIZATION,
    attempts: [
      {
        organizationId: ORGANIZATION,
        campaignId: CAMPAIGN,
        attemptId: ATTEMPT,
        state: 'COMPLETED',
      },
    ],
    usageEvents: [
      {
        organizationId: ORGANIZATION,
        usageEventId,
        attemptId: ATTEMPT,
        debitEntryId,
        customerChargeMinor: 1_234n,
        currency: UGX,
        reversalCreditEntryId: null,
      },
    ],
    ledgerEntries: [
      {
        organizationId: ORGANIZATION,
        entryId: debitEntryId,
        amountMinor: -1_234n,
        currency: UGX,
        link: { kind: 'VOICE_USAGE_DEBIT', usageEventId },
      },
    ],
  };
}

function report(input: AnalyticsInput = defaultInput()): AnalyticsIntegrationReport {
  const built = buildAnalyticsReport(input);
  return {
    ...built,
    campaignMetadata: [
      {
        campaignId: CAMPAIGN,
        name: 'Synthetic campaign',
        status: 'ACTIVE',
        createdAt: new Date('2026-01-01T00:00:00.000Z'),
      },
    ],
    callEvents: [],
    providerCostEvidence: [],
  };
}

function fakeReader(value: AnalyticsIntegrationReport | Error): AnalyticsReader {
  return {
    report: vi.fn(async () => {
      if (value instanceof Error) throw value;
      return value;
    }),
  };
}

describe('W5-03C analytics HTTP access control and contract', () => {
  let harness: AnalyticsHttpHarness | undefined;

  afterEach(async () => {
    await harness?.app.close();
    harness = undefined;
  });

  async function boot(reader: AnalyticsReader): Promise<AnalyticsHttpHarness> {
    harness = await createAnalyticsHttpApp(reader);
    return harness;
  }

  it('rejects an unauthenticated request before reaching the reader', async () => {
    const reader = fakeReader(report());
    const current = await boot(reader);

    const response = await request(current.app.getHttpServer()).get(
      `/organizations/${ORGANIZATION}/analytics/summary`,
    );

    expect(response.status).toBe(401);
    expect(reader.report).not.toHaveBeenCalled();
  });

  it('uses the session organization, never a query-supplied organization', async () => {
    const reader = fakeReader(report());
    const current = await boot(reader);
    const cookie = await seedAnalyticsCaller(current, {
      organizationId: ORGANIZATION,
      userId: randomUUID(),
      email: `owner-${randomUUID()}@example.test`,
    });

    const response = await request(current.app.getHttpServer())
      .get(`/organizations/${ORGANIZATION}/analytics/summary?organizationId=${OTHER_ORGANIZATION}`)
      .set('Cookie', cookie);

    expect(response.status).toBe(200);
    expect(reader.report).toHaveBeenCalledWith(
      ORGANIZATION,
      expect.objectContaining({ campaignIds: [] }),
    );
    expect(response.body).toMatchObject({
      organizationId: ORGANIZATION,
      totals: { attempts: 1, answered: 1, spend: { amountMinor: '1234', currency: 'UGX' } },
    });
    expect(typeof response.body.totals.spend.amountMinor).toBe('string');
  });

  it('rejects a role without reporting:read', async () => {
    const reader = fakeReader(report());
    const current = await boot(reader);
    const cookie = await seedAnalyticsCaller(current, {
      organizationId: ORGANIZATION,
      userId: randomUUID(),
      email: `billing-${randomUUID()}@example.test`,
      role: 'BILLING',
    });

    const response = await request(current.app.getHttpServer())
      .get(`/organizations/${ORGANIZATION}/analytics/summary`)
      .set('Cookie', cookie);

    expect(response.status).toBe(403);
    expect(reader.report).not.toHaveBeenCalled();
    expect(current.audit.actions()).toContain('authorization.denied');
  });

  it('rejects a request for another tenant with an identical 403', async () => {
    const reader = fakeReader(report());
    const current = await boot(reader);
    const cookie = await seedAnalyticsCaller(current, {
      organizationId: ORGANIZATION,
      userId: randomUUID(),
      email: `tenant-${randomUUID()}@example.test`,
    });

    const response = await request(current.app.getHttpServer())
      .get(`/organizations/${OTHER_ORGANIZATION}/analytics/summary`)
      .set('Cookie', cookie);

    expect(response.status).toBe(403);
    expect(reader.report).not.toHaveBeenCalled();
  });

  it('validates filters, campaign IDs and pagination before reading data', async () => {
    const reader = fakeReader(report());
    const current = await boot(reader);
    const cookie = await seedAnalyticsCaller(current, {
      organizationId: ORGANIZATION,
      userId: randomUUID(),
      email: `validator-${randomUUID()}@example.test`,
    });
    const base = `/organizations/${ORGANIZATION}/analytics`;

    for (const query of [
      'summary?from=2026-01-01T00:00:00Z',
      'summary?from=2026-02-01T00:00:00Z&to=2026-01-01T00:00:00Z',
      'summary?campaignIds=not-a-uuid',
      'summary?from=2026-01-01T00:00:00Z&to=2029-01-01T00:00:00Z',
      'calls?page=0',
      'calls?pageSize=101',
      'calls?pageSize=two',
    ]) {
      const response = await request(current.app.getHttpServer())
        .get(`${base}/${query}`)
        .set('Cookie', cookie);
      expect(response.status, query).toBe(400);
      expect(response.body.error.code, query).toBe('invalid_request');
    }
    expect(reader.report).not.toHaveBeenCalled();
  });

  it('maps inconsistent financial evidence to a structured 409', async () => {
    const reader = fakeReader(new AnalyticsMetricsError('LEDGER_MISMATCH', 'Ledger disagrees.'));
    const current = await boot(reader);
    const cookie = await seedAnalyticsCaller(current, {
      organizationId: ORGANIZATION,
      userId: randomUUID(),
      email: `conflict-${randomUUID()}@example.test`,
    });

    const response = await request(current.app.getHttpServer())
      .get(`/organizations/${ORGANIZATION}/analytics/summary`)
      .set('Cookie', cookie);

    expect(response.status).toBe(409);
    expect(response.body).toEqual({
      error: { code: 'LEDGER_MISMATCH', message: 'Ledger disagrees.' },
    });
  });

  it('returns a bounded CSV attachment with formula prefixes neutralised', async () => {
    const input: AnalyticsInput = {
      organizationId: ORGANIZATION,
      attempts: [
        {
          organizationId: ORGANIZATION,
          campaignId: CAMPAIGN,
          attemptId: '=HYPERLINK("x")',
          state: 'COMPLETED',
        },
      ],
      usageEvents: [],
      ledgerEntries: [],
    };
    const current = await boot(fakeReader(report(input)));
    const cookie = await seedAnalyticsCaller(current, {
      organizationId: ORGANIZATION,
      userId: randomUUID(),
      email: `csv-${randomUUID()}@example.test`,
    });

    const response = await request(current.app.getHttpServer())
      .get(`/organizations/${ORGANIZATION}/analytics/calls.csv`)
      .set('Cookie', cookie);

    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toContain('text/csv');
    expect(response.headers['content-disposition']).toBe(
      'attachment; filename="analytics-calls.csv"',
    );
    expect(response.text).toBe(serializeAnalyticsCsv(buildAnalyticsReport(input)));
    expect(response.text).toContain('"\'=HYPERLINK(""x"")"');
  });

  it('returns 404 for a campaign outside the caller organization', async () => {
    const current = await boot(fakeReader(report()));
    const cookie = await seedAnalyticsCaller(current, {
      organizationId: ORGANIZATION,
      userId: randomUUID(),
      email: `campaign-${randomUUID()}@example.test`,
    });

    const response = await request(current.app.getHttpServer())
      .get(`/organizations/${ORGANIZATION}/analytics/campaigns/${OTHER_ORGANIZATION}`)
      .set('Cookie', cookie);

    expect(response.status).toBe(404);
    expect(response.body.error.code).toBe('analytics_campaign_not_found');
  });
});
