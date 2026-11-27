import { CALL_TRANSITIONS, UGX, money, type CallState, type Money } from '@truevine/domain';

/**
 * W5-03 read-only analytics metrics.
 *
 * This is an unwired, pure calculation boundary. It does not query PostgreSQL,
 * expose HTTP, render a dashboard or mutate a ledger. A future adapter must
 * supply organization-scoped read models from the call-attempt and append-only
 * wallet/usage tables. The organization is an explicit argument so a caller
 * cannot accidentally combine two tenants in one report.
 *
 * Spend is customer money actually debited by voice usage and not later
 * reversed. Provider-reported amount/cost is never an input.
 */

export type AnalyticsErrorCode =
  | 'INVALID_REQUEST'
  | 'TENANT_MISMATCH'
  | 'DUPLICATE_RECORD'
  | 'ORPHAN_USAGE_EVENT'
  | 'LEDGER_MISMATCH'
  | 'CURRENCY_MISMATCH'
  | 'UNKNOWN_CALL_STATE';

export class AnalyticsMetricsError extends Error {
  readonly code: AnalyticsErrorCode;

  constructor(code: AnalyticsErrorCode, message: string) {
    super(message);
    this.name = 'AnalyticsMetricsError';
    this.code = code;
  }
}

export interface AnalyticsCallAttemptRecord {
  readonly organizationId: string;
  readonly campaignId: string;
  readonly attemptId: string;
  readonly state: CallState;
}

export interface AnalyticsVoiceUsageEventRecord {
  readonly organizationId: string;
  readonly usageEventId: string;
  readonly attemptId: string;
  readonly debitEntryId: string;
  readonly customerChargeMinor: bigint;
  readonly currency: string;
  /** Present only when an immutable VoiceUsageReversal has credited the customer. */
  readonly reversalCreditEntryId: string | null;
}

export type AnalyticsLedgerLink =
  | {
      readonly kind: 'VOICE_USAGE_DEBIT';
      readonly usageEventId: string;
    }
  | {
      readonly kind: 'VOICE_USAGE_REVERSAL_CREDIT';
      readonly usageEventId: string;
    };

export interface AnalyticsLedgerEntryRecord {
  readonly organizationId: string;
  readonly entryId: string;
  readonly amountMinor: bigint;
  readonly currency: string;
  /** Null for unrelated entries such as top-up credits; those are not spend. */
  readonly link: AnalyticsLedgerLink | null;
}

export interface AnalyticsInput {
  readonly organizationId: string;
  readonly attempts: readonly AnalyticsCallAttemptRecord[];
  readonly usageEvents: readonly AnalyticsVoiceUsageEventRecord[];
  readonly ledgerEntries: readonly AnalyticsLedgerEntryRecord[];
}

export interface AnalyticsMetricsSummary {
  readonly attempts: number;
  readonly answered: number;
  readonly statusCounts: Readonly<Record<CallState, number>>;
  readonly spend: Money;
}

export interface AnalyticsCampaignSummary extends AnalyticsMetricsSummary {
  readonly campaignId: string;
}

export interface AnalyticsCallLogRow {
  readonly campaignId: string;
  readonly attemptId: string;
  readonly state: CallState;
  readonly answered: boolean;
  readonly spend: Money;
}

export interface AnalyticsReport {
  readonly organizationId: string;
  readonly totals: AnalyticsMetricsSummary;
  readonly campaigns: readonly AnalyticsCampaignSummary[];
  readonly callLogs: readonly AnalyticsCallLogRow[];
  readonly reconciliation: {
    readonly status: 'RECONCILED';
    readonly usageEvents: number;
    readonly ledgerEntries: number;
  };
}

interface ValidatedAttempt {
  readonly campaignId: string;
  readonly state: CallState;
}

interface ResolvedUsage {
  readonly campaignId: string;
  readonly charge: Money;
  readonly reversed: boolean;
}

interface LinkedLedgerEntry {
  readonly entryId: string;
  readonly amountMinor: bigint;
}

interface MutableSummary {
  attempts: number;
  answered: number;
  statusCounts: Record<CallState, number>;
  spendMinor: bigint;
}

/** Deterministic CSV/status column order, independent of object insertion order. */
export const ANALYTICS_CALL_STATES: readonly CallState[] = Object.freeze(
  (Object.keys(CALL_TRANSITIONS) as CallState[]).sort(),
);

function fail(code: AnalyticsErrorCode, message: string): never {
  throw new AnalyticsMetricsError(code, message);
}

function requiredIdentifier(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    fail('INVALID_REQUEST', `${label} must be a non-empty string.`);
  }
  return value;
}

function assertOrganization(value: unknown, expected: string, label: string): void {
  const organizationId = requiredIdentifier(value, `${label}.organizationId`);
  if (organizationId !== expected) {
    fail('TENANT_MISMATCH', `${label} belongs to a different organization.`);
  }
}

function assertMinorUnits(value: unknown, label: string): bigint {
  if (typeof value !== 'bigint') {
    fail('INVALID_REQUEST', `${label} must be a bigint of integer minor units.`);
  }
  return value;
}

