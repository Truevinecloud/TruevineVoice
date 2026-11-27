import { randomUUID } from 'node:crypto';

import type { PrismaClient } from '@truevine/database';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  signSyntheticCallback,
  SYNTHETIC_ENVIRONMENT,
  SYNTHETIC_PROVIDER,
  TopUpReconciliation,
  type SyntheticCallbackPayload,
} from '../src/payments/top-up-reconciliation.js';
import { createW502TestDatabaseClient } from './helpers/w5-02-test-database.js';

const VERIFICATION_KEY = 'w5-02-synthetic-verification-key-not-a-secret';

interface Fixture {
  readonly organizationId: string;
  readonly intentId: string;
  readonly providerReference: string;
}

interface LedgerRow {
  readonly id: string;
  readonly amount_minor: string;
  readonly reference: string;
  readonly payment_intent_id: string | null;
}

interface EventRow {
  readonly verified: boolean;
  readonly status: string;
  readonly organization_id: string | null;
  readonly payment_intent_id: string | null;
}

let db: PrismaClient;
let service: TopUpReconciliation;

beforeAll(async () => {
  db = await createW502TestDatabaseClient();
  service = new TopUpReconciliation(
    db as unknown as ConstructorParameters<typeof TopUpReconciliation>[0],
    VERIFICATION_KEY,
  );
});

afterAll(async () => {
  await db?.$disconnect();
});

async function fixture(amountMinor = '5000'): Promise<Fixture> {
  const suffix = randomUUID();
  const user = await db.user.create({
    data: {
      id: randomUUID(),
      email: `w502-${suffix}@example.test`,
      passwordHash: 'test-hash',
    },
  });
  const organization = await db.organization.create({
    data: {
      id: randomUUID(),
      slug: `w502-${suffix}`,
      name: 'W5-02 Integration Test Org',
      memberships: {
        create: { userId: user.id, role: 'OWNER' },
      },
    },
  });
  const providerReference = `ref-${suffix}`;
  const intent = await db.paymentIntent.create({
    data: {
      organizationId: organization.id,
      purpose: 'WALLET_TOP_UP',
      amountMinor: BigInt(amountMinor),
      currency: 'UGX',
      status: 'PENDING',
      idempotencyKey: randomUUID(),
      provider: SYNTHETIC_PROVIDER,
      environment: SYNTHETIC_ENVIRONMENT,
      providerReference,
    },
  });
  return {
    organizationId: organization.id,
    intentId: intent.id,
    providerReference,
  };
}

function callback(
  graph: Fixture,
  overrides: Partial<SyntheticCallbackPayload> = {},
): SyntheticCallbackPayload {
  return {
    provider: SYNTHETIC_PROVIDER,
    environment: SYNTHETIC_ENVIRONMENT,
    eventId: `evt-${randomUUID()}`,
    providerReference: graph.providerReference,
    status: 'SUCCESS',
    amountMinor: '5000',
    currency: 'UGX',
    ...overrides,
  };
}

function signed(payload: SyntheticCallbackPayload) {
  return { ...payload, signature: signSyntheticCallback(payload, VERIFICATION_KEY) };
}

async function walletEntries(organizationId: string) {
  return db.$queryRaw<LedgerRow[]>`
    SELECT id::text, amount_minor::text, reference, payment_intent_id::text
    FROM wallet_entries
    WHERE organization_id = ${organizationId}::uuid
    ORDER BY created_at, id`;
}

async function providerEvents(eventId: string) {
  return db.$queryRaw<EventRow[]>`
    SELECT verified, status, organization_id::text, payment_intent_id::text
    FROM payment_provider_events
    WHERE provider = ${SYNTHETIC_PROVIDER}
      AND environment = ${SYNTHETIC_ENVIRONMENT}
      AND provider_event_id = ${eventId}`;
}

async function intentStatus(intentId: string) {
  const intent = await db.paymentIntent.findUniqueOrThrow({ where: { id: intentId } });
  return intent.status;
}

