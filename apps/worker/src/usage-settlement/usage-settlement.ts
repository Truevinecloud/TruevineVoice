import { randomUUID } from 'node:crypto';

import { parseCallbackSource, type CallSql } from '@truevine/telephony';

import { settleDispatchReservation } from '../reliability/dispatch-reservation.js';

export type UsageSettlementOutcome =
  | 'SETTLED'
  | 'UNBILLABLE'
  | 'NO_QUOTE'
  | 'INSUFFICIENT_FUNDS';

export type UsageReversalOutcome = 'REVERSED' | 'ALREADY_REVERSED' | 'NOT_FOUND';

export interface UsageSettlementInput {
  readonly organizationId: string;
  readonly attemptId: string;
  readonly source: string;
  readonly sessionId: string;
  readonly eventKey: string;
  readonly state: string;
  readonly occurredAt: Date;
}

export interface UsageQuoteInput {
  readonly organizationId: string;
  readonly attemptId: string;
  readonly source: string;
  readonly sessionId: string;
  readonly billedSeconds: number;
  readonly ratePerSecondMinor: string | bigint;
  readonly customerChargeMinor: string | bigint;
  readonly providerCostMinor?: string | bigint | null;
  readonly providerCostCurrency?: string | null;
  readonly pricingVersion: string;
}

export interface UsageReversalInput {
  readonly organizationId: string;
  readonly eventKey: string;
  readonly reason: string;
}

interface ExistingUsageEvent {
  readonly organization_id: string;
  readonly attempt_id: string;
  readonly source: string;
  readonly session_id: string;
}

interface UsageQuoteRow {
  readonly id: string;
  readonly attempt_id: string;
  readonly billed_seconds: number;
  readonly rate_per_second_minor: string;
  readonly customer_charge_minor: string;
  readonly provider_cost_minor: string | null;
  readonly provider_cost_currency: string | null;
  readonly pricing_version: string;
}

interface BalanceRow {
  readonly balance: string | null;
}

interface ReversalRow {
  readonly id: string;
}

interface ReversalEventRow {
  readonly id: string;
  readonly customer_charge_minor: string;
}

const MAX_BIGINT = 9223372036854775807n;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SESSION = /^[A-Za-z0-9_-]{1,160}$/;
const EVENT_KEY = /^[a-f0-9]{64}$/;
const PRICING_VERSION = /^[A-Za-z0-9._:-]{1,64}$/;

function invalid(): never {
  throw new Error('usage_settlement_invalid_request');
}

function uuid(value: string): string {
  if (typeof value !== 'string' || !UUID.test(value)) invalid();
  return value.toLowerCase();
}

function sessionId(value: string): string {
  if (typeof value !== 'string' || !SESSION.test(value)) invalid();
  return value;
}

function eventKey(value: string): string {
  if (typeof value !== 'string' || !EVENT_KEY.test(value)) invalid();
  return value;
}

function source(value: string): string {
  try {
    return parseCallbackSource(value);
  } catch {
    return invalid();
  }
}

function minor(value: string | bigint | null | undefined, allowZero: boolean): bigint {
  if (typeof value === 'bigint') {
    if (value > MAX_BIGINT || (!allowZero && value <= 0n)) invalid();
    return value;
  }
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]{0,18})$/.test(value)) invalid();
  const parsed = BigInt(value);
  if (parsed > MAX_BIGINT || (!allowZero && parsed <= 0n)) invalid();
  return parsed;
}

function billedSeconds(value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0 || value > 2_147_483_647) invalid();
  return value;
}

function occurredAt(value: Date): Date {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) invalid();
  return value;
}

function assertSameUsage(
  event: ExistingUsageEvent,
  organizationId: string,
  attemptId: string,
  namespace: string,
  session: string,
): void {
  if (
    event.organization_id !== organizationId ||
    event.attempt_id !== attemptId ||
    event.source !== namespace ||
    event.session_id !== session
  )
    throw new Error('usage_settlement_conflict');
}

function pricingVersion(value: string): string {
  if (typeof value !== 'string' || !PRICING_VERSION.test(value)) invalid();
  return value;
}

function reason(value: string): string {
  if (typeof value !== 'string' || value.trim().length < 3 || value.length > 200) invalid();
  return value.trim();
}

async function lock(tx: CallSql, reference: string): Promise<void> {
  await tx.$queryRaw`SELECT 1::int FROM (SELECT pg_advisory_xact_lock(hashtext(${reference})) AS lock) AS advisory_lock`;
}