function assertUgx(value: unknown, label: string): void {
  if (value !== UGX) {
    fail('CURRENCY_MISMATCH', `${label} must use ${UGX}.`);
  }
}

function assertCallState(value: CallState, label: string): CallState {
  if (!Object.prototype.hasOwnProperty.call(CALL_TRANSITIONS, value)) {
    fail('UNKNOWN_CALL_STATE', `${label} is not a known call state.`);
  }
  return value;
}

function assertArray(value: unknown, label: string): readonly unknown[] {
  if (!Array.isArray(value)) fail('INVALID_REQUEST', `${label} must be an array.`);
  return value as readonly unknown[];
}

function zeroStatusCounts(): Record<CallState, number> {
  return Object.fromEntries(ANALYTICS_CALL_STATES.map((state) => [state, 0])) as Record<
    CallState,
    number
  >;
}

function newSummary(): MutableSummary {
  return { attempts: 0, answered: 0, statusCounts: zeroStatusCounts(), spendMinor: 0n };
}

function isAnswered(state: CallState): boolean {
  return state === 'ANSWERED' || state === 'COMPLETED';
}

function applyAttempt(summary: MutableSummary, state: CallState, spendMinor: bigint): void {
  summary.attempts += 1;
  summary.statusCounts[state] += 1;
  if (isAnswered(state)) summary.answered += 1;
  summary.spendMinor += spendMinor;
}

function finishSummary(summary: MutableSummary): AnalyticsMetricsSummary {
  return {
    attempts: summary.attempts,
    answered: summary.answered,
    statusCounts: { ...summary.statusCounts },
    spend: money(summary.spendMinor, UGX),
  };
}