describe('W5-02 synthetic top-up reconciliation on isolated PostgreSQL', () => {
  it('records the verified event and credits the exact intent amount once', async () => {
    const graph = await fixture();
    const payload = callback(graph);
    const callbackBody = signed(payload);

    expect(await service.receive(callbackBody)).toMatchObject({
      outcome: 'CREDITED',
      organizationId: graph.organizationId,
    });
    expect((await service.receive(callbackBody)).outcome).toBe('ALREADY_RECONCILED');

    const entries = await walletEntries(graph.organizationId);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      amount_minor: '5000',
      reference: `payment-topup:${SYNTHETIC_PROVIDER}:${payload.eventId}`,
      payment_intent_id: graph.intentId,
    });
    expect(await intentStatus(graph.intentId)).toBe('SUCCEEDED');

    const events = await providerEvents(payload.eventId);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      verified: true,
      status: 'ALREADY_RECONCILED',
      organization_id: graph.organizationId,
      payment_intent_id: graph.intentId,
    });

    const attempts = await db.paymentAttempt.findMany({
      where: { organizationId: graph.organizationId },
    });
    expect(attempts).toHaveLength(1);
    expect(attempts[0]).toMatchObject({
      providerReference: graph.providerReference,
      status: 'SUCCEEDED',
      requestFingerprint: expect.any(String),
    });
  });

  it('records an unverified callback without touching the wallet or intent', async () => {
    const graph = await fixture();
    const payload = callback(graph);

    const result = await service.receive({ ...signed(payload), signature: '0'.repeat(64) });

    expect(result.outcome).toBe('UNVERIFIED');
    expect(await walletEntries(graph.organizationId)).toHaveLength(0);
    expect(await db.paymentAttempt.count({ where: { organizationId: graph.organizationId } })).toBe(0);
    expect((await providerEvents(payload.eventId))[0]).toMatchObject({
      verified: false,
      status: 'UNVERIFIED',
    });
    expect(await intentStatus(graph.intentId)).toBe('PENDING');
  });

  it('routes an amount mismatch to reconciliation without crediting', async () => {
    const graph = await fixture();
    const payload = callback(graph, { amountMinor: '6000' });

    expect((await service.receive(signed(payload))).outcome).toBe('RECONCILIATION_REQUIRED');

    expect(await walletEntries(graph.organizationId)).toHaveLength(0);
    expect(await db.paymentAttempt.count({ where: { organizationId: graph.organizationId } })).toBe(0);
    expect(await intentStatus(graph.intentId)).toBe('RECONCILIATION_REQUIRED');
    expect((await providerEvents(payload.eventId))[0]?.status).toBe('RECONCILIATION_REQUIRED');
  });

  it('refuses a second event for an already credited intent', async () => {
    const graph = await fixture();
    const first = callback(graph);
    expect((await service.receive(signed(first))).outcome).toBe('CREDITED');

    const second = callback(graph, { eventId: `evt-${randomUUID()}` });
    expect((await service.receive(signed(second))).outcome).toBe('RECONCILIATION_REQUIRED');

    expect(await walletEntries(graph.organizationId)).toHaveLength(1);
    expect(await db.paymentAttempt.count({ where: { organizationId: graph.organizationId } })).toBe(1);
    expect(await providerEvents(first.eventId)).toHaveLength(1);
    expect(await providerEvents(second.eventId)).toHaveLength(1);
  });

  it('preserves the append-only ledger guarantee for a top-up credit', async () => {
    const graph = await fixture();
    const payload = callback(graph);
    await service.receive(signed(payload));
    const [entry] = await walletEntries(graph.organizationId);
    if (!entry) throw new Error('Synthetic top-up credit was not persisted.');

    await expect(db.$executeRaw`
      UPDATE wallet_entries SET amount_minor = 1
      WHERE organization_id = ${graph.organizationId}::uuid AND id = ${entry.id}::uuid`)
      .rejects.toThrow(/append-only/i);
  });
});
