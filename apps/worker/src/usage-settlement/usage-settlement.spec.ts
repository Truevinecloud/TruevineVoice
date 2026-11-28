import type { CallSql } from '@truevine/telephony';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { UsageSettlement, type UsageQuoteInput } from './usage-settlement.js';

const org = '00000000-0000-4000-8000-000000000001';
const attempt = '00000000-0000-4000-8000-000000000002';
const quoteId = '00000000-0000-4000-8000-000000000003';
const key = 'a'.repeat(64);
const occurredAt = new Date('2026-11-23T10:00:00Z');

interface FixtureOptions {
  readonly quote?: unknown[] | null;
  readonly existing?: unknown[];
  readonly balance?: string;
  readonly reversal?: unknown[];
  readonly reversalEvent?: unknown[];
}

function fixture(options: FixtureOptions = {}) {
  const query = vi.fn(async (sql: TemplateStringsArray, ..._values: unknown[]) => {
    const statement = sql.join('?');
    if (statement.includes('pg_advisory_xact_lock')) return [1];
    if (statement.includes('FROM voice_usage_reversals')) return options.reversal ?? [];
    if (statement.includes('FROM voice_usage_events'))
      return options.reversalEvent ?? options.existing ?? [];
    if (statement.includes('FROM voice_usage_quotes')) return options.quote ?? [];
    if (statement.includes('FROM wallet_entries')) return [{ balance: options.balance ?? '1000' }];
    return [];
  });
  const execute = vi.fn(async (_sql: TemplateStringsArray, ..._values: unknown[]) => 1);
  const tx = { $queryRaw: query, $executeRaw: execute } as unknown as CallSql;
  return { tx, query, execute, settlement: new UsageSettlement() };
}

function quote(overrides: Partial<UsageQuoteInput> = {}): UsageQuoteInput {
  return {
    organizationId: org,
    attemptId: attempt,
    source: 'synthetic',
    sessionId: 'session-1',
    billedSeconds: 50,
    ratePerSecondMinor: '5',
    customerChargeMinor: '250',
    providerCostMinor: '900',
    providerCostCurrency: 'UGX',
    pricingVersion: 'test-v1',
    ...overrides,
  };
}

function settleInput(overrides: Record<string, unknown> = {}) {
  return {
    organizationId: org,
    attemptId: attempt,
    source: 'synthetic',
    sessionId: 'session-1',
    eventKey: key,
    state: 'COMPLETED',
    occurredAt,
    ...overrides,
  };
}