function compareIds(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Produces a tenant-scoped report or fails closed. Any mismatch between
 * immutable usage evidence and the append-only ledger prevents a report;
 * silently choosing one source would not satisfy W5-03's reconciliation rule.
 */
export function buildAnalyticsReport(input: AnalyticsInput): AnalyticsReport {
  const organizationId = requiredIdentifier(input?.organizationId, 'organizationId');

  const attemptsById = new Map<string, ValidatedAttempt>();
  for (const value of assertArray(input.attempts, 'attempts')) {
    const attempt = value as AnalyticsCallAttemptRecord;
    assertOrganization(attempt?.organizationId, organizationId, 'attempt');
    const attemptId = requiredIdentifier(attempt.attemptId, 'attempt.attemptId');
    if (attemptsById.has(attemptId)) {
      fail('DUPLICATE_RECORD', 'Duplicate call attempt.');
    }
    attemptsById.set(attemptId, {
      campaignId: requiredIdentifier(attempt.campaignId, 'attempt.campaignId'),
      state: assertCallState(attempt.state, 'attempt.state'),
    });
  }

  const debitsByUsageEvent = new Map<string, LinkedLedgerEntry>();
  const creditsByUsageEvent = new Map<string, LinkedLedgerEntry>();
  const ledgerEntryIds = new Set<string>();

  for (const value of assertArray(input.ledgerEntries, 'ledgerEntries')) {
    const entry = value as AnalyticsLedgerEntryRecord;
    assertOrganization(entry?.organizationId, organizationId, 'ledgerEntry');
    const entryId = requiredIdentifier(entry.entryId, 'ledgerEntry.entryId');
    if (ledgerEntryIds.has(entryId)) {
      fail('DUPLICATE_RECORD', 'Duplicate wallet ledger entry.');
    }
    ledgerEntryIds.add(entryId);
    assertMinorUnits(entry.amountMinor, 'ledgerEntry.amountMinor');
    assertUgx(entry.currency, 'ledgerEntry.currency');

    if (entry.link === null || entry.link === undefined) continue;
    const usageEventId = requiredIdentifier(entry.link.usageEventId, 'ledgerEntry.link.usageEventId');
    const linked: LinkedLedgerEntry = { entryId, amountMinor: entry.amountMinor };

    if (entry.link.kind === 'VOICE_USAGE_DEBIT') {
      if (debitsByUsageEvent.has(usageEventId)) {
        fail('DUPLICATE_RECORD', 'Duplicate voice usage debit.');
      }
      debitsByUsageEvent.set(usageEventId, linked);
    } else if (entry.link.kind === 'VOICE_USAGE_REVERSAL_CREDIT') {
      if (creditsByUsageEvent.has(usageEventId)) {
        fail('DUPLICATE_RECORD', 'Duplicate voice usage reversal credit.');
      }
      creditsByUsageEvent.set(usageEventId, linked);
    } else {
      fail('INVALID_REQUEST', 'Unknown wallet ledger link kind.');
    }
  }

  const usageByAttempt = new Map<string, ResolvedUsage>();
  const usageEventIds = new Set<string>();
  const linkedUsageEventIds = new Set<string>();

  for (const value of assertArray(input.usageEvents, 'usageEvents')) {
    const event = value as AnalyticsVoiceUsageEventRecord;
    assertOrganization(event?.organizationId, organizationId, 'usageEvent');
    const usageEventId = requiredIdentifier(event.usageEventId, 'usageEvent.usageEventId');
    if (usageEventIds.has(usageEventId)) {
      fail('DUPLICATE_RECORD', 'Duplicate voice usage event.');
    }
    usageEventIds.add(usageEventId);

    const attemptId = requiredIdentifier(event.attemptId, 'usageEvent.attemptId');
    const attempt = attemptsById.get(attemptId);
    if (!attempt) {
      fail('ORPHAN_USAGE_EVENT', 'Voice usage event has no call attempt in this organization.');
    }
    if (usageByAttempt.has(attemptId)) {
      fail('DUPLICATE_RECORD', 'A call attempt has more than one voice usage event.');
    }

    const chargeAmount = assertMinorUnits(
      event.customerChargeMinor,
      'usageEvent.customerChargeMinor',
    );
    if (chargeAmount < 0n) {
      fail('INVALID_REQUEST', 'Voice usage charge cannot be negative.');
    }
    assertUgx(event.currency, 'usageEvent.currency');

    const debit = debitsByUsageEvent.get(usageEventId);
    if (!debit) {
      fail('LEDGER_MISMATCH', 'Voice usage event has no matching wallet debit.');
    }
    const debitEntryId = requiredIdentifier(event.debitEntryId, 'usageEvent.debitEntryId');
    if (debit.entryId !== debitEntryId || debit.amountMinor !== -chargeAmount) {
      fail('LEDGER_MISMATCH', 'Voice usage charge and wallet debit disagree.');
    }

    const reversalCreditEntryId = event.reversalCreditEntryId;
    let reversed = false;
    if (reversalCreditEntryId === null || reversalCreditEntryId === undefined) {
      if (creditsByUsageEvent.has(usageEventId)) {
        fail('LEDGER_MISMATCH', 'Wallet reversal credit has no immutable usage reversal.');
      }
    } else {
      reversed = true;
      const credit = creditsByUsageEvent.get(usageEventId);
      const expectedCreditEntryId = requiredIdentifier(
        reversalCreditEntryId,
        'usageEvent.reversalCreditEntryId',
      );
      if (!credit || credit.entryId !== expectedCreditEntryId || credit.amountMinor !== chargeAmount) {
        fail('LEDGER_MISMATCH', 'Voice usage reversal and wallet credit disagree.');
      }
    }

    linkedUsageEventIds.add(usageEventId);
    usageByAttempt.set(attemptId, {
      campaignId: attempt.campaignId,
      charge: money(chargeAmount, UGX),
      reversed,
    });
  }

  for (const usageEventId of debitsByUsageEvent.keys()) {
    if (!linkedUsageEventIds.has(usageEventId)) {
      fail('LEDGER_MISMATCH', 'Wallet debit has no matching voice usage event.');
    }
  }
  for (const usageEventId of creditsByUsageEvent.keys()) {
    if (!linkedUsageEventIds.has(usageEventId)) {
      fail('LEDGER_MISMATCH', 'Wallet reversal credit has no matching voice usage event.');
    }
  }

  const totalSummary = newSummary();
  const campaignSummaries = new Map<string, MutableSummary>();
  const callLogs: AnalyticsCallLogRow[] = [];

  for (const value of assertArray(input.attempts, 'attempts')) {
    const attempt = value as AnalyticsCallAttemptRecord;
    const attemptId = requiredIdentifier(attempt.attemptId, 'attempt.attemptId');
    const validated = attemptsById.get(attemptId);
    if (!validated) fail('INVALID_REQUEST', 'Attempt disappeared during aggregation.');
    const usage = usageByAttempt.get(attemptId);
    const spendMinor = usage && !usage.reversed ? usage.charge.amountMinor : 0n;

    applyAttempt(totalSummary, validated.state, spendMinor);

    let campaignSummary = campaignSummaries.get(validated.campaignId);
    if (!campaignSummary) {
      campaignSummary = newSummary();
      campaignSummaries.set(validated.campaignId, campaignSummary);
    }
    applyAttempt(campaignSummary, validated.state, spendMinor);

    callLogs.push({
      campaignId: validated.campaignId,
      attemptId,
      state: validated.state,
      answered: isAnswered(validated.state),
      spend: money(spendMinor, UGX),
    });
  }

  const campaigns = [...campaignSummaries.entries()]
    .sort(([a], [b]) => compareIds(a, b))
    .map(([campaignId, summary]) => ({ campaignId, ...finishSummary(summary) }));

  callLogs.sort(
    (a, b) =>
      compareIds(a.campaignId, b.campaignId) || compareIds(a.attemptId, b.attemptId),
  );

  return {
    organizationId,
    totals: finishSummary(totalSummary),
    campaigns,
    callLogs,
    reconciliation: {
      status: 'RECONCILED',
      usageEvents: usageEventIds.size,
      ledgerEntries: debitsByUsageEvent.size + creditsByUsageEvent.size,
    },
  };
}
