import { randomUUID } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  parseSyntheticCallback,
  signSyntheticCallback,
  SYNTHETIC_ENVIRONMENT,
  SYNTHETIC_PROVIDER,
  TopUpReconciliation,
  verifySyntheticCallback,
  type SyntheticCallbackPayload,
  type TopUpDatabase,
  type TopUpSql,
} from './top-up-reconciliation.js';

const KEY = 'test-only-synthetic-verification-key-0123456789';
const ORG = '00000000-0000-4000-8000-000000000001';
const INTENT = '00000000-0000-4000-8000-000000000002';

interface FakeEvent {
  id: string;
  status: string;
  verified: boolean;
  organization_id: string | null;
  payment_intent_id: string | null;
  payload_redacted: unknown;
}

interface FakeIntent {
  id: string;
  organization_id: string;
  amount_minor: string;
  currency: string;
  status: string;
  purpose: string;
  provider: string;
  environment: string;
  provider_reference: string;
}

interface FakeCredit {
  id: string;
  organization_id: string;
  payment_intent_id: string;
  amount_minor: string;
  reference: string;
}

class FakeTopUpDatabase implements TopUpDatabase {
  readonly events: FakeEvent[] = [];
  readonly wallet: FakeCredit[] = [];
  readonly attempts: string[] = [];
  readonly executed: string[] = [];
  intents: FakeIntent[] = [];

  async $queryRaw<T = unknown>(sql: TemplateStringsArray, ...values: unknown[]): Promise<T> {
    const statement = sql.join('?');
    if (statement.includes('pg_advisory_xact_lock')) return [1] as T;
    if (statement.includes('FROM payment_provider_events')) {
      const [provider, environment, eventId] = values as [string, string, string];
      return this.events.filter(
        (event) =>
          (this.eventPayload(event)?.provider ?? null) === provider &&
          (this.eventPayload(event)?.environment ?? null) === environment &&
          this.eventPayload(event)?.eventId === eventId,
      ) as T;
    }
    if (statement.includes('FROM payment_intents')) {
      const [provider, environment, providerReference] = values as [string, string, string];
      return this.intents.filter(
        (intent) =>
          intent.provider === provider &&
          intent.environment === environment &&
          intent.provider_reference === providerReference,
      ) as T;
    }
    if (statement.includes('FROM wallet_entries')) {
      const [organizationId, paymentIntentId] = values as [string, string];
      return this.wallet.filter(
        (entry) =>
          entry.organization_id === organizationId && entry.payment_intent_id === paymentIntentId,
      ) as T;
    }
    if (statement.includes('COALESCE(MAX(attempt_no)')) {
      return [{ attempt_no: this.attempts.length + 1 }] as T;
    }
    return [] as T;
  }

  async $executeRaw(sql: TemplateStringsArray, ...values: unknown[]): Promise<number> {
    const statement = sql.join('?');
    this.executed.push(statement);
    if (statement.includes('INSERT INTO payment_provider_events')) {
      const [id] = values as [string];
      const verified = !statement.includes('FALSE');
      const status = verified ? (values[4] as string) : 'UNVERIFIED';
      const organizationId = verified ? (values[5] as string | null) : null;
      const paymentIntentId = verified ? (values[6] as string | null) : null;
      const payload = values.find(
        (value) => typeof value === 'string' && value.trimStart().startsWith('{'),
      );
      if (typeof payload !== 'string') throw new Error('event payload was not captured');
      this.events.push({
        id,
        status,
        verified,
        organization_id: organizationId,
        payment_intent_id: paymentIntentId,
        payload_redacted: JSON.parse(payload) as unknown,
      });
      return 1;
    }
    if (statement.includes('UPDATE payment_provider_events')) {
      const [status, organizationId, paymentIntentId, payload, id] = values as [
        string,
        string | null,
        string | null,
        string,
        string,
      ];
      const event = this.events.find((candidate) => candidate.id === id);
      if (event) {
        event.status = status;
        event.verified = true;
        event.organization_id = organizationId;
        event.payment_intent_id = paymentIntentId;
        event.payload_redacted = JSON.parse(payload) as unknown;
      }
      return 1;
    }
    if (statement.includes('INSERT INTO wallet_entries')) {
      const [organizationId, id, amountMinor, reference, paymentIntentId] = values as [
        string,
        string,
        string,
        string,
        string,
      ];
      this.wallet.push({
        id,
        organization_id: organizationId,
        payment_intent_id: paymentIntentId,
        amount_minor: amountMinor,
        reference,
      });
      return 1;
    }
    if (statement.includes('INSERT INTO payment_attempts')) this.attempts.push(randomUUID());
    if (statement.includes('UPDATE payment_intents')) {
      const [status, organizationId, id] = values as [string, string, string];
      const intent = this.intents.find(
        (candidate) => candidate.organization_id === organizationId && candidate.id === id,
      );
      if (intent) intent.status = status;
    }
    return 1;
  }

  async $transaction<T>(body: (tx: TopUpSql) => Promise<T>): Promise<T> {
    return body(this);
  }

  private eventPayload(event: FakeEvent): SyntheticCallbackPayload | null {
    const value = event.payload_redacted as Partial<SyntheticCallbackPayload> | null;
    if (
      value === null ||
      typeof value !== 'object' ||
      typeof value.eventId !== 'string' ||
      typeof value.provider !== 'string'
    )
      return null;
    return value as SyntheticCallbackPayload;
  }
}

function payload(overrides: Partial<SyntheticCallbackPayload> = {}): SyntheticCallbackPayload {
  return {
    provider: SYNTHETIC_PROVIDER,
    environment: SYNTHETIC_ENVIRONMENT,
    eventId: `evt-${randomUUID()}`,
    providerReference: `ref-${randomUUID()}`,
    status: 'SUCCESS',
    amountMinor: '5000',
    currency: 'UGX',
    ...overrides,
  };
}

