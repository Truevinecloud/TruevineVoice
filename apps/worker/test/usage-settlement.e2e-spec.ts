import { randomBytes, randomUUID } from 'node:crypto';

import type { CallSql } from '@truevine/telephony';
import {
  bindCallbackSession,
  CALLBACK_SOURCES,
  CallbackReceipts,
  recordCallEvent,
} from '@truevine/telephony';
import type { PrismaClient } from '@truevine/database';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { UsageSettlement } from '../src/usage-settlement/usage-settlement.js';
import { createW402Fixtures } from './helpers/w402-fixtures.js';
import { createW501TestDatabaseClient } from './helpers/w5-01-test-database.js';

type ReceiptState = 'COMPLETED' | 'RINGING';

interface Scenario {
  readonly organizationId: string;
  readonly attemptId: string;
  readonly session: string;
  readonly eventKey: string;
  readonly receiptId: string;
  readonly debitReference: string;
}

interface ScenarioOptions {
  readonly balanceMinor?: string;
  readonly receiptState?: ReceiptState;
}

interface LedgerRow {
  readonly amount_minor: string;
  readonly reference: string;
}

interface UsageRow {
  readonly customer_charge_minor: string;
  readonly provider_cost_minor: string | null;
  readonly provider_cost_currency: string | null;
  readonly pricing_version: string;
  readonly state: string;
  readonly receipt_event_key: string;
  readonly billed_seconds: number;
  readonly rate_per_second_minor: string;
}

let db: PrismaClient;
let receipts: CallbackReceipts;
const settlement = new UsageSettlement();

beforeAll(async () => {
  db = await createW501TestDatabaseClient();
  receipts = new CallbackReceipts(db, { settlement });
});

afterAll(async () => {
  await db?.$disconnect();
});

async function readUsage(organizationId: string) {
  const ledger = await db.$queryRaw<LedgerRow[]>`
    SELECT amount_minor::text, reference FROM wallet_entries
    WHERE organization_id = ${organizationId}::uuid ORDER BY created_at, id`;
  const usage = await db.$queryRaw<UsageRow[]>`
    SELECT customer_charge_minor::text, provider_cost_minor::text, provider_cost_currency,
      pricing_version, state::text, receipt_event_key, billed_seconds,
      rate_per_second_minor::text
    FROM voice_usage_events
    WHERE organization_id = ${organizationId}::uuid ORDER BY created_at, id`;
  return {
    debits: ledger.filter((row) => row.reference.startsWith('voice-usage:')),
    credits: ledger.filter((row) => row.reference.startsWith('voice-usage-reversal:')),
    usage,
  };
}

async function receiptOutcome(receiptId: string): Promise<string | null> {
  const [row] = await db.$queryRaw<Array<{ outcome: string | null }>>`
    SELECT outcome FROM voice_callback_receipts WHERE id = ${receiptId}::uuid`;
  return row?.outcome ?? null;
}

async function receive(session: string, eventKey: string, state: ReceiptState) {
  await receipts.receive({
    source: CALLBACK_SOURCES.synthetic,
    sessionId: session,
    eventKey,
    state,
    receivedAt: new Date(),
    occurredAt: new Date(),
  });
  const [row] = await db.$queryRaw<Array<{ id: string }>>`
    SELECT id::text FROM voice_callback_receipts
    WHERE source = ${CALLBACK_SOURCES.synthetic} AND event_key = ${eventKey}`;
  if (!row) throw new Error('Synthetic receipt was not persisted.');
  return row.id;
}

async function scenario(options: ScenarioOptions = {}): Promise<Scenario> {
  const state = options.receiptState ?? 'COMPLETED';
  const graph = await createW402Fixtures(db);
  const attempt = await db.callAttempt.create({
    data: {
      organizationId: graph.organizationId,
      campaignId: graph.campaignId,
      executionId: graph.executionId,
      recipientId: graph.recipientId,
      destination: '+12025550123',
      attemptNumber: 1,
    },
  });

  // The call attempt table only accepts QUEUED rows. Advance through the real
  // state machine before delivering the callback that triggers settlement.
  for (const setupState of ['DIALING', 'RINGING', ...(state === 'COMPLETED' ? ['ANSWERED'] : [])]) {
    await db.$transaction((tx) =>
      recordCallEvent(tx, {
        organizationId: graph.organizationId,
        attemptId: attempt.id,
        eventKey: `w501-setup-${randomUUID()}`,
        state: setupState as 'DIALING' | 'RINGING' | 'ANSWERED',
        occurredAt: new Date(),
      }),
    );
  }

  const session = `session-${randomUUID()}`;
  const eventKey = randomBytes(32).toString('hex');
  const debitReference = `voice-usage:${graph.organizationId}:${eventKey}`;

  await db.$transaction((tx) =>
    bindCallbackSession(
      tx as unknown as CallSql,
      CALLBACK_SOURCES.synthetic,
      session,
      graph.organizationId,
      attempt.id,
    ),
  );
  await db.walletEntry.create({
    data: {
      organizationId: graph.organizationId,
      amountMinor: BigInt(options.balanceMinor ?? '100000'),
      currency: 'UGX',
      reference: `w501-credit-${randomUUID()}`,
      description: 'W5-01 synthetic credit',
    },
  });
  await db.$transaction((tx) =>
    settlement.quote(tx as unknown as CallSql, {
      organizationId: graph.organizationId,
      attemptId: attempt.id,
      source: CALLBACK_SOURCES.synthetic,
      sessionId: session,
      billedSeconds: 50,
      ratePerSecondMinor: '5',
      customerChargeMinor: '250',
      providerCostMinor: '900',
      providerCostCurrency: 'UGX',
      pricingVersion: 'w501-test-v1',
    }),
  );

  return {
    organizationId: graph.organizationId,
    attemptId: attempt.id,
    session,
    eventKey,
    receiptId: await receive(session, eventKey, state),
    debitReference,
  };
}

