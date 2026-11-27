import { UGX, money, type CallState } from '@truevine/domain';
import { describe, expect, it } from 'vitest';

import {
  AnalyticsMetricsError,
  buildAnalyticsReport,
  type AnalyticsCallAttemptRecord,
  type AnalyticsErrorCode,
  type AnalyticsInput,
  type AnalyticsLedgerEntryRecord,
  type AnalyticsVoiceUsageEventRecord,
} from './analytics-metrics.js';

const ORGANIZATION = 'org-w503';

function attempt(
  attemptId: string,
  campaignId: string,
  state: CallState,
): AnalyticsCallAttemptRecord {
  return { organizationId: ORGANIZATION, attemptId, campaignId, state };
}

function usage(
  usageEventId: string,
  attemptId: string,
  debitEntryId: string,
  customerChargeMinor: bigint,
  reversalCreditEntryId: string | null = null,
): AnalyticsVoiceUsageEventRecord {
  return {
    organizationId: ORGANIZATION,
    usageEventId,
    attemptId,
    debitEntryId,
    customerChargeMinor,
    currency: UGX,
    reversalCreditEntryId,
  };
}

function debit(
  entryId: string,
  usageEventId: string,
  amountMinor: bigint,
): AnalyticsLedgerEntryRecord {
  return {
    organizationId: ORGANIZATION,
    entryId,
    amountMinor,
    currency: UGX,
    link: { kind: 'VOICE_USAGE_DEBIT', usageEventId },
  };
}

function credit(
  entryId: string,
  usageEventId: string,
  amountMinor: bigint,
): AnalyticsLedgerEntryRecord {
  return {
    organizationId: ORGANIZATION,
    entryId,
    amountMinor,
    currency: UGX,
    link: { kind: 'VOICE_USAGE_REVERSAL_CREDIT', usageEventId },
  };
}

function baseInput(): AnalyticsInput {
  return {
    organizationId: ORGANIZATION,
    attempts: [
      attempt('attempt-1', 'campaign-a', 'COMPLETED'),
      attempt('attempt-2', 'campaign-a', 'NO_ANSWER'),
      attempt('attempt-3', 'campaign-b', 'ANSWERED'),
    ],
    usageEvents: [
      usage('usage-1', 'attempt-1', 'debit-1', 1_000n),
      usage('usage-2', 'attempt-3', 'debit-2', 250n, 'credit-2'),
    ],
    ledgerEntries: [
      debit('debit-1', 'usage-1', -1_000n),
      debit('debit-2', 'usage-2', -250n),
      credit('credit-2', 'usage-2', 250n),
      {
        organizationId: ORGANIZATION,
        entryId: 'top-up-credit',
        amountMinor: 5_000n,
        currency: UGX,
        link: null,
      },
    ],
  };
}

function expectAnalyticsError(code: AnalyticsErrorCode, operation: () => unknown): void {
  expect(operation).toThrowError(AnalyticsMetricsError);
  try {
    operation();
  } catch (error) {
    expect(error).toBeInstanceOf(AnalyticsMetricsError);
    expect((error as AnalyticsMetricsError).code).toBe(code);
  }
}

