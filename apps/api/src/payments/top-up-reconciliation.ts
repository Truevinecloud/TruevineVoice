import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';

/**
 * Unwired, synthetic-only top-up reconciliation.
 *
 * This service exists to prove the W5-02 settlement contract in isolation. It is
 * deliberately NOT registered in a Nest module, NOT mounted behind an HTTP
 * route, and NOT connected to a real MTN/Airtel client. The provider identity
 * below is a test namespace, not a claim that a live provider is integrated.
 *
 * The wallet write reuses the same append-only ledger that W5-01 depends on.
 * A verified event, its payment attempt, the intent status and the wallet credit
 * commit together; a replay cannot create a second entry.
 */

export const SYNTHETIC_PROVIDER = 'SYNTHETIC_SANDBOX' as const;
export const SYNTHETIC_ENVIRONMENT = 'SANDBOX' as const;

const CANONICAL_PREFIX = 'truevine-synthetic-payment-v1';
const MAX_BIGINT = 9223372036854775807n;
const IDENTIFIER = /^[A-Za-z0-9._:-]{1,120}$/;
const HEX64 = /^[a-f0-9]{64}$/;
const STATUSES = ['SUCCESS', 'FAILED', 'PENDING'] as const;

export type SyntheticCallbackStatus = (typeof STATUSES)[number];

export interface SyntheticCallbackPayload {
  readonly provider: typeof SYNTHETIC_PROVIDER;
  readonly environment: typeof SYNTHETIC_ENVIRONMENT;
  readonly eventId: string;
  readonly providerReference: string;
  readonly status: SyntheticCallbackStatus;
  readonly amountMinor: string;
  readonly currency: 'UGX';
}

export interface SyntheticPaymentCallback extends SyntheticCallbackPayload {
  /** Hex HMAC over the canonical payload; never stored in the event record. */
  readonly signature: string;
}

export type TopUpReconciliationOutcome =
  | 'CREDITED'
  | 'ALREADY_RECONCILED'
  | 'RECONCILIATION_REQUIRED'
  | 'REJECTED'
  | 'UNVERIFIED';

export interface TopUpReconciliationResult {
  readonly outcome: TopUpReconciliationOutcome;
  readonly eventId: string;
  readonly organizationId: string | null;
  readonly walletEntryId: string | null;
}

export interface TopUpSql {
  $queryRaw<T = unknown>(sql: TemplateStringsArray, ...values: unknown[]): Promise<T>;
  $executeRaw(sql: TemplateStringsArray, ...values: unknown[]): Promise<number>;
}

export interface TopUpDatabase extends TopUpSql {
  $transaction<T>(body: (tx: TopUpSql) => Promise<T>): Promise<T>;
}

export class TopUpReconciliationError extends Error {
  constructor(message = 'top_up_reconciliation_invalid_request') {
    super(message);
    this.name = 'TopUpReconciliationError';
  }
}

interface StoredEventRow {
  readonly id: string;
  readonly verified: boolean;
  readonly status: string;
  readonly organization_id: string | null;
  readonly payment_intent_id: string | null;
  readonly payload_redacted: unknown;
}

interface IntentRow {
  readonly id: string;
  readonly organization_id: string;
  readonly amount_minor: string;
  readonly currency: string;
  readonly status: string;
  readonly purpose: string;
}

interface WalletCreditRow {
  readonly id: string;
  readonly amount_minor: string;
  readonly reference: string;
}

interface RedactedEvent {
  readonly version: 1;
  readonly provider: typeof SYNTHETIC_PROVIDER;
  readonly environment: typeof SYNTHETIC_ENVIRONMENT;
  readonly eventId: string;
  readonly providerReference: string;
  readonly status: SyntheticCallbackStatus;
  readonly amountMinor: string;
  readonly currency: 'UGX';
  readonly fingerprint: string;
}

function invalid(): never {
  throw new TopUpReconciliationError();
}