describe('W5-01 usage settlement', () => {
  beforeEach(() => vi.clearAllMocks());

  it('stores an exact rating decision only when the formula and binding hold', async () => {
    const { tx, execute, settlement } = fixture();
    const id = await settlement.quote(tx, quote());
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    expect(execute).toHaveBeenCalledOnce();
    const call = execute.mock.calls[0]!;
    expect(call[0].join('?')).toContain('INSERT INTO voice_usage_quotes');
    expect(call[0].join('?')).toContain('FROM voice_callback_bindings');
    expect(call[6]).toBe(50);
    expect(call[7]).toBe('5');
    expect(call[8]).toBe('250');
    expect(call[9]).toBe('900');
  });

  it.each([
    { customerChargeMinor: '1.5', providerCostMinor: '900' },
    { customerChargeMinor: '251' },
    { ratePerSecondMinor: '0' },
    { billedSeconds: 0 },
    { providerCostMinor: '900', providerCostCurrency: null },
  ])('refuses an unbounded or inconsistent quote %j', async (overrides) => {
    const { tx, execute, settlement } = fixture();
    await expect(settlement.quote(tx, quote(overrides))).rejects.toThrow(
      'usage_settlement_invalid_request',
    );
    expect(execute).not.toHaveBeenCalled();
  });

  it('debits the customer charge once and keeps provider cost as evidence', async () => {
    const { tx, execute, settlement } = fixture({
      quote: [
        {
          id: quoteId,
          attempt_id: attempt,
          billed_seconds: 50,
          rate_per_second_minor: '5',
          customer_charge_minor: '250',
          provider_cost_minor: '900',
          provider_cost_currency: 'UGX',
          pricing_version: 'test-v1',
        },
      ],
    });
    await expect(settlement.settle(tx, settleInput())).resolves.toBe('SETTLED');
    expect(execute).toHaveBeenCalledTimes(3);
    expect(execute.mock.calls[0]?.[0].join('?')).toContain('INSERT INTO wallet_entries');
    expect(execute.mock.calls[0]?.[3]).toBe('250');
    expect(execute.mock.calls[1]?.[0].join('?')).toContain('INSERT INTO voice_usage_events');
    expect(execute.mock.calls[1]?.[11]).toBe('250');
    expect(execute.mock.calls[1]?.[12]).toBe('900');
    expect(execute.mock.calls[2]?.[0].join('?')).toContain('UPDATE campaign_dispatch_reservations');
    expect(execute.mock.calls[2]?.[0].join('?')).toContain("SET state = 'SETTLED'");
  });

  it('replays an existing usage event without another wallet write', async () => {
    const { tx, execute, settlement } = fixture({
      existing: [
        {
          organization_id: org,
          attempt_id: attempt,
          source: 'synthetic',
          session_id: 'session-1',
        },
      ],
    });
    await expect(settlement.settle(tx, settleInput())).resolves.toBe('SETTLED');
    expect(execute).not.toHaveBeenCalled();
  });

  it('refuses to replay an event whose trusted identity changed', async () => {
    const { tx, settlement } = fixture({
      existing: [
        {
          organization_id: org,
          attempt_id: attempt,
          source: 'fake',
          session_id: 'session-1',
        },
      ],
    });
    await expect(settlement.settle(tx, settleInput())).rejects.toThrow(
      'usage_settlement_conflict',
    );
  });

  it('treats every non-completed callback state as unbillable before any database work', async () => {
    const { tx, query, execute, settlement } = fixture();
    await expect(settlement.settle(tx, settleInput({ state: 'ANSWERED' }))).resolves.toBe(
      'UNBILLABLE',
    );
    expect(query).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });

  it('does not debit when no trusted usage quote exists', async () => {
    const { tx, execute, settlement } = fixture();
    await expect(settlement.settle(tx, settleInput())).resolves.toBe('NO_QUOTE');
    expect(execute).not.toHaveBeenCalled();
  });

  it('does not create a negative wallet balance', async () => {
    const { tx, execute, settlement } = fixture({
      balance: '100',
      quote: [
        {
          id: quoteId,
          attempt_id: attempt,
          billed_seconds: 50,
          rate_per_second_minor: '5',
          customer_charge_minor: '250',
          provider_cost_minor: null,
          provider_cost_currency: null,
          pricing_version: 'test-v1',
        },
      ],
    });
    await expect(settlement.settle(tx, settleInput())).resolves.toBe('INSUFFICIENT_FUNDS');
    expect(execute).not.toHaveBeenCalled();
  });

  it('appends a compensating entry and immutable reversal evidence once', async () => {
    const { tx, execute, settlement } = fixture({
      reversalEvent: [{ id: '00000000-0000-4000-8000-000000000004', customer_charge_minor: '250' }],
    });
    const input = { organizationId: org, eventKey: key, reason: 'Verified correction' };
    await expect(settlement.reverse(tx, input)).resolves.toBe('REVERSED');
    expect(execute).toHaveBeenCalledTimes(2);
    expect(execute.mock.calls[0]?.[3]).toBe('250');
    expect(execute.mock.calls[1]?.[0].join('?')).toContain('INSERT INTO voice_usage_reversals');

    const replay = fixture({ reversal: [{ id: 'reversal-1' }] });
    await expect(replay.settlement.reverse(replay.tx, input)).resolves.toBe('ALREADY_REVERSED');
    expect(replay.execute).not.toHaveBeenCalled();
  });

  it('rejects malformed trusted input before touching the database', async () => {
    const { tx, query, execute, settlement } = fixture();
    await expect(settlement.settle(tx, settleInput({ eventKey: 'not-a-hash' }))).rejects.toThrow(
      'usage_settlement_invalid_request',
    );
    await expect(settlement.reverse(tx, { organizationId: org, eventKey: key, reason: 'x' }))
      .rejects.toThrow('usage_settlement_invalid_request');
    expect(query).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });
});
