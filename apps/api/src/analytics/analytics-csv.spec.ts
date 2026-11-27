import { UGX } from '@truevine/domain';
import { describe, expect, it } from 'vitest';

import { buildAnalyticsReport, type AnalyticsInput } from './analytics-metrics.js';
import { analyticsCsvHeader, serializeAnalyticsCsv } from './analytics-csv.js';

const ORGANIZATION = 'org-w503';
const EXPECTED_HEADER = [
  'organization_id',
  'campaign_id',
  'attempt_id',
  'state',
  'answered',
  'spend_minor',
  'currency',
  'status_answered',
  'status_busy',
  'status_cancelled',
  'status_completed',
  'status_dialing',
  'status_failed',
  'status_no_answer',
  'status_queued',
  'status_ringing',
  'status_timeout',
].join(',');

function csvInput(): AnalyticsInput {
  return {
    organizationId: ORGANIZATION,
    attempts: [
      {
        organizationId: ORGANIZATION,
        campaignId: 'campaign-a',
        attemptId: 'attempt, "1"',
        state: 'COMPLETED',
      },
      {
        organizationId: ORGANIZATION,
        campaignId: 'campaign-a',
        attemptId: 'attempt-2',
        state: 'NO_ANSWER',
      },
    ],
    usageEvents: [
      {
        organizationId: ORGANIZATION,
        usageEventId: 'usage-1',
        attemptId: 'attempt, "1"',
        debitEntryId: 'debit-1',
        customerChargeMinor: 1_000n,
        currency: UGX,
        reversalCreditEntryId: null,
      },
    ],
    ledgerEntries: [
      {
        organizationId: ORGANIZATION,
        entryId: 'debit-1',
        amountMinor: -1_000n,
        currency: UGX,
        link: { kind: 'VOICE_USAGE_DEBIT', usageEventId: 'usage-1' },
      },
    ],
  };
}

describe('serializeAnalyticsCsv', () => {
  it('exports one reconciled call-log row per attempt with exact integer money', () => {
    const csv = serializeAnalyticsCsv(buildAnalyticsReport(csvInput()));

    expect(analyticsCsvHeader()).toBe(EXPECTED_HEADER);
    expect(csv).toBe(
      [
        EXPECTED_HEADER,
        'org-w503,campaign-a,"attempt, ""1""",COMPLETED,true,1000,UGX,0,0,0,1,0,0,0,0,0,0',
        'org-w503,campaign-a,attempt-2,NO_ANSWER,false,0,UGX,0,0,0,0,0,0,1,0,0,0',
        '',
      ].join('\n'),
    );
  });

  it('neutralises spreadsheet formula prefixes before CSV quoting', () => {
    const input: AnalyticsInput = {
      organizationId: ORGANIZATION,
      attempts: [
        {
          organizationId: ORGANIZATION,
          campaignId: 'campaign-a',
          attemptId: '=HYPERLINK("x")',
          state: 'COMPLETED',
        },
      ],
      usageEvents: [],
      ledgerEntries: [],
    };

    expect(serializeAnalyticsCsv(buildAnalyticsReport(input))).toBe(
      [
        EXPECTED_HEADER,
        'org-w503,campaign-a,"\'=HYPERLINK(""x"")",COMPLETED,true,0,UGX,0,0,0,1,0,0,0,0,0,0',
        '',
      ].join('\n'),
    );
  });
});