function identifier(value: unknown): string {
  if (typeof value !== 'string' || !IDENTIFIER.test(value)) invalid();
  return value;
}

function amountMinor(value: unknown): string {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]{0,18})$/.test(value)) invalid();
  if (BigInt(value) <= 0n || BigInt(value) > MAX_BIGINT) invalid();
  return value;
}

function payloadFrom(value: unknown): SyntheticCallbackPayload {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) invalid();
  const body = value as Record<string, unknown>;
  if (body['provider'] !== SYNTHETIC_PROVIDER) invalid();
  if (body['environment'] !== SYNTHETIC_ENVIRONMENT) invalid();
  if (
    typeof body['status'] !== 'string' ||
    !(STATUSES as readonly string[]).includes(body['status'])
  )
    invalid();
  if (body['currency'] !== 'UGX') invalid();

  return {
    provider: SYNTHETIC_PROVIDER,
    environment: SYNTHETIC_ENVIRONMENT,
    eventId: identifier(body['eventId']),
    providerReference: identifier(body['providerReference']),
    status: body['status'] as SyntheticCallbackStatus,
    amountMinor: amountMinor(body['amountMinor']),
    currency: 'UGX',
  };
}

export function syntheticCallbackCanonical(payload: SyntheticCallbackPayload): string {
  const normalized = payloadFrom(payload);
  return [
    CANONICAL_PREFIX,
    normalized.provider,
    normalized.environment,
    normalized.eventId,
    normalized.providerReference,
    normalized.status,
    normalized.amountMinor,
    normalized.currency,
  ].join('\n');
}

function callbackFingerprint(payload: SyntheticCallbackPayload): string {
  return createHash('sha256').update(syntheticCallbackCanonical(payload)).digest('hex');
}

export function signSyntheticCallback(payload: SyntheticCallbackPayload, key: string): string {
  assertVerificationKey(key);
  return createHmac('sha256', key).update(syntheticCallbackCanonical(payload)).digest('hex');
}

export function parseSyntheticCallback(value: unknown): SyntheticPaymentCallback {
  const payload = payloadFrom(value);
  const body = value as Record<string, unknown>;
  const signature = body['signature'];
  if (typeof signature !== 'string' || !HEX64.test(signature)) invalid();
  return { ...payload, signature: signature.toLowerCase() };
}

