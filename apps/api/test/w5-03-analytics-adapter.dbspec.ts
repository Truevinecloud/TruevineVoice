import { randomUUID } from 'node:crypto';

import type { PrismaClient } from '@truevine/database';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { serializeAnalyticsCsv } from '../src/analytics/analytics-csv.js';
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
import { createW503TestDatabaseClient } from './helpers/w5-03-test-database.js';

let db: PrismaClient;
let adapter: PrismaAnalyticsReadAdapter;

beforeAll(async () => {
  db = await createW503TestDatabaseClient();
  adapter = new PrismaAnalyticsReadAdapter(db as unknown as AnalyticsDatabase);
});

afterAll(async () => {
  await db?.$disconnect();
});

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

function serializeForCheck(value: unknown): string {
  return JSON.stringify(value, (_key, item) => (typeof item === 'bigint' ? item.toString() : item));
}

function statusTotal(csv: { header: string[]; rows: string[][] }, column: string): number {
  const index = csv.header.indexOf(column);
  if (index < 0) throw new Error(`Missing CSV column ${column}.`);
  return csv.rows.reduce((total, row) => total + Number(row[index]), 0);
}

function spendTotal(csv: { header: string[]; rows: string[][] }): bigint {
  const index = csv.header.indexOf('spend_minor');
  if (index < 0) throw new Error('Missing CSV column spend_minor.');
  return csv.rows.reduce((total, row) => total + BigInt(row[index] ?? '0'), 0n);
}

