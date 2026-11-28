import { randomUUID } from 'node:crypto';

import { CALL_TRANSITIONS, type CallState } from '@truevine/domain';

import { CallPersistenceError, fingerprint, uuid } from './call-contract.js';
import { recordCallEvent, type CallDatabase, type CallSql } from './call-event-persistence.js';
import { CALLBACK_SOURCES, parseCallbackSource } from './callback-sources.js';
import type { CallEvent } from './voice.port.js';

interface Receipt {
  source: string;
  session_id: string;
  event_key: string;
  requested_state: CallState;
  occurred_at: Date;
}

interface Binding {
  organization_id: string;
  attempt_id: string;
}

function opaque(value: string, max: number): string {
  if (typeof value !== 'string' || value.length > max || !/^[A-Za-z0-9_-]+$/.test(value))
    throw new CallPersistenceError('invalid_request');
  return value;
}

/** Internal synthetic input, deliberately independent of any provider HTTP format. */
export interface SyntheticCallback {
  sessionId: string;
  state: CallState;
  occurredAt: Date;
}

/** Outcome of accepting a synthetic event into the durable receipt table. */
export interface SyntheticReceiptResult {
  readonly accepted: boolean;
  readonly reason: 'queued' | 'stale';
}

export interface ReceiveSyntheticOptions {
  /**
   * Reject events older than the latest event already persisted for the bound
   * attempt. Identity still comes only from the server-owned binding.
   */
  readonly enforceChronology?: boolean;
}

/** One normalized, already-validated callback event ready for durable intake. */
export interface DurableCallbackEvent {
  readonly source: string;
  readonly sessionId: string;
  readonly eventKey: string;
  readonly state: CallState;
  /** Time the request was accepted. Always distinct from any provider event time. */
  readonly receivedAt: Date;
  /** Ordering time: provider event time when documented, otherwise receivedAt. */
  readonly occurredAt: Date;
}

/** Trusted, already-scoped identity from the receipt's dispatch-owned binding. */
export interface CallbackSettlementInput {
  readonly source: string;
  readonly sessionId: string;
  readonly eventKey: string;
  readonly organizationId: string;
  readonly attemptId: string;
  readonly state: CallState;
  readonly occurredAt: Date;
}

/** Outcome of an optional usage settlement side effect. */
export type CallbackSettlementOutcome =
  | 'SETTLED'
  | 'UNBILLABLE'
  | 'NO_QUOTE'
  | 'INSUFFICIENT_FUNDS';

/**
 * Optional side effect supplied by the application. It is invoked inside the
 * receipt transaction, so a settlement failure rolls back call state too.
 */
export interface CallbackSettlement {
  settle(tx: CallSql, input: CallbackSettlementInput): Promise<CallbackSettlementOutcome>;
}

export interface CallbackReceiptsOptions {
  readonly settlement?: CallbackSettlement;
}

function eventKeyOf(value: string): string {
  if (!/^[a-f0-9]{64}$/.test(value)) throw new CallPersistenceError('invalid_request');
  return value;
}

function timestampOf(value: Date): Date {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime()))
    throw new CallPersistenceError('invalid_request');
  return value;
}

/** Dispatch owns the transaction and supplies trusted source and tenant keys. */
export async function bindCallbackSession(
  tx: CallSql, source: string, session: string, organizationId: string, attemptId: string,
): Promise<void> {
  const namespace = parseCallbackSource(opaque(source, 64));
  const sessionId = opaque(session, 160);
  const org = uuid(organizationId);
  const attempt = uuid(attemptId);
  await tx.$executeRaw`
    INSERT INTO voice_callback_bindings (source, session_id, organization_id, attempt_id)
    VALUES (${namespace}, ${sessionId}, ${org}::uuid, ${attempt}::uuid)
    ON CONFLICT (source, session_id) DO NOTHING`;
  const binding = await lookupBinding(tx, namespace, sessionId);
  if (binding?.organization_id !== org || binding.attempt_id !== attempt)
    throw new CallPersistenceError('idempotency_conflict');
  await tx.$executeRaw`
    UPDATE voice_callback_receipts SET next_run_at = now()
    WHERE source = ${namespace} AND session_id = ${sessionId} AND status = 'pending'`;
}

async function lookupBinding(tx: CallSql, source: string, sessionId: string) {
  const [binding] = await tx.$queryRaw<Binding[]>`
    SELECT organization_id, attempt_id FROM voice_callback_bindings
    WHERE source = ${source} AND session_id = ${sessionId}`;
  return binding;
}

export class CallbackReceipts {
  constructor(
    private readonly db: CallDatabase,
    private readonly options: CallbackReceiptsOptions = {},
  ) {}