export function verifySyntheticCallback(
  callback: SyntheticPaymentCallback,
  key: string,
): boolean {
  const expected = Buffer.from(signSyntheticCallback(callback, key), 'hex');
  const actual = Buffer.from(callback.signature, 'hex');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function assertVerificationKey(key: string): void {
  if (typeof key !== 'string' || key.length < 16 || key.length > 256) {
    throw new TopUpReconciliationError('top_up_reconciliation_key_required');
  }
}

async function lock(tx: TopUpSql, reference: string): Promise<void> {
  await tx.$queryRaw`SELECT 1::int FROM (SELECT pg_advisory_xact_lock(hashtext(${reference})) AS lock) AS advisory_lock`;
}

function eventLockKey(eventId: string): string {
  return `payment-topup-event:${SYNTHETIC_PROVIDER}:${SYNTHETIC_ENVIRONMENT}:${eventId}`;
}

function intentLockKey(organizationId: string, intentId: string): string {
  return `payment-topup-intent:${organizationId}:${intentId}`;
}

function creditReference(eventId: string): string {
  return `payment-topup:${SYNTHETIC_PROVIDER}:${eventId}`;
}

function redactedEvent(payload: SyntheticCallbackPayload, fingerprint: string): RedactedEvent {
  return {
    version: 1,
    provider: payload.provider,
    environment: payload.environment,
    eventId: payload.eventId,
    providerReference: payload.providerReference,
    status: payload.status,
    amountMinor: payload.amountMinor,
    currency: payload.currency,
    fingerprint,
  };
}

function storedPayload(row: StoredEventRow, eventId: string): SyntheticCallbackPayload {
  let parsed: unknown = row.payload_redacted;
  if (typeof parsed === 'string') {
    try {
      parsed = JSON.parse(parsed) as unknown;
    } catch {
      invalid();
    }
  }
  const value = parsed as Partial<RedactedEvent> | null;
  if (
    value === null ||
    typeof value !== 'object' ||
    value.version !== 1 ||
    value.eventId !== eventId
  )
    invalid();
  return payloadFrom({
    provider: value.provider,
    environment: value.environment,
    eventId: value.eventId,
    providerReference: value.providerReference,
    status: value.status,
    amountMinor: value.amountMinor,
    currency: value.currency,
  });
}

function result(
  outcome: TopUpReconciliationOutcome,
  eventId: string,
  organizationId: string | null = null,
  walletEntryId: string | null = null,
): TopUpReconciliationResult {
  return { outcome, eventId, organizationId, walletEntryId };
}

export class TopUpReconciliation {
  constructor(
    private readonly db: TopUpDatabase,
    private readonly verificationKey: string,
  ) {
    assertVerificationKey(verificationKey);
  }

  /** Validates shape and signature before the event is recorded or acted upon. */
  async receive(value: unknown): Promise<TopUpReconciliationResult> {
    const callback = parseSyntheticCallback(value);
    if (!verifySyntheticCallback(callback, this.verificationKey)) {
      return this.db.$transaction((tx) => this.recordUnverified(tx, payloadFrom(callback)));
    }
    return this.db.$transaction((tx) => this.applyVerified(tx, payloadFrom(callback)));
  }

  /** Re-applies an already recorded, verified event whose ledger credit is missing. */
  async reconcile(eventId: string): Promise<TopUpReconciliationResult> {
    const id = identifier(eventId);
    return this.db.$transaction(async (tx) => {
      await lock(tx, eventLockKey(id));
      const [row] = await this.findEvent(tx, id);
      if (!row || row.verified !== true) return result('RECONCILIATION_REQUIRED', id);
      return this.applyVerified(tx, storedPayload(row, id), row);
    });
  }

  private async recordUnverified(
    tx: TopUpSql,
    payload: SyntheticCallbackPayload,
  ): Promise<TopUpReconciliationResult> {
    await lock(tx, eventLockKey(payload.eventId));
    const [existing] = await this.findEvent(tx, payload.eventId);
    if (existing) return result('UNVERIFIED', payload.eventId, existing.organization_id);

    const fingerprint = callbackFingerprint(payload);
    await tx.$executeRaw`
      INSERT INTO payment_provider_events (
        id, provider, environment, provider_event_id, status, verified,
        payload_redacted, received_at
      )
      VALUES (
        ${randomUUID()}::uuid, ${SYNTHETIC_PROVIDER}, ${SYNTHETIC_ENVIRONMENT},
        ${payload.eventId}, 'UNVERIFIED', FALSE,
        ${JSON.stringify(redactedEvent(payload, fingerprint))}::jsonb, CURRENT_TIMESTAMP
      )`;
    return result('UNVERIFIED', payload.eventId);
  }

  private async applyVerified(
    tx: TopUpSql,
    payload: SyntheticCallbackPayload,
    knownEvent?: StoredEventRow,
  ): Promise<TopUpReconciliationResult> {
    const fingerprint = callbackFingerprint(payload);
    await lock(tx, eventLockKey(payload.eventId));
    const event = knownEvent ?? (await this.findEvent(tx, payload.eventId))[0];
    if (event) {
      const prior = storedPayload(event, payload.eventId);
      if (syntheticCallbackCanonical(prior) !== syntheticCallbackCanonical(payload)) {
        return result('RECONCILIATION_REQUIRED', payload.eventId, event.organization_id);
      }
    }

    const intents = await tx.$queryRaw<IntentRow[]>`
      SELECT id::text, organization_id::text, amount_minor::text, currency, status, purpose
      FROM payment_intents
      WHERE provider = ${SYNTHETIC_PROVIDER}
        AND environment = ${SYNTHETIC_ENVIRONMENT}
        AND provider_reference = ${payload.providerReference}
      FOR UPDATE`;

    if (intents.length !== 1) {
      if (!event) {
        await this.writeEvent(tx, undefined, payload, fingerprint, 'RECONCILIATION_REQUIRED', null, null);
      }
      return result(
        'RECONCILIATION_REQUIRED',
        payload.eventId,
        intents.length === 0 ? null : (event?.organization_id ?? null),
      );
    }
    const intent = intents[0]!;

    await lock(tx, intentLockKey(intent.organization_id, intent.id));

    if (
      intent.purpose !== 'WALLET_TOP_UP' ||
      intent.currency !== 'UGX' ||
      payload.currency !== 'UGX'
    ) {
      await this.writeEvent(
        tx,
        event,
        payload,
        fingerprint,
        'REJECTED',
        intent.organization_id,
        intent.id,
      );
      return result('REJECTED', payload.eventId, intent.organization_id);
    }

    if (intent.amount_minor !== payload.amountMinor) {
      await this.writeEvent(
        tx,
        event,
        payload,
        fingerprint,
        'RECONCILIATION_REQUIRED',
        intent.organization_id,
        intent.id,
      );
      await this.setIntentStatus(tx, intent, 'RECONCILIATION_REQUIRED');
      return result('RECONCILIATION_REQUIRED', payload.eventId, intent.organization_id);
    }

    const reference = creditReference(payload.eventId);
    // The unique index on (organization_id, payment_intent_id) is the real
    // one-credit guard. Query by that key so a second event for the same intent
    // returns a reconciliation outcome instead of tripping the index mid-flight.
    const [credit] = await tx.$queryRaw<WalletCreditRow[]>`
      SELECT id::text, amount_minor::text, reference::text FROM wallet_entries
      WHERE organization_id = ${intent.organization_id}::uuid
        AND payment_intent_id = ${intent.id}::uuid`;

    if (credit) {
      if (credit.amount_minor !== intent.amount_minor || credit.reference !== reference) {
        await this.writeEvent(
          tx,
          event,
          payload,
          fingerprint,
          'RECONCILIATION_REQUIRED',
          intent.organization_id,
          intent.id,
        );
        return result('RECONCILIATION_REQUIRED', payload.eventId, intent.organization_id);
      }
      await this.writeEvent(
        tx,
        event,
        payload,
        fingerprint,
        'ALREADY_RECONCILED',
        intent.organization_id,
        intent.id,
      );
      return result('ALREADY_RECONCILED', payload.eventId, intent.organization_id, credit.id);
    }

    if (intent.status === 'SUCCEEDED' || intent.status === 'FAILED' || intent.status === 'EXPIRED') {
      const status = intent.status === 'SUCCEEDED' ? 'RECONCILIATION_REQUIRED' : 'REJECTED';
      await this.writeEvent(
        tx,
        event,
        payload,
        fingerprint,
        status,
        intent.organization_id,
        intent.id,
      );
      return result(status, payload.eventId, intent.organization_id);
    }

    if (payload.status !== 'SUCCESS') {
      const status = payload.status === 'FAILED' ? 'REJECTED' : 'RECONCILIATION_REQUIRED';
      await this.writeEvent(
        tx,
        event,
        payload,
        fingerprint,
        payload.status,
        intent.organization_id,
        intent.id,
      );
      await this.setIntentStatus(
        tx,
        intent,
        payload.status === 'FAILED' ? 'FAILED' : 'VERIFYING',
      );
      return result(status, payload.eventId, intent.organization_id);
    }

    await this.writeEvent(
      tx,
      event,
      payload,
      fingerprint,
      'SUCCESS',
      intent.organization_id,
      intent.id,
    );

    const [next] = await tx.$queryRaw<Array<{ attempt_no: number }>>`
      SELECT COALESCE(MAX(attempt_no), 0) + 1 AS attempt_no
      FROM payment_attempts
      WHERE organization_id = ${intent.organization_id}::uuid
        AND payment_intent_id = ${intent.id}::uuid`;
    await tx.$executeRaw`
      INSERT INTO payment_attempts (
        id, payment_intent_id, organization_id, attempt_no, provider, environment,
        provider_reference, status, request_fingerprint, created_at, completed_at
      )
      VALUES (
        ${randomUUID()}::uuid, ${intent.id}::uuid, ${intent.organization_id}::uuid,
        ${next?.attempt_no ?? 1}, ${SYNTHETIC_PROVIDER}, ${SYNTHETIC_ENVIRONMENT},
        ${payload.providerReference}, 'SUCCEEDED', ${fingerprint},
        CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
      )`;

    const walletEntryId = randomUUID();
    await tx.$executeRaw`
      INSERT INTO wallet_entries (
        organization_id, id, amount_minor, currency, reference, description, payment_intent_id
      )
      VALUES (
        ${intent.organization_id}::uuid, ${walletEntryId}::uuid,
        ${intent.amount_minor}::bigint, 'UGX', ${reference},
        'Synthetic sandbox top-up credit', ${intent.id}::uuid
      )`;
    await this.setIntentStatus(tx, intent, 'SUCCEEDED');

    return result('CREDITED', payload.eventId, intent.organization_id, walletEntryId);
  }

  private async findEvent(
    tx: TopUpSql,
    eventId: string,
  ): Promise<readonly StoredEventRow[]> {
    return tx.$queryRaw<StoredEventRow[]>`
      SELECT id::text, verified, status,
        organization_id::text, payment_intent_id::text, payload_redacted
      FROM payment_provider_events
      WHERE provider = ${SYNTHETIC_PROVIDER}
        AND environment = ${SYNTHETIC_ENVIRONMENT}
        AND provider_event_id = ${eventId}`;
  }

  private async writeEvent(
    tx: TopUpSql,
    existing: StoredEventRow | undefined,
    payload: SyntheticCallbackPayload,
    fingerprint: string,
    status: string,
    organizationId: string | null,
    paymentIntentId: string | null,
  ): Promise<void> {
    const encoded = JSON.stringify(redactedEvent(payload, fingerprint));
    if (existing) {
      await tx.$executeRaw`
        UPDATE payment_provider_events
        SET verified = TRUE, status = ${status},
          organization_id = ${organizationId}::uuid,
          payment_intent_id = ${paymentIntentId}::uuid,
          payload_redacted = ${encoded}::jsonb
        WHERE id = ${existing.id}::uuid`;
      return;
    }
    await tx.$executeRaw`
      INSERT INTO payment_provider_events (
        id, provider, environment, provider_event_id, status, verified,
        organization_id, payment_intent_id, payload_redacted, received_at
      )
      VALUES (
        ${randomUUID()}::uuid, ${SYNTHETIC_PROVIDER}, ${SYNTHETIC_ENVIRONMENT},
        ${payload.eventId}, ${status}, TRUE,
        ${organizationId}::uuid, ${paymentIntentId}::uuid,
        ${encoded}::jsonb, CURRENT_TIMESTAMP
      )`;
  }

  private async setIntentStatus(
    tx: TopUpSql,
    intent: IntentRow,
    status: string,
  ): Promise<void> {
    // The trusted provider reference is part of the intent's original identity.
    // Reconciliation only advances its lifecycle state; it never rewrites that
    // binding, which is what future replays and audits resolve against.
    await tx.$executeRaw`
      UPDATE payment_intents
      SET status = ${status}, updated_at = CURRENT_TIMESTAMP
      WHERE organization_id = ${intent.organization_id}::uuid AND id = ${intent.id}::uuid`;
  }
}