describe('W5-03 analytics adapter on isolated PostgreSQL', () => {
  it('reconciles multi-campaign outcomes, exact spend, reversals and CSV totals', async () => {
    const graph = await createW503Graph(db, { campaignName: 'Alpha' });
    const beta = await addCampaign(graph, 'Beta');

    const completed = await createW503Attempt(db, graph, {
      state: 'COMPLETED',
      duplicateFinalEvent: true,
    });
    await createW503Usage(db, graph, completed.attemptId, {
      chargeMinor: 1_000n,
      providerCostMinor: 900n,
    });
    await createW503Attempt(db, graph, { state: 'NO_ANSWER' });
    await createW503Attempt(db, graph, { state: 'FAILED' });
    await createW503Attempt(db, graph, { state: 'QUEUED' });

    const reversed = await createW503Attempt(db, beta, { state: 'COMPLETED' });
    await createW503Usage(db, beta, reversed.attemptId, {
      chargeMinor: 250n,
      providerCostMinor: 300n,
      reversed: true,
    });

    const report = await adapter.report(graph.organizationId);
    expect(report.totals.attempts).toBe(5);
    expect(report.totals.answered).toBe(2);
    expect(report.totals.statusCounts).toMatchObject({
      COMPLETED: 2,
      NO_ANSWER: 1,
      FAILED: 1,
      QUEUED: 1,
    });
    expect(report.totals.spend.amountMinor).toBe(1_000n);
    expect(report.reconciliation).toMatchObject({
      status: 'RECONCILED',
      usageEvents: 2,
      ledgerEntries: 3,
    });

    expect(report.campaignMetadata.map((campaign) => campaign.name).sort()).toEqual([
      'Alpha',
      'Beta',
    ]);
    const betaCampaignId = report.campaignMetadata.find(
      (campaign) => campaign.name === 'Beta',
    )?.campaignId;
    expect(
      report.campaigns.find((campaign) => campaign.campaignId === betaCampaignId)?.spend
        .amountMinor,
    ).toBe(0n);
    expect(report.callEvents.some((event) => event.disposition === 'DUPLICATE')).toBe(true);
    expect(report.callEvents[0]).not.toHaveProperty('providerUsage');
    expect(
      report.providerCostEvidence
        .map((evidence) => evidence.amountMinor)
        .sort((a, b) => (a === null ? -1 : b === null ? 1 : a < b ? -1 : a > b ? 1 : 0)),
    ).toEqual([300n, 900n]);

    const csv = csvRows(serializeAnalyticsCsv(report));
    expect(csv.rows).toHaveLength(5);
    expect(spendTotal(csv)).toBe(1_000n);
    expect(statusTotal(csv, 'status_completed')).toBe(report.totals.statusCounts['COMPLETED']);
    expect(statusTotal(csv, 'status_no_answer')).toBe(report.totals.statusCounts['NO_ANSWER']);
  });

  it('keeps organizations strictly isolated, including campaign filters', async () => {
    const first = await createW503Graph(db);
    const second = await createW503Graph(db);
    const firstAttempt = await createW503Attempt(db, first, { state: 'COMPLETED' });
    await createW503Usage(db, first, firstAttempt.attemptId, { chargeMinor: 400n });
    const secondAttempt = await createW503Attempt(db, second, { state: 'COMPLETED' });
    await createW503Usage(db, second, secondAttempt.attemptId, { chargeMinor: 9_999n });

    const report = await adapter.report(first.organizationId);
    expect(report.campaigns.map((campaign) => campaign.campaignId)).toEqual([first.campaignId]);
    expect(report.callLogs.map((row) => row.campaignId)).toEqual([first.campaignId]);
    expect(report.totals.spend.amountMinor).toBe(400n);
    expect(serializeForCheck(report)).not.toContain(second.organizationId);
    expect(serializeForCheck(report)).not.toContain(second.campaignId);

    const wrongTenantFilter = await adapter.report(first.organizationId, {
      campaignIds: [second.campaignId],
    });
    expect(wrongTenantFilter.totals.attempts).toBe(0);
    expect(wrongTenantFilter.campaigns).toEqual([]);
  });

  it('applies paired date and campaign filters', async () => {
    const graph = await createW503Graph(db);
    const other = await addCampaign(graph, 'Other');
    const inRange = new Date('2026-01-15T00:00:00.000Z');
    const outOfRange = new Date('2026-02-15T00:00:00.000Z');

    const included = await createW503Attempt(db, graph, { state: 'COMPLETED', createdAt: inRange });
    await createW503Usage(db, graph, included.attemptId, {
      chargeMinor: 750n,
      occurredAt: inRange,
    });
    await createW503Attempt(db, graph, { state: 'NO_ANSWER', createdAt: outOfRange });
    await createW503Attempt(db, other, { state: 'COMPLETED', createdAt: inRange });

    const report = await adapter.report(graph.organizationId, {
      from: new Date('2026-01-01T00:00:00.000Z'),
      to: new Date('2026-02-01T00:00:00.000Z'),
      campaignIds: [graph.campaignId],
    });
    expect(report.totals.attempts).toBe(1);
    expect(report.totals.spend.amountMinor).toBe(750n);
    expect(report.campaigns.map((campaign) => campaign.campaignId)).toEqual([graph.campaignId]);

    await expect(
      adapter.report(graph.organizationId, { from: new Date('2026-01-01T00:00:00.000Z') }),
    ).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
    await expect(
      adapter.report(graph.organizationId, { campaignIds: ['not-a-uuid'] }),
    ).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
  });

  it('returns an empty reconciled report for an organization with no analytics records', async () => {
    const graph = await createW503Graph(db);

    const report = await adapter.report(graph.organizationId);
    expect(report.totals.attempts).toBe(0);
    expect(report.totals.answered).toBe(0);
    expect(report.totals.spend.amountMinor).toBe(0n);
    expect(Object.values(report.totals.statusCounts).every((count) => count === 0)).toBe(true);
    expect(report.reconciliation).toMatchObject({
      status: 'RECONCILED',
      usageEvents: 0,
      ledgerEntries: 0,
    });

    const csv = serializeAnalyticsCsv(report);
    expect(csv.trimEnd().split('\n')).toHaveLength(1);
  });

  it('fails closed on inconsistent ledger evidence and duplicate ledger links', async () => {
    const mismatchGraph = await createW503Graph(db);
    const mismatchAttempt = await createW503Attempt(db, mismatchGraph, { state: 'COMPLETED' });
    await createW503Usage(db, mismatchGraph, mismatchAttempt.attemptId, {
      chargeMinor: 1_000n,
      debitAmountOverrideMinor: -999n,
    });
    await expect(adapter.report(mismatchGraph.organizationId)).rejects.toMatchObject({
      code: 'LEDGER_MISMATCH',
    });

    const duplicateGraph = await createW503Graph(db);
    const firstAttempt = await createW503Attempt(db, duplicateGraph, { state: 'COMPLETED' });
    const firstUsage = await createW503Usage(db, duplicateGraph, firstAttempt.attemptId, {
      chargeMinor: 1_000n,
    });
    const secondAttempt = await createW503Attempt(db, duplicateGraph, { state: 'COMPLETED' });
    await createW503Usage(db, duplicateGraph, secondAttempt.attemptId, {
      chargeMinor: 1_000n,
      debitEntryId: firstUsage.debitEntryId,
      reuseExistingDebitEntry: true,
    });
    await expect(adapter.report(duplicateGraph.organizationId)).rejects.toMatchObject({
      code: 'DUPLICATE_RECORD',
    });
  });

  it('stays internally consistent while financial fixtures are written concurrently', async () => {
    const graph = await createW503Graph(db);
    const firstAttempt = await createW503Attempt(db, graph, { state: 'COMPLETED' });
    await createW503Usage(db, graph, firstAttempt.attemptId, { chargeMinor: 250n });
    const secondAttempt = await createW503Attempt(db, graph, { state: 'COMPLETED' });

    const [report] = await Promise.all([
      adapter.report(graph.organizationId),
      createW503Usage(db, graph, secondAttempt.attemptId, { chargeMinor: 500n }),
    ]);

    expect([250n, 750n]).toContain(report.totals.spend.amountMinor);
    const csv = csvRows(serializeAnalyticsCsv(report));
    expect(spendTotal(csv)).toBe(report.totals.spend.amountMinor);
    expect(report.reconciliation.status).toBe('RECONCILED');
  });
});
