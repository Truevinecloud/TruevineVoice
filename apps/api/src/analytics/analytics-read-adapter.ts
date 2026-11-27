import { CALL_TRANSITIONS, type CallState } from '@truevine/domain';

import {
  AnalyticsMetricsError,
  buildAnalyticsReport,
  type AnalyticsInput,
  type AnalyticsReport,
} from './analytics-metrics.js';

/**
 * W5-03 organization-scoped PostgreSQL read adapter.
 *
 * Every query is constrained by organization_id, including subqueries. The
 * adapter reads separate row sets inside one RepeatableRead transaction instead
 * of joining attempts to ledger rows, so a one-to-many join can never multiply
 * a charge. It selects no provider payload, credential or raw callback body.
 *
 * The adapter is deliberately unwired from Nest. A future authorized service
 * must pass a session-derived organization ID, never a browser-supplied one.
 */

export interface AnalyticsSql {
  $queryRaw<T = unknown>(strings: TemplateStringsArray, ...values: unknown[]): Promise<T>;
}

export interface AnalyticsDatabase {
  $transaction<T>(
    body: (tx: AnalyticsSql) => Promise<T>,
    options: { isolationLevel: 'RepeatableRead' },
  ): Promise<T>;
}

export interface AnalyticsReadFilters {
  /** Inclusive attempt-created-at lower bound. Must be paired with `to`. */
  readonly from?: Date;
  /** Exclusive attempt-created-at upper bound. Must be paired with `from`. */
  readonly to?: Date;
  /** Optional campaign IDs; bounded to avoid an unbounded IN list. */
  readonly campaignIds?: readonly string[];
}

export interface AnalyticsCampaignRecord {
  readonly campaignId: string;
  readonly name: string;
  readonly status: string;
  readonly createdAt: Date;
}

export interface AnalyticsCallEventRecord {
  readonly eventId: string;
  readonly attemptId: string;
  readonly state: CallState;
  readonly disposition: string;
  readonly occurredAt: Date;
  readonly receivedAt: Date;
}

export interface AnalyticsProviderCostEvidence {
  readonly usageEventId: string;
  readonly amountMinor: bigint | null;
  readonly currency: string | null;
}

export interface AnalyticsAdapterResult {
  readonly input: AnalyticsInput;
  readonly campaigns: readonly AnalyticsCampaignRecord[];
  readonly callEvents: readonly AnalyticsCallEventRecord[];
  readonly providerCostEvidence: readonly AnalyticsProviderCostEvidence[];
}

export interface AnalyticsIntegrationReport extends AnalyticsReport {
  readonly campaignMetadata: readonly AnalyticsCampaignRecord[];
  readonly callEvents: readonly AnalyticsCallEventRecord[];
  readonly providerCostEvidence: readonly AnalyticsProviderCostEvidence[];
}

interface NormalizedFilters {
  readonly from: Date | null;
  readonly to: Date | null;
  readonly campaignIds: readonly string[];
}

interface CampaignRow {
  readonly organization_id: string;
  readonly id: string;
  readonly name: string;
  readonly status: string;
  readonly created_at: Date;
}

interface AttemptRow {
  readonly organization_id: string;
  readonly id: string;
  readonly campaign_id: string;
  readonly state: string;
  readonly created_at: Date;
}

interface CallEventRow {
  readonly organization_id: string;
  readonly id: string;
  readonly attempt_id: string;
  readonly requested_state: string;
  readonly disposition: string;
  readonly occurred_at: Date;
  readonly received_at: Date;
}

interface UsageEventRow {
  readonly organization_id: string;
  readonly id: string;
  readonly attempt_id: string;
  readonly debit_entry_id: string;
  readonly customer_charge_minor: string;
  readonly currency: string;
  readonly provider_cost_minor: string | null;
  readonly provider_cost_currency: string | null;
  readonly created_at: Date;
}

interface ReversalRow {
  readonly organization_id: string;
  readonly id: string;
  readonly usage_event_id: string;
  readonly credit_entry_id: string;
}