function debitReference(organizationId: string, key: string): string {
  return `voice-usage:${organizationId}:${key}`;
}

function reversalReference(organizationId: string, key: string): string {
  return `voice-usage-reversal:${organizationId}:${key}`;
}

/**
 * Writes the trusted rating decision, then debits the customer once per receipt.
 *
 * The caller owns the transaction so receipt completion, usage evidence and the
 * ledger entry commit together. Provider-reported amount is never an input:
 * provider cost is stored as evidence and the customer charge is an exact
 * integer amount from an explicit rating decision.
 */
export class UsageSettlement {
  /** Internal/trusted rating boundary. No HTTP route or provider payload reaches it. */
  async quote(tx: CallSql, input: UsageQuoteInput): Promise<string> {
    const organizationId = uuid(input.organizationId);
    const attemptId = uuid(input.attemptId);
    const namespace = source(input.source);
    const session = sessionId(input.sessionId);
    const seconds = billedSeconds(input.billedSeconds);
    const rate = minor(input.ratePerSecondMinor, false);
    const charge = minor(input.customerChargeMinor, false);
    if (charge !== rate * BigInt(seconds)) invalid();

    const cost = input.providerCostMinor === undefined || input.providerCostMinor === null
      ? null
      : minor(input.providerCostMinor, true);
    const costCurrency = input.providerCostCurrency ?? null;
    if ((cost === null) !== (costCurrency === null)) invalid();
    if (costCurrency !== null && costCurrency !== 'UGX') invalid();
    const version = pricingVersion(input.pricingVersion);

    const id = randomUUID();
    const inserted = await tx.$executeRaw`
      INSERT INTO voice_usage_quotes (
        organization_id, id, source, session_id, attempt_id, billed_seconds,
        rate_per_second_minor, customer_charge_minor, currency,
        provider_cost_minor, provider_cost_currency, pricing_version
      )
      SELECT ${organizationId}::uuid, ${id}::uuid, ${namespace}, ${session}, ${attemptId}::uuid,
        ${seconds}, ${rate.toString()}::bigint, ${charge.toString()}::bigint, 'UGX',
        ${cost?.toString() ?? null}::bigint, ${costCurrency}, ${version}
      WHERE EXISTS (
        SELECT 1 FROM voice_callback_bindings
        WHERE source = ${namespace} AND session_id = ${session}
          AND organization_id = ${organizationId}::uuid AND attempt_id = ${attemptId}::uuid
      )`;
    if (inserted !== 1) invalid();
    return id;
  }

