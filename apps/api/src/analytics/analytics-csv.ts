import { ANALYTICS_CALL_STATES, type AnalyticsReport } from './analytics-metrics.js';

/**
 * W5-03 CSV export serializer.
 *
 * One row per call attempt, with one column per call state so campaign and
 * organization totals can be reproduced by summing the exported rows. Money is
 * emitted as the exact decimal minor-unit string; no numeric conversion occurs.
 */

const HEADER_COLUMNS: readonly string[] = [
  'organization_id',
  'campaign_id',
  'attempt_id',
  'state',
  'answered',
  'spend_minor',
  'currency',
  ...ANALYTICS_CALL_STATES.map((state) => `status_${state.toLowerCase()}`),
];

const FORMULA_PREFIX = /^\s*[=+\-@]/;

/**
 * Spreadsheet programs execute cells beginning with these characters. Quoting
 * alone does not stop that, so a literal apostrophe is prepended before the
 * normal CSV quoting rules are applied.
 */
function csvCell(value: string): string {
  const safe = FORMULA_PREFIX.test(value) ? `'${value}` : value;
  return /[",\r\n]/.test(safe) ? `"${safe.replaceAll('"', '""')}"` : safe;
}

export function analyticsCsvHeader(): string {
  return HEADER_COLUMNS.join(',');
}

export function serializeAnalyticsCsv(report: AnalyticsReport): string {
  const lines = [analyticsCsvHeader()];

  const rows = [...report.callLogs].sort(
    (a, b) =>
      (a.campaignId < b.campaignId ? -1 : a.campaignId > b.campaignId ? 1 : 0) ||
      (a.attemptId < b.attemptId ? -1 : a.attemptId > b.attemptId ? 1 : 0),
  );

  for (const row of rows) {
    const cells = [
      report.organizationId,
      row.campaignId,
      row.attemptId,
      row.state,
      row.answered ? 'true' : 'false',
      row.spend.amountMinor.toString(),
      row.spend.currency,
      ...ANALYTICS_CALL_STATES.map((state) => (row.state === state ? '1' : '0')),
    ];
    lines.push(cells.map(csvCell).join(','));
  }

  return `${lines.join('\n')}\n`;
}