interface WalletEntryRow {
  readonly organization_id: string;
  readonly id: string;
  readonly amount_minor: string;
  readonly currency: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MAX_CAMPAIGN_FILTERS = 100;

function fail(message: string): never {
  throw new AnalyticsMetricsError('INVALID_REQUEST', message);
}

function uuid(value: unknown, label: string): string {
  if (typeof value !== 'string' || !UUID.test(value)) fail(`${label} must be a UUID.`);
  return value.toLowerCase();
}

function normalizeFilters(filters: AnalyticsReadFilters | undefined): NormalizedFilters {
  if (filters === undefined) return { from: null, to: null, campaignIds: [] };

  const hasFrom = filters.from !== undefined;
  const hasTo = filters.to !== undefined;
  if (hasFrom !== hasTo) fail('Date filters require both from and to bounds.');
  if (hasFrom && hasTo) {
    if (!(filters.from instanceof Date) || !Number.isFinite(filters.from.getTime())) {
      fail('from must be a valid Date.');
    }
    if (!(filters.to instanceof Date) || !Number.isFinite(filters.to.getTime())) {
      fail('to must be a valid Date.');
    }
    if (filters.from.getTime() >= filters.to.getTime()) fail('from must be earlier than to.');
  }

  const campaignIds = filters.campaignIds ?? [];
  if (campaignIds.length > MAX_CAMPAIGN_FILTERS) {
    fail(`At most ${MAX_CAMPAIGN_FILTERS} campaign IDs may be supplied.`);
  }
  const normalized = [...new Set(campaignIds.map((id) => uuid(id, 'campaignId')))];
  return { from: filters.from ?? null, to: filters.to ?? null, campaignIds: normalized };
}

function callState(value: string): CallState {
  if (!Object.prototype.hasOwnProperty.call(CALL_TRANSITIONS, value)) {
    throw new AnalyticsMetricsError(
      'UNKNOWN_CALL_STATE',
      'Database returned an unknown call state.',
    );
  }
  return value as CallState;
}

function bigintMinor(value: string, label: string): bigint {
  if (typeof value !== 'string' || !/^-?\d+$/.test(value)) {
    fail(`${label} is not an integer minor-unit string.`);
  }
  return BigInt(value);
}

function assertTenant(row: { readonly organization_id: string }, organizationId: string): void {
  if (row.organization_id !== organizationId) {
    throw new AnalyticsMetricsError(
      'TENANT_MISMATCH',
      'Database row belongs to another organization.',
    );
  }
}

function putUnique<T>(map: Map<string, T>, key: string, value: T, label: string): void {
  if (map.has(key)) {
    throw new AnalyticsMetricsError(
      'DUPLICATE_RECORD',
      `Duplicate ${label} in analytics source data.`,
    );
  }
  map.set(key, value);
}

export class PrismaAnalyticsReadAdapter {
  constructor(private readonly database: AnalyticsDatabase) {}