describe('W5-01 usage settlement on isolated PostgreSQL', () => {
  it('debits the exact customer charge once and preserves provider cost as evidence', async () => {
    const s = await scenario();
    await receipts.process(s.receiptId);

    // An exact provider/callback replay reuses the durable receipt.
    await receive(s.session, s.eventKey, 'COMPLETED');
    await receipts.process(s.receiptId);

    expect(await receiptOutcome(s.receiptId)).toBe('APPLIED:SETTLED');
    const { debits, usage } = await readUsage(s.organizationId);
    expect(debits).toHaveLength(1);
    expect(debits[0]).toMatchObject({
      amount_minor: '-250',
      reference: s.debitReference,
    });
    expect(usage).toEqual([
      expect.objectContaining({
        customer_charge_minor: '250',
        provider_cost_minor: '900',
        provider_cost_currency: 'UGX',
        pricing_version: 'w501-test-v1',
        state: 'COMPLETED',
        receipt_event_key: s.eventKey,
        billed_seconds: 50,
        rate_per_second_minor: '5',
      }),
    ]);
  });

  it('does not double-charge a duplicate callback with a different event key', async () => {
    const s = await scenario();
    await receipts.process(s.receiptId);

    const duplicateKey = randomBytes(32).toString('hex');
    const duplicateReceipt = await receive(s.session, duplicateKey, 'COMPLETED');
    await receipts.process(duplicateReceipt);

    const { debits, usage } = await readUsage(s.organizationId);
    expect(debits).toHaveLength(1);
    expect(usage).toHaveLength(1);
  });

  it('allows one debit when the same receipt is processed concurrently', async () => {
    const s = await scenario();
    await Promise.all([receipts.process(s.receiptId), receipts.process(s.receiptId)]);

    const { debits, usage } = await readUsage(s.organizationId);
    expect(debits).toHaveLength(1);
    expect(usage).toHaveLength(1);
  });

  it('treats non-completed callbacks as unbillable', async () => {
    const s = await scenario({ receiptState: 'RINGING' });
    await receipts.process(s.receiptId);

    expect(await receiptOutcome(s.receiptId)).toBe('DUPLICATE:UNBILLABLE');
    const { debits, usage } = await readUsage(s.organizationId);
    expect(debits).toHaveLength(0);
    expect(usage).toHaveLength(0);
  });

  it('refuses a debit that would overdraw the wallet', async () => {
    const s = await scenario({ balanceMinor: '100' });
    await receipts.process(s.receiptId);

    expect(await receiptOutcome(s.receiptId)).toBe('APPLIED:INSUFFICIENT_FUNDS');
    const { debits, usage } = await readUsage(s.organizationId);
    expect(debits).toHaveLength(0);
    expect(usage).toHaveLength(0);
  });

  it('does not let another tenant reuse a trusted quote or receipt identity', async () => {
    const charged = await scenario();
    await receipts.process(charged.receiptId);

    const other = await scenario();
    await db.$transaction((tx) =>
      settlement.settle(tx as unknown as CallSql, {
        organizationId: other.organizationId,
        attemptId: charged.attemptId,
        source: CALLBACK_SOURCES.synthetic,
        sessionId: charged.session,
        eventKey: charged.eventKey,
        state: 'COMPLETED',
        occurredAt: new Date(),
      }),
    );

    const first = await readUsage(charged.organizationId);
    const second = await readUsage(other.organizationId);
    expect(first.debits).toHaveLength(1);
    expect(second.debits).toHaveLength(0);
    expect(second.usage).toHaveLength(0);
  });

  it('preserves append-only history and adds a compensating reversal entry', async () => {
    const s = await scenario();
    await receipts.process(s.receiptId);
    const before = (await readUsage(s.organizationId)).usage;

    await expect(db.$executeRaw`
      UPDATE voice_usage_events SET billed_seconds = 1
      WHERE organization_id = ${s.organizationId}::uuid`).rejects.toThrow(/append-only/);
    await expect(db.$executeRaw`
      DELETE FROM wallet_entries
      WHERE organization_id = ${s.organizationId}::uuid AND reference = ${s.debitReference}`
    ).rejects.toThrow(/append-only/);

    await db.$transaction((tx) =>
      settlement.reverse(tx as unknown as CallSql, {
        organizationId: s.organizationId,
        eventKey: s.eventKey,
        reason: 'Verified synthetic correction',
      }),
    );
    await expect(
      db.$transaction((tx) =>
        settlement.reverse(tx as unknown as CallSql, {
          organizationId: s.organizationId,
          eventKey: s.eventKey,
          reason: 'Verified synthetic correction',
        }),
      ),
    ).resolves.toBe('ALREADY_REVERSED');

    const after = await readUsage(s.organizationId);
    expect(after.usage).toEqual(before);
    expect(after.debits).toHaveLength(1);
    expect(after.credits).toEqual([
      expect.objectContaining({ amount_minor: '250' }),
    ]);
    const reversals = await db.$queryRaw<Array<{ reason: string }>>`
      SELECT reason FROM voice_usage_reversals WHERE organization_id = ${s.organizationId}::uuid`;
    expect(reversals).toEqual([{ reason: 'Verified synthetic correction' }]);
  });
});