  async settle(tx: CallSql, input: UsageSettlementInput): Promise<UsageSettlementOutcome> {
    const organizationId = uuid(input.organizationId);
    const attemptId = uuid(input.attemptId);
    const namespace = source(input.source);
    const session = sessionId(input.sessionId);
    const key = eventKey(input.eventKey);
    const at = occurredAt(input.occurredAt);

    // Callback states without completed connected usage are deliberately unbillable.
    if (input.state !== 'COMPLETED') return 'UNBILLABLE';

    const reference = debitReference(organizationId, key);
    await lock(tx, reference);
    // Same organization/currency advisory key as billing-admin adjustments, so
    // concurrent balance checks cannot both authorize an overdraft.
    await tx.$queryRaw`SELECT 1::int FROM (SELECT pg_advisory_xact_lock(hashtext(${organizationId} || ':' || ${'UGX'})) AS lock) AS advisory_lock`;

    const existing = await tx.$queryRaw<ExistingUsageEvent[]>`
      SELECT organization_id::text, attempt_id::text, source, session_id
      FROM voice_usage_events
      WHERE organization_id = ${organizationId}::uuid AND receipt_event_key = ${key}`;
    if (existing.length) {
      assertSameUsage(existing[0]!, organizationId, attemptId, namespace, session);
      return 'SETTLED';
    }

    const [quote] = await tx.$queryRaw<UsageQuoteRow[]>`
      SELECT id::text, attempt_id::text, billed_seconds,
        rate_per_second_minor::text, customer_charge_minor::text,
        provider_cost_minor::text, provider_cost_currency, pricing_version
      FROM voice_usage_quotes
      WHERE organization_id = ${organizationId}::uuid
        AND source = ${namespace} AND session_id = ${session}`;
    if (!quote) return 'NO_QUOTE';
    if (quote.attempt_id !== attemptId) throw new Error('usage_settlement_conflict');

    // A different duplicate callback event key must not reuse the same quote.
    const [alreadyCharged] = await tx.$queryRaw<ExistingUsageEvent[]>`
      SELECT organization_id::text, attempt_id::text, source, session_id
      FROM voice_usage_events
      WHERE organization_id = ${organizationId}::uuid AND quote_id = ${quote.id}::uuid`;
    if (alreadyCharged) {
      assertSameUsage(alreadyCharged, organizationId, attemptId, namespace, session);
      return 'SETTLED';
    }

    const charge = minor(quote.customer_charge_minor, false);
    const [balance] = await tx.$queryRaw<BalanceRow[]>`
      SELECT COALESCE(SUM(amount_minor), 0)::text AS balance
      FROM wallet_entries
      WHERE organization_id = ${organizationId}::uuid AND currency = 'UGX'`;
    if (BigInt(balance?.balance ?? '0') - charge < 0n) return 'INSUFFICIENT_FUNDS';

    const debitEntryId = randomUUID();
    const eventId = randomUUID();
    await tx.$executeRaw`
      INSERT INTO wallet_entries (organization_id, id, amount_minor, currency, reference, description)
      VALUES (${organizationId}::uuid, ${debitEntryId}::uuid, -${charge.toString()}::bigint,
        'UGX', ${reference}, 'Voice call usage debit')`;
    await tx.$executeRaw`
      INSERT INTO voice_usage_events (
        organization_id, id, attempt_id, source, session_id, receipt_event_key,
        quote_id, debit_entry_id, billed_seconds, rate_per_second_minor,
        customer_charge_minor, currency, provider_cost_minor, provider_cost_currency,
        pricing_version, state, occurred_at
      )
      VALUES (
        ${organizationId}::uuid, ${eventId}::uuid, ${attemptId}::uuid, ${namespace}, ${session},
        ${key}, ${quote.id}::uuid, ${debitEntryId}::uuid, ${quote.billed_seconds},
        ${quote.rate_per_second_minor}::bigint, ${quote.customer_charge_minor}::bigint, 'UGX',
        ${quote.provider_cost_minor}::bigint, ${quote.provider_cost_currency},
        ${quote.pricing_version}, 'COMPLETED'::"CallAttemptState", ${at}
      )`;
    // Releases the W6-01 pre-paid-work hold in the same transaction as the
    // financial event. Duplicate callbacks return above and cannot re-release.
    await settleDispatchReservation(tx, organizationId, attemptId);
    return 'SETTLED';
  }

  /** Compensating ledger entry plus immutable reversal evidence. */
  async reverse(tx: CallSql, input: UsageReversalInput): Promise<UsageReversalOutcome> {
    const organizationId = uuid(input.organizationId);
    const key = eventKey(input.eventKey);
    const text = reason(input.reason);
    const reference = reversalReference(organizationId, key);
    await lock(tx, reference);

    const [reversal] = await tx.$queryRaw<ReversalRow[]>`
      SELECT r.id::text FROM voice_usage_reversals r
      JOIN voice_usage_events e ON e.organization_id = r.organization_id AND e.id = r.usage_event_id
      WHERE r.organization_id = ${organizationId}::uuid AND e.receipt_event_key = ${key}`;
    if (reversal) return 'ALREADY_REVERSED';

    const [event] = await tx.$queryRaw<ReversalEventRow[]>`
      SELECT id::text, customer_charge_minor::text FROM voice_usage_events
      WHERE organization_id = ${organizationId}::uuid AND receipt_event_key = ${key}`;
    if (!event) return 'NOT_FOUND';

    const creditEntryId = randomUUID();
    const reversalId = randomUUID();
    await tx.$executeRaw`
      INSERT INTO wallet_entries (organization_id, id, amount_minor, currency, reference, description)
      VALUES (${organizationId}::uuid, ${creditEntryId}::uuid, ${event.customer_charge_minor}::bigint,
        'UGX', ${reference}, 'Voice usage reversal')`;
    await tx.$executeRaw`
      INSERT INTO voice_usage_reversals (organization_id, id, usage_event_id, credit_entry_id, reason)
      VALUES (${organizationId}::uuid, ${reversalId}::uuid, ${event.id}::uuid,
        ${creditEntryId}::uuid, ${text})`;
    return 'REVERSED';
  }
}