  async load(
    organizationId: string,
    filters?: AnalyticsReadFilters,
  ): Promise<AnalyticsAdapterResult> {
    const organization = uuid(organizationId, 'organizationId');
    const bounds = normalizeFilters(filters);
    const hasCampaignIds = bounds.campaignIds.length > 0;
    const campaignIds: readonly string[] | null = hasCampaignIds ? bounds.campaignIds : null;
    const hasFrom = bounds.from !== null;
    const hasTo = bounds.to !== null;
    const from = bounds.from;
    const to = bounds.to;

    return this.database.$transaction(
      async (tx) => {
        const campaignRows = await tx.$queryRaw<CampaignRow[]>`
        SELECT organization_id::text, id::text, name, status::text, created_at
        FROM campaigns
        WHERE organization_id = ${organization}::uuid
          AND (${hasCampaignIds}::boolean IS FALSE OR id = ANY(${campaignIds}::uuid[]))
        ORDER BY id`;

        const attemptRows = await tx.$queryRaw<AttemptRow[]>`
        SELECT organization_id::text, id::text, campaign_id::text, state::text, created_at
        FROM call_attempts
        WHERE organization_id = ${organization}::uuid
          AND (${hasCampaignIds}::boolean IS FALSE OR campaign_id = ANY(${campaignIds}::uuid[]))
          AND (${hasFrom}::boolean IS FALSE OR created_at >= ${from}::timestamptz)
          AND (${hasTo}::boolean IS FALSE OR created_at < ${to}::timestamptz)
        ORDER BY campaign_id, id`;

        const callEventRows = await tx.$queryRaw<CallEventRow[]>`
        SELECT e.organization_id::text, e.id::text, e.attempt_id::text,
          e.requested_state::text, e.disposition, e.occurred_at, e.received_at
        FROM call_events e
        WHERE e.organization_id = ${organization}::uuid
          AND EXISTS (
            SELECT 1 FROM call_attempts a
            WHERE a.organization_id = e.organization_id
              AND a.id = e.attempt_id
              AND (${hasCampaignIds}::boolean IS FALSE OR a.campaign_id = ANY(${campaignIds}::uuid[]))
              AND (${hasFrom}::boolean IS FALSE OR a.created_at >= ${from}::timestamptz)
              AND (${hasTo}::boolean IS FALSE OR a.created_at < ${to}::timestamptz)
          )
        ORDER BY e.attempt_id, e.occurred_at, e.id`;

        const usageRows = await tx.$queryRaw<UsageEventRow[]>`
        SELECT e.organization_id::text, e.id::text, e.attempt_id::text, e.debit_entry_id::text,
          e.customer_charge_minor::text, e.currency, e.provider_cost_minor::text,
          e.provider_cost_currency, e.created_at
        FROM voice_usage_events e
        WHERE e.organization_id = ${organization}::uuid
          AND EXISTS (
            SELECT 1 FROM call_attempts a
            WHERE a.organization_id = e.organization_id
              AND a.id = e.attempt_id
              AND (${hasCampaignIds}::boolean IS FALSE OR a.campaign_id = ANY(${campaignIds}::uuid[]))
              AND (${hasFrom}::boolean IS FALSE OR a.created_at >= ${from}::timestamptz)
              AND (${hasTo}::boolean IS FALSE OR a.created_at < ${to}::timestamptz)
          )
        ORDER BY e.attempt_id, e.created_at, e.id`;

        const reversalRows = await tx.$queryRaw<ReversalRow[]>`
        SELECT r.organization_id::text, r.id::text, r.usage_event_id::text, r.credit_entry_id::text
        FROM voice_usage_reversals r
        WHERE r.organization_id = ${organization}::uuid
          AND EXISTS (
            SELECT 1 FROM voice_usage_events e
            WHERE e.organization_id = r.organization_id
              AND e.id = r.usage_event_id
              AND EXISTS (
                SELECT 1 FROM call_attempts a
                WHERE a.organization_id = e.organization_id
                  AND a.id = e.attempt_id
                  AND (${hasCampaignIds}::boolean IS FALSE OR a.campaign_id = ANY(${campaignIds}::uuid[]))
                  AND (${hasFrom}::boolean IS FALSE OR a.created_at >= ${from}::timestamptz)
                  AND (${hasTo}::boolean IS FALSE OR a.created_at < ${to}::timestamptz)
              )
          )
        ORDER BY r.usage_event_id`;

        const debitRows = await tx.$queryRaw<WalletEntryRow[]>`
        SELECT w.organization_id::text, w.id::text, w.amount_minor::text, w.currency
        FROM wallet_entries w
        WHERE w.organization_id = ${organization}::uuid
          AND w.id IN (
            SELECT e.debit_entry_id FROM voice_usage_events e
            WHERE e.organization_id = w.organization_id
              AND EXISTS (
                SELECT 1 FROM call_attempts a
                WHERE a.organization_id = e.organization_id
                  AND a.id = e.attempt_id
                  AND (${hasCampaignIds}::boolean IS FALSE OR a.campaign_id = ANY(${campaignIds}::uuid[]))
                  AND (${hasFrom}::boolean IS FALSE OR a.created_at >= ${from}::timestamptz)
                  AND (${hasTo}::boolean IS FALSE OR a.created_at < ${to}::timestamptz)
              )
          )`;

        const creditRows = await tx.$queryRaw<WalletEntryRow[]>`
        SELECT w.organization_id::text, w.id::text, w.amount_minor::text, w.currency
        FROM wallet_entries w
        WHERE w.organization_id = ${organization}::uuid
          AND w.id IN (
            SELECT r.credit_entry_id FROM voice_usage_reversals r
            WHERE r.organization_id = w.organization_id
              AND EXISTS (
                SELECT 1 FROM voice_usage_events e
                WHERE e.organization_id = r.organization_id
                  AND e.id = r.usage_event_id
                  AND EXISTS (
                    SELECT 1 FROM call_attempts a
                    WHERE a.organization_id = e.organization_id
                      AND a.id = e.attempt_id
                      AND (${hasCampaignIds}::boolean IS FALSE OR a.campaign_id = ANY(${campaignIds}::uuid[]))
                      AND (${hasFrom}::boolean IS FALSE OR a.created_at >= ${from}::timestamptz)
                      AND (${hasTo}::boolean IS FALSE OR a.created_at < ${to}::timestamptz)
                  )
              )
          )`;

        const campaigns: AnalyticsCampaignRecord[] = [];
        for (const row of campaignRows) {
          assertTenant(row, organization);
          campaigns.push({
            campaignId: uuid(row.id, 'campaignId'),
            name: row.name,
            status: row.status,
            createdAt: row.created_at,
          });
        }

        const attemptsById = new Map<string, AttemptRow>();
        for (const row of attemptRows) {
          assertTenant(row, organization);
          putUnique(attemptsById, uuid(row.id, 'attemptId'), row, 'call attempt');
        }

        const callEvents: AnalyticsCallEventRecord[] = [];
        for (const row of callEventRows) {
          assertTenant(row, organization);
          const attemptId = uuid(row.attempt_id, 'callEvent.attemptId');
          if (!attemptsById.has(attemptId)) {
            throw new AnalyticsMetricsError(
              'ORPHAN_USAGE_EVENT',
              'Call event has no filtered attempt.',
            );
          }
          callEvents.push({
            eventId: uuid(row.id, 'callEvent.eventId'),
            attemptId,
            state: callState(row.requested_state),
            disposition: row.disposition,
            occurredAt: row.occurred_at,
            receivedAt: row.received_at,
          });
        }

        const debits = new Map<string, WalletEntryRow>();
        const credits = new Map<string, WalletEntryRow>();
        for (const row of debitRows) {
          assertTenant(row, organization);
          putUnique(debits, uuid(row.id, 'debitEntryId'), row, 'wallet debit');
        }
        for (const row of creditRows) {
          assertTenant(row, organization);
          putUnique(credits, uuid(row.id, 'creditEntryId'), row, 'wallet credit');
        }
        for (const entryId of credits.keys()) {
          if (debits.has(entryId)) {
            throw new AnalyticsMetricsError(
              'DUPLICATE_RECORD',
              'A ledger entry is both debit and credit.',
            );
          }
        }

        const reversalsByUsageEvent = new Map<string, ReversalRow>();
        for (const row of reversalRows) {
          assertTenant(row, organization);
          putUnique(
            reversalsByUsageEvent,
            uuid(row.usage_event_id, 'usageEventId'),
            row,
            'usage reversal',
          );
          const creditEntryId = uuid(row.credit_entry_id, 'reversal.creditEntryId');
          if (!credits.has(creditEntryId)) {
            throw new AnalyticsMetricsError(
              'LEDGER_MISMATCH',
              'Usage reversal credit is missing from the ledger.',
            );
          }
        }

        const usedDebitEntryIds = new Set<string>();
        const usedCreditEntryIds = new Set<string>();
        const providerCostEvidence: AnalyticsProviderCostEvidence[] = [];
        const usageEvents: AnalyticsInput['usageEvents'][number][] = [];

        for (const row of usageRows) {
          assertTenant(row, organization);
          const usageEventId = uuid(row.id, 'usageEventId');
          const attemptId = uuid(row.attempt_id, 'usageEvent.attemptId');
          const attempt = attemptsById.get(attemptId);
          if (!attempt) {
            throw new AnalyticsMetricsError(
              'ORPHAN_USAGE_EVENT',
              'Voice usage event has no filtered attempt.',
            );
          }
          const debitEntryId = uuid(row.debit_entry_id, 'usageEvent.debitEntryId');
          if (!debits.has(debitEntryId)) {
            throw new AnalyticsMetricsError(
              'LEDGER_MISMATCH',
              'Voice usage debit is missing from the ledger.',
            );
          }
          if (usedDebitEntryIds.has(debitEntryId)) {
            throw new AnalyticsMetricsError(
              'DUPLICATE_RECORD',
              'A wallet debit funds more than one usage event.',
            );
          }
          usedDebitEntryIds.add(debitEntryId);

          const reversal = reversalsByUsageEvent.get(usageEventId);
          let reversalCreditEntryId: string | null = null;
          if (reversal) {
            reversalCreditEntryId = uuid(reversal.credit_entry_id, 'reversal.creditEntryId');
            if (usedCreditEntryIds.has(reversalCreditEntryId)) {
              throw new AnalyticsMetricsError(
                'DUPLICATE_RECORD',
                'A wallet credit reverses more than one usage event.',
              );
            }
            usedCreditEntryIds.add(reversalCreditEntryId);
          }

          usageEvents.push({
            organizationId: organization,
            usageEventId,
            attemptId,
            debitEntryId,
            customerChargeMinor: bigintMinor(row.customer_charge_minor, 'customerChargeMinor'),
            currency: row.currency,
            reversalCreditEntryId,
          });

          providerCostEvidence.push({
            usageEventId,
            amountMinor:
              row.provider_cost_minor === null
                ? null
                : bigintMinor(row.provider_cost_minor, 'providerCostMinor'),
            currency: row.provider_cost_currency,
          });
        }

        const attempts: AnalyticsInput['attempts'][number][] = [];
        for (const row of attemptsById.values()) {
          attempts.push({
            organizationId: organization,
            campaignId: uuid(row.campaign_id, 'attempt.campaignId'),
            attemptId: uuid(row.id, 'attempt.attemptId'),
            state: callState(row.state),
          });
        }

        const ledgerEntries: AnalyticsInput['ledgerEntries'][number][] = [];
        for (const [entryId, row] of debits.entries()) {
          if (!usedDebitEntryIds.has(entryId)) continue;
          ledgerEntries.push({
            organizationId: organization,
            entryId,
            amountMinor: bigintMinor(row.amount_minor, 'ledgerEntry.amountMinor'),
            currency: row.currency,
            link: {
              kind: 'VOICE_USAGE_DEBIT',
              usageEventId: usageEventIdForDebit(usageEvents, entryId),
            },
          });
        }
        for (const [entryId, row] of credits.entries()) {
          if (!usedCreditEntryIds.has(entryId)) continue;
          ledgerEntries.push({
            organizationId: organization,
            entryId,
            amountMinor: bigintMinor(row.amount_minor, 'ledgerEntry.amountMinor'),
            currency: row.currency,
            link: {
              kind: 'VOICE_USAGE_REVERSAL_CREDIT',
              usageEventId: usageEventIdForCredit(usageEvents, entryId),
            },
          });
        }

        const input: AnalyticsInput = {
          organizationId: organization,
          attempts,
          usageEvents,
          ledgerEntries,
        };

        return { input, campaigns, callEvents, providerCostEvidence };
      },
      { isolationLevel: 'RepeatableRead' },
    );
  }

  async report(
    organizationId: string,
    filters?: AnalyticsReadFilters,
  ): Promise<AnalyticsIntegrationReport> {
    const data = await this.load(organizationId, filters);
    return {
      ...buildAnalyticsReport(data.input),
      campaignMetadata: data.campaigns,
      callEvents: data.callEvents,
      providerCostEvidence: data.providerCostEvidence,
    };
  }
}

function usageEventIdForDebit(
  usageEvents: readonly { readonly usageEventId: string; readonly debitEntryId: string }[],
  entryId: string,
): string {
  const match = usageEvents.find((event) => event.debitEntryId === entryId);
  if (!match)
    throw new AnalyticsMetricsError('LEDGER_MISMATCH', 'Debit link disappeared during mapping.');
  return match.usageEventId;
}

function usageEventIdForCredit(
  usageEvents: readonly {
    readonly usageEventId: string;
    readonly reversalCreditEntryId: string | null;
  }[],
  entryId: string,
): string {
  const match = usageEvents.find((event) => event.reversalCreditEntryId === entryId);
  if (!match)
    throw new AnalyticsMetricsError('LEDGER_MISMATCH', 'Credit link disappeared during mapping.');
  return match.usageEventId;
}