function signed(overrides: Partial<SyntheticCallbackPayload> = {}) {
  const body = payload(overrides);
  return { ...body, signature: signSyntheticCallback(body, KEY) };
}

function fixture(amountMinor = '5000') {
  const db = new FakeTopUpDatabase();
  const body = payload({ amountMinor });
  db.intents.push({
    id: INTENT,
    organization_id: ORG,
    amount_minor: amountMinor,
    currency: 'UGX',
    status: 'PENDING',
    purpose: 'WALLET_TOP_UP',
    provider: SYNTHETIC_PROVIDER,
    environment: SYNTHETIC_ENVIRONMENT,
    provider_reference: body.providerReference,
  });
  return { db, body, service: new TopUpReconciliation(db, KEY) };
}

describe('synthetic top-up callback verification', () => {
  it('verifies a correctly signed synthetic callback', () => {
    const callback = signed();
    expect(verifySyntheticCallback(parseSyntheticCallback(callback), KEY)).toBe(true);
  });

  it('fails closed for a tampered amount or signature', () => {
    const callback = signed();
    expect(verifySyntheticCallback(parseSyntheticCallback({ ...callback, amountMinor: '5001' }), KEY)).toBe(false);
    expect(verifySyntheticCallback(parseSyntheticCallback({ ...callback, signature: '0'.repeat(64) }), KEY)).toBe(false);
  });

  it('refuses malformed payloads and callback amounts', () => {
    expect(() => parseSyntheticCallback({ ...signed(), amountMinor: 5000 })).toThrow();
    expect(() => parseSyntheticCallback({ ...signed(), currency: 'USD' })).toThrow();
    expect(() => parseSyntheticCallback({ ...signed(), status: 'UNKNOWN' })).toThrow();
  });
});

describe('TopUpReconciliation decision contract', () => {
  it('records the event and credits the exact intent amount once', async () => {
    const { db, body, service } = fixture();
    const result = await service.receive(signed(body));

    expect(result).toMatchObject({
      outcome: 'CREDITED',
      organizationId: ORG,
      walletEntryId: expect.any(String),
    });
    expect(db.events).toHaveLength(1);
    expect(db.events[0]).toMatchObject({ verified: true, status: 'SUCCESS' });
    expect(db.wallet).toEqual([
      expect.objectContaining({
        organization_id: ORG,
        amount_minor: '5000',
        reference: `payment-topup:${SYNTHETIC_PROVIDER}:${body.eventId}`,
      }),
    ]);
    expect(db.executed.findIndex((sql) => sql.includes('INSERT INTO payment_provider_events'))).toBeLessThan(
      db.executed.findIndex((sql) => sql.includes('INSERT INTO wallet_entries')),
    );
  });

  it('treats an exact replay as already reconciled without a second credit', async () => {
    const { db, body, service } = fixture();
    const callback = signed(body);
    expect((await service.receive(callback)).outcome).toBe('CREDITED');
    expect((await service.receive(callback)).outcome).toBe('ALREADY_RECONCILED');
    expect(db.wallet).toHaveLength(1);
  });

  it('records an unverified callback without crediting the wallet', async () => {
    const { db, body, service } = fixture();
    const result = await service.receive({ ...signed(body), signature: 'f'.repeat(64) });

    expect(result.outcome).toBe('UNVERIFIED');
    expect(db.events[0]).toMatchObject({ verified: false, status: 'UNVERIFIED' });
    expect(db.wallet).toHaveLength(0);
  });

  it('requires reconciliation when the callback amount differs from the intent', async () => {
    const { db, body, service } = fixture();
    const result = await service.receive(signed({ ...body, amountMinor: '6000' }));

    expect(result.outcome).toBe('RECONCILIATION_REQUIRED');
    expect(db.intents[0]?.status).toBe('RECONCILIATION_REQUIRED');
    expect(db.wallet).toHaveLength(0);
  });

  it('credits a stored verified event through the reconciliation path', async () => {
    const { db, body, service } = fixture();
    await service.receive(signed(body));
    db.wallet.length = 0;
    db.intents[0]!.status = 'VERIFYING';

    const result = await service.reconcile(body.eventId);
    expect(result.outcome).toBe('CREDITED');
    expect(db.wallet).toHaveLength(1);
  });

  it('refuses a second event for an intent that is already credited', async () => {
    const { db, body, service } = fixture();
    expect((await service.receive(signed(body))).outcome).toBe('CREDITED');

    const second = signed({ ...body, eventId: 'evt-second' });
    const result = await service.receive(second);

    expect(result.outcome).toBe('RECONCILIATION_REQUIRED');
    expect(db.wallet).toHaveLength(1);
    expect(db.events).toHaveLength(2);
    expect(db.events[1]).toMatchObject({ status: 'RECONCILIATION_REQUIRED', verified: true });
  });

  it('fails closed when one provider reference resolves to multiple intents', async () => {
    const { db, body, service } = fixture();
    db.intents.push({ ...db.intents[0]!, id: randomUUID() });

    const result = await service.receive(signed(body));

    expect(result.outcome).toBe('RECONCILIATION_REQUIRED');
    expect(db.wallet).toHaveLength(0);
    expect(db.events[0]).toMatchObject({ status: 'RECONCILIATION_REQUIRED' });
  });

  it('refuses identifiers long enough to overflow ledger reference columns', () => {
    expect(() => parseSyntheticCallback(signed({ eventId: 'e'.repeat(121) }))).toThrow();
  });
});