describe('buildAnalyticsReport', () => {
  it('reconciles answer/status/spend metrics against attempts and the ledger', () => {
    const report = buildAnalyticsReport(baseInput());

    expect(report.organizationId).toBe(ORGANIZATION);
    expect(report.totals.attempts).toBe(3);
    expect(report.totals.answered).toBe(2);
    expect(report.totals.spend).toEqual(money(1_000n, UGX));
    expect(report.totals.statusCounts).toMatchObject({
      ANSWERED: 1,
      COMPLETED: 1,
      NO_ANSWER: 1,
      BUSY: 0,
    });
    expect(Object.values(report.totals.statusCounts).reduce((a, b) => a + b, 0)).toBe(3);

    expect(report.campaigns.map((campaign) => campaign.campaignId)).toEqual([
      'campaign-a',
      'campaign-b',
    ]);
    expect(report.campaigns[0]?.attempts).toBe(2);
    expect(report.campaigns[0]?.answered).toBe(1);
    expect(report.campaigns[0]?.spend).toEqual(money(1_000n, UGX));
    expect(report.campaigns[1]?.attempts).toBe(1);
    expect(report.campaigns[1]?.spend).toEqual(money(0n, UGX));

    expect(report.callLogs).toHaveLength(3);
    expect(report.callLogs[0]).toMatchObject({
      campaignId: 'campaign-a',
      attemptId: 'attempt-1',
      state: 'COMPLETED',
      answered: true,
      spend: money(1_000n, UGX),
    });
    expect(report.callLogs[2]?.spend).toEqual(money(0n, UGX));

    expect(report.reconciliation).toEqual({
      status: 'RECONCILED',
      usageEvents: 2,
      ledgerEntries: 3,
    });
  });

  it('excludes a reversed charge while proving the debit and compensating credit', () => {
    const report = buildAnalyticsReport(baseInput());
    const reversedCall = report.callLogs.find((row) => row.attemptId === 'attempt-3');

    expect(reversedCall?.spend).toEqual(money(0n, UGX));
    expect(report.campaigns.find((row) => row.campaignId === 'campaign-b')?.spend).toEqual(
      money(0n, UGX),
    );
    expect(report.totals.spend).toEqual(money(1_000n, UGX));
  });

  it('refuses a record from another organization', () => {
    const input = baseInput();
    const attempts = [...input.attempts];
    attempts[0] = { ...attempts[0]!, organizationId: 'org-other' };

    expectAnalyticsError('TENANT_MISMATCH', () => buildAnalyticsReport({ ...input, attempts }));
  });

  it('refuses duplicate call attempts and duplicate voice usage events', () => {
    const input = baseInput();

    expectAnalyticsError('DUPLICATE_RECORD', () =>
      buildAnalyticsReport({ ...input, attempts: [...input.attempts, input.attempts[0]!] }),
    );
    expectAnalyticsError('DUPLICATE_RECORD', () =>
      buildAnalyticsReport({ ...input, usageEvents: [...input.usageEvents, input.usageEvents[0]!] }),
    );
  });

  it('refuses usage evidence that has no call attempt', () => {
    const input = baseInput();
    const usageEvents = input.usageEvents.map((event) =>
      event.usageEventId === 'usage-1' ? { ...event, attemptId: 'missing' } : event,
    );

    expectAnalyticsError('ORPHAN_USAGE_EVENT', () =>
      buildAnalyticsReport({ ...input, usageEvents }),
    );
  });

  it('refuses a charge that does not match its wallet debit', () => {
    const input = baseInput();
    const ledgerEntries = input.ledgerEntries.map((entry) =>
      entry.entryId === 'debit-1' ? { ...entry, amountMinor: -999n } : entry,
    );

    expectAnalyticsError('LEDGER_MISMATCH', () =>
      buildAnalyticsReport({ ...input, ledgerEntries }),
    );
  });

  it('refuses an unreversed charge with an unexplained wallet reversal credit', () => {
    const input = baseInput();

    expectAnalyticsError('LEDGER_MISMATCH', () =>
      buildAnalyticsReport({
        ...input,
        ledgerEntries: [...input.ledgerEntries, credit('credit-1', 'usage-1', 1_000n)],
      }),
    );
  });

  it('refuses mixed currency and unknown call states', () => {
    const input = baseInput();
    const usageEvents = input.usageEvents.map((event) =>
      event.usageEventId === 'usage-1' ? { ...event, currency: 'USD' } : event,
    );
    const attempts = input.attempts.map((row, index) =>
      index === 0 ? { ...row, state: 'UNKNOWN' as CallState } : row,
    );

    expectAnalyticsError('CURRENCY_MISMATCH', () =>
      buildAnalyticsReport({ ...input, usageEvents }),
    );
    expectAnalyticsError('UNKNOWN_CALL_STATE', () =>
      buildAnalyticsReport({ ...input, attempts }),
    );
  });
});
