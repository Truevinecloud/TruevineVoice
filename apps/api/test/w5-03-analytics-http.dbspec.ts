import { randomUUID } from 'node:crypto';

import type { PrismaClient } from '@truevine/database';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import {
  PrismaAnalyticsReadAdapter,
  type AnalyticsDatabase,
} from '../src/analytics/analytics-read-adapter.js';
import {
  createW503Attempt,
  createW503Graph,
  createW503Usage,
  type W503FixtureGraph,
} from './helpers/w5-03-fixtures.js';
import {
  createAnalyticsHttpApp,
  seedAnalyticsCaller,
  type AnalyticsHttpHarness,
} from './helpers/analytics-http.js';
import { createW503TestDatabaseClient } from './helpers/w5-03-test-database.js';

let db: PrismaClient;
let adapter: PrismaAnalyticsReadAdapter;
let harness: AnalyticsHttpHarness | undefined;

beforeAll(async () => {
  db = await createW503TestDatabaseClient();
  adapter = new PrismaAnalyticsReadAdapter(db as unknown as AnalyticsDatabase);
});

afterEach(async () => {
  await harness?.app.close();
  harness = undefined;
});

afterAll(async () => {
  await db?.$disconnect();
});

async function boot(): Promise<void> {
  harness = await createAnalyticsHttpApp(adapter);
}

function http() {
  return request(harness!.app.getHttpServer());
}

async function authorize(current: AnalyticsHttpHarness, graph: W503FixtureGraph): Promise<string> {
  return seedAnalyticsCaller(current, {
    organizationId: graph.organizationId,
    userId: graph.userId,
    email: `http-${graph.userId}@example.test`,
  });
}

async function addCampaign(graph: W503FixtureGraph, name: string): Promise<W503FixtureGraph> {
  const campaign = await db.campaign.create({
    data: {
      organizationId: graph.organizationId,
      id: randomUUID(),
      name,
      status: 'ACTIVE',
      createdById: graph.userId,
    },
  });
  const execution = await db.campaignExecution.create({
    data: { organizationId: graph.organizationId, id: randomUUID(), campaignId: campaign.id },
  });
  return { ...graph, campaignId: campaign.id, executionId: execution.id, campaignName: name };
}

function csvRows(csv: string): { header: string[]; rows: string[][] } {
  const lines = csv.trimEnd().split('\n');
  return {
    header: lines[0]?.split(',') ?? [],
    rows: lines.slice(1).map((line) => line.split(',')),
  };
}

function csvTotal(csv: { header: string[]; rows: string[][] }, column: string): bigint {
  const index = csv.header.indexOf(column);
  if (index < 0) throw new Error(`Missing CSV column ${column}.`);
  return csv.rows.reduce((total, row) => total + BigInt(row[index] ?? '0'), 0n);
}