  async receiveSynthetic(
    input: SyntheticCallback,
    options: ReceiveSyntheticOptions = {},
  ): Promise<SyntheticReceiptResult> {
    const sessionId = opaque(input.sessionId, 160);
    if (!Object.hasOwn(CALL_TRANSITIONS, input.state) ||
        !(input.occurredAt instanceof Date) || !Number.isFinite(input.occurredAt.getTime()))
      throw new CallPersistenceError('invalid_request');

    if (options.enforceChronology) {
      const binding = await lookupBinding(this.db, CALLBACK_SOURCES.synthetic, sessionId);
      if (binding) {
        const [latest] = await this.db.$queryRaw<{ occurred_at: Date }[]>`
          SELECT occurred_at FROM call_events
          WHERE organization_id=${binding.organization_id}::uuid
            AND attempt_id=${binding.attempt_id}::uuid
          ORDER BY occurred_at DESC, id DESC LIMIT 1`;
        if (latest && input.occurredAt.getTime() < new Date(latest.occurred_at).getTime())
          return { accepted: false, reason: 'stale' };
      }
    }

    const eventKey = fingerprint([
      1, CALLBACK_SOURCES.synthetic, sessionId, input.state, input.occurredAt.toISOString(),
    ]);
    const receivedAt = new Date();
    await this.receive({
      source: CALLBACK_SOURCES.synthetic,
      sessionId,
      eventKey,
      state: input.state,
      receivedAt,
      occurredAt: input.occurredAt,
    });
    return { accepted: true, reason: 'queued' };
  }

  /** Intake for an already-normalized adapter event. No provider fields enter here. */
  async receive(input: DurableCallbackEvent): Promise<void> {
    const source = parseCallbackSource(opaque(input.source, 64));
    const sessionId = opaque(input.sessionId, 160);
    const eventKey = eventKeyOf(input.eventKey);
    if (!Object.hasOwn(CALL_TRANSITIONS, input.state))
      throw new CallPersistenceError('invalid_request');
    const receivedAt = timestampOf(input.receivedAt);
    const occurredAt = timestampOf(input.occurredAt);

    await this.db.$executeRaw`
      INSERT INTO voice_callback_receipts (
        id, source, session_id, event_key, requested_state, occurred_at, received_at
      )
      VALUES (
        ${randomUUID()}::uuid, ${source}, ${sessionId}, ${eventKey},
        ${input.state}::"CallAttemptState", ${occurredAt}, ${receivedAt}
      )
      ON CONFLICT (source, event_key) DO NOTHING`;
  }

  /** Dispatch supplies both tenant keys. A session may never be rebound. */
  async bindSession(source: string, session: string, organizationId: string, attemptId: string): Promise<void> {
    await this.db.$transaction((tx) => bindCallbackSession(tx, source, session, organizationId, attemptId));
  }

  async due(): Promise<string[]> {
    const rows = await this.db.$queryRaw<{ id: string }[]>`
      SELECT id FROM voice_callback_receipts WHERE status = 'pending' AND next_run_at <= now()
      ORDER BY next_run_at, id LIMIT 100`;
    return rows.map(({ id }) => id);
  }

  async process(id: string): Promise<void> {
    const receiptId = uuid(id);
    try {
      await this.db.$transaction(async (tx) => {
        const [receipt] = await tx.$queryRaw<Receipt[]>`
          SELECT source, session_id, event_key, requested_state, occurred_at
          FROM voice_callback_receipts
          WHERE id = ${receiptId}::uuid AND status = 'pending' AND next_run_at <= now() FOR UPDATE`;
        if (!receipt) return;
        const source = parseCallbackSource(receipt.source);
        const binding = await lookupBinding(tx, source, receipt.session_id);
        if (!binding) {
          await this.retry(tx, receiptId, 'awaiting_binding');
          return;
        }
        const event: CallEvent = {
          callId: binding.attempt_id,
          providerCallId: receipt.session_id,
          state: receipt.requested_state,
          occurredAt: receipt.occurred_at,
        };
        const result = await recordCallEvent(tx, {
          organizationId: binding.organization_id,
          attemptId: event.callId,
          state: event.state,
          occurredAt: receipt.occurred_at,
          eventKey: receipt.event_key,
        });
        let settlementOutcome: CallbackSettlementOutcome | undefined;
        if (
          this.options.settlement &&
          (result.disposition === 'APPLIED' || result.disposition === 'DUPLICATE')
        ) {
          settlementOutcome = await this.options.settlement.settle(tx, {
            source,
            sessionId: receipt.session_id,
            eventKey: receipt.event_key,
            organizationId: binding.organization_id,
            attemptId: binding.attempt_id,
            state: receipt.requested_state,
            occurredAt: receipt.occurred_at,
          });
        }
        const outcome = settlementOutcome
          ? `${result.disposition}:${settlementOutcome}`
          : result.disposition;
        await tx.$executeRaw`
          UPDATE voice_callback_receipts
          SET status = 'completed', outcome = ${outcome}
          WHERE id = ${receiptId}::uuid`;
      });
    } catch (error) {
      // The original transaction has rolled back, including any call mutation.
      const outcome = error instanceof CallPersistenceError ? 'invalid_event' : 'processing_failed';
      await this.retry(this.db, receiptId, outcome);
    }
  }

  async diagnostics() {
    return this.db.$queryRaw<{ status: string; count: number }[]>`
      SELECT status, count(*)::int AS count FROM voice_callback_receipts GROUP BY status ORDER BY status`;
  }

  private async retry(tx: CallSql, id: string, outcome: string) {
    await tx.$executeRaw`
      UPDATE voice_callback_receipts SET attempts = attempts + 1,
        status = CASE WHEN attempts + 1 >= 8 THEN 'dead' ELSE 'pending' END,
        outcome = ${outcome}, next_run_at = now() + make_interval(secs => 5 * power(2, attempts))
      WHERE id = ${id}::uuid AND status = 'pending' AND next_run_at <= now()`;
  }
}