describe('W5-03C analytics HTTP over isolated PostgreSQL', () => {
  it('serves authenticated totals that reconcile with attempts, ledger spend and CSV', async () => {
    const graph = await createW503Graph(db, { campaignName: 'Alpha' });
    const beta = await addCampaign(graph, 'Beta');
    await boot();
    const cookie = await authorize(harness!, graph);

    const completed = await createW503Attempt(db, graph, {
      state: 'COMPLETED',
      duplicateFinalEvent: true,
    });
    await createW503Usage(db, graph, completed.attemptId, {
      chargeMinor: 1_000n,
      providerCostMinor: 77n,
    });
    await createW503Attempt(db, graph, { state: 'NO_ANSWER' });
    await createW503Attempt(db, graph, { state: 'FAILED' });
    await createW503Attempt(db, graph, { state: 'QUEUED' });
    const reversed = await createW503Attempt(db, beta, { state: 'COMPLETED' });
    await createW503Usage(db, beta, reversed.attemptId, {
      chargeMinor: 250n,
      providerCostMinor: 999n,
      reversed: true,
    });

    const summary = await http()
      .get(`/organizations/${graph.organizationId}/analytics/summary`)
      .set('Cookie', cookie);
    expect(summary.status).toBe(200);
    expect(summary.body.totals).toMatchObject({
      attempts: 5,
      answered: 2,
      spend: { amountMinor: '1000', currency: 'UGX' },
      statusCounts: { COMPLETED: 2, NO_ANSWER: 1, FAILED: 1, QUEUED: 1 },
    });
    expect(summary.body.reconciliation).toMatchObject({
      status: 'RECONCILED',
      usageEvents: 2,
      ledgerEntries: 3,
    });

    const campaigns = await http()
      .get(`/organizations/${graph.organizationId}/analytics/campaigns`)
      .set('Cookie', cookie);
    expect(campaigns.status).toBe(200);
    const betaSummary = campaigns.body.campaigns.find(
      (campaign: { campaignId: string }) => campaign.campaignId === beta.campaignId,
    );
    expect(betaSummary).toMatchObject({
      name: 'Beta',
      attempts: 1,
      answered: 1,
      spend: { amountMinor: '0', currency: 'UGX' },
    });

    const campaign = await http()
      .get(`/organizations/${graph.organizationId}/analytics/campaigns/${graph.campaignId}`)
      .set('Cookie', cookie);
    expect(campaign.status).toBe(200);
    expect(campaign.body.campaign).toMatchObject({
      campaignId: graph.campaignId,
      attempts: 4,
      answered: 1,
      spend: { amountMinor: '1000', currency: 'UGX' },
    });

    const calls = await http()
      .get(`/organizations/${graph.organizationId}/analytics/calls?page=1&pageSize=2`)
      .set('Cookie', cookie);
    expect(calls.status).toBe(200);
    expect(calls.body).toMatchObject({ page: 1, pageSize: 2, total: 5, totalPages: 3 });
    expect(calls.body.items).toHaveLength(2);
    expect(calls.body.totals.spend.amountMinor).toBe('1000');

    const csv = await http()
      .get(`/organizations/${graph.organizationId}/analytics/calls.csv`)
      .set('Cookie', cookie);
    expect(csv.status).toBe(200);
    expect(csv.headers['content-type']).toContain('text/csv');
    expect(csv.headers['content-disposition']).toBe('attachment; filename="analytics-calls.csv"');
    const parsed = csvRows(csv.text);
    expect(parsed.rows).toHaveLength(5);
    expect(csvTotal(parsed, 'spend_minor')).toBe(1_000n);
    expect(csvTotal(parsed, 'status_completed')).toBe(2n);
  });

  it('applies pagination and paired date/campaign filters without leaking other tenants', async () => {
    const graph = await createW503Graph(db, { campaignName: 'Included' });
    const otherCampaign = await addCampaign(graph, 'Excluded');
    await boot();
    const cookie = await authorize(harness!, graph);
    const january = new Date('2026-01-15T00:00:00.000Z');
    const february = new Date('2026-02-15T00:00:00.000Z');

    await createW503Attempt(db, graph, { state: 'COMPLETED', createdAt: january });
    await createW503Attempt(db, graph, { state: 'NO_ANSWER', createdAt: january });
    await createW503Attempt(db, graph, { state: 'FAILED', createdAt: february });
    await createW503Attempt(db, otherCampaign, { state: 'COMPLETED', createdAt: january });

    const page = await http()
      .get(`/organizations/${graph.organizationId}/analytics/calls?page=2&pageSize=2`)
      .set('Cookie', cookie);
    expect(page.status).toBe(200);
    expect(page.body).toMatchObject({ page: 2, pageSize: 2, total: 4, totalPages: 2 });
    expect(page.body.items).toHaveLength(2);

    const filtered = await http()
      .get(
        `/organizations/${graph.organizationId}/analytics/calls` +
          `?from=2026-01-01T00:00:00Z&to=2026-02-01T00:00:00Z` +
          `&campaignIds=${graph.campaignId}`,
      )
      .set('Cookie', cookie);
    expect(filtered.status).toBe(200);
    expect(filtered.body.total).toBe(2);
    expect(filtered.body.filters).toEqual({
      from: '2026-01-01T00:00:00.000Z',
      to: '2026-02-01T00:00:00.000Z',
      campaignIds: [graph.campaignId],
    });
    expect(
      filtered.body.items.every(
        (row: { campaignId: string }) => row.campaignId === graph.campaignId,
      ),
    ).toBe(true);
  });

  it('returns a valid empty response for an organization with no analytics records', async () => {
    const graph = await createW503Graph(db);
    await boot();
    const cookie = await authorize(harness!, graph);

    const summary = await http()
      .get(`/organizations/${graph.organizationId}/analytics/summary`)
      .set('Cookie', cookie);
    expect(summary.status).toBe(200);
    expect(summary.body.totals).toMatchObject({
      attempts: 0,
      answered: 0,
      spend: { amountMinor: '0', currency: 'UGX' },
    });

    const calls = await http()
      .get(`/organizations/${graph.organizationId}/analytics/calls`)
      .set('Cookie', cookie);
    expect(calls.status).toBe(200);
    expect(calls.body).toMatchObject({ total: 0, totalPages: 0, items: [] });

    const csv = await http()
      .get(`/organizations/${graph.organizationId}/analytics/calls.csv`)
      .set('Cookie', cookie);
    expect(csv.status).toBe(200);
    expect(csv.text.trimEnd().split('\n')).toHaveLength(1);
  });

  it('rejects cross-tenant organization access and hides another tenant campaign', async () => {
    const owned = await createW503Graph(db);
    const other = await createW503Graph(db);
    await boot();
    const cookie = await authorize(harness!, owned);

    const forbidden = await http()
      .get(`/organizations/${other.organizationId}/analytics/summary`)
      .set('Cookie', cookie);
    expect(forbidden.status).toBe(403);

    const campaign = await http()
      .get(`/organizations/${owned.organizationId}/analytics/campaigns/${other.campaignId}`)
      .set('Cookie', cookie);
    expect(campaign.status).toBe(404);
    expect(campaign.body.error.code).toBe('analytics_campaign_not_found');

    const filtered = await http()
      .get(
        `/organizations/${owned.organizationId}/analytics/summary?campaignIds=${other.campaignId}`,
      )
      .set('Cookie', cookie);
    expect(filtered.status).toBe(200);
    expect(filtered.body.totals.attempts).toBe(0);
    expect(filtered.body.totals.spend.amountMinor).toBe('0');
    // The only occurrence of the foreign id is the caller's own echoed filter;
    // no campaign metadata, call log or total from that tenant is returned.
    expect(Object.keys(filtered.body)).not.toContain('campaigns');
    expect(Object.keys(filtered.body)).not.toContain('items');
  });

  it('returns a structured 409 when immutable usage and ledger evidence disagree', async () => {
    const graph = await createW503Graph(db);
    await boot();
    const cookie = await authorize(harness!, graph);
    const attempt = await createW503Attempt(db, graph, { state: 'COMPLETED' });
    await createW503Usage(db, graph, attempt.attemptId, {
      chargeMinor: 1_000n,
      debitAmountOverrideMinor: -999n,
    });

    const response = await http()
      .get(`/organizations/${graph.organizationId}/analytics/summary`)
      .set('Cookie', cookie);

    expect(response.status).toBe(409);
    expect(response.body).toEqual({
      error: { code: 'LEDGER_MISMATCH', message: 'Voice usage charge and wallet debit disagree.' },
    });
  });
});
