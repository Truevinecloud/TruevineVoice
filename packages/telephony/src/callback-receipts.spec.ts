import type { CallState } from '@truevine/domain';
import { describe, expect, it, vi } from 'vitest';

import type { CallDatabase, CallSql } from './call-event-persistence.js';
import { CALLBACK_SOURCES } from './callback-sources.js';
import {
  CallbackReceipts,
  type CallbackSettlementInput,
  type CallbackSettlementOutcome,
  type DurableCallbackEvent,
} from './callback-receipts.js';

const attemptId = '00000000-0000-4000-8000-000000000001';
const orgId = '00000000-0000-4000-8000-000000000002';
const receiptId = '00000000-0000-4000-8000-000000000003';
const occurredAt = new Date('2026-11-22T00:00:00Z');
const eventKey = 'a'.repeat(64);

interface FixtureOptions {
  readonly source?: string;
  readonly sessionId?: string;
  readonly eventKey?: string;
  readonly state?: CallState;
  readonly latestOccurredAt?: Date;
  readonly currentState?: CallState;
  readonly settlement?: {
    settle: ((tx: CallSql, input: CallbackSettlementInput) => Promise<CallbackSettlementOutcome>) &
      ReturnType<typeof vi.fn>;
  };
}

function fixture(options: FixtureOptions = {}) {
  const receipt = {
    source: options.source ?? CALLBACK_SOURCES.synthetic,
    session_id: options.sessionId ?? 'session-1',
    event_key: options.eventKey ?? 'receipt-key',
    requested_state: options.state ?? 'QUEUED',
    occurred_at: occurredAt,
  };
  const bindings: {
    source: string;
    session_id: string;
    organization_id: string;
    attempt_id: string;
  }[] = [];
  const pending = { value: true };
  const query = vi.fn(async (sql: TemplateStringsArray, ...values: unknown[]) => {
    const statement = sql.join('?');
    if (statement.includes('FROM voice_callback_receipts')) return pending.value ? [receipt] : [];
    if (statement.includes('FROM voice_callback_bindings')) {
      const [source, sessionId] = values as [string, string];
      return bindings
        .filter((binding) => binding.source === source && binding.session_id === sessionId)
        .map(({ organization_id, attempt_id }) => ({ organization_id, attempt_id }));
    }
    if (statement.includes('FROM call_attempts'))
      return [{ state: options.currentState ?? 'COMPLETED' }];
    if (statement.includes('SELECT fingerprint FROM call_events')) return [];
    if (statement.includes('FROM call_events'))
      return options.latestOccurredAt ? [{ occurred_at: options.latestOccurredAt }] : [];
    return [];
  });
  const execute = vi.fn(async (_sql: TemplateStringsArray, ..._values: unknown[]) => 1);
  const client = { $queryRaw: query, $executeRaw: execute };
  const database = {
    ...client,
    $transaction: vi.fn(async (run: (tx: typeof client) => Promise<unknown>) => run(client)),
  };
  const addBinding = (
    source: string = CALLBACK_SOURCES.synthetic,
    sessionId = 'session-1',
    organizationId = orgId,
    attemptIdValue = attemptId,
  ) => {
    bindings.push({
      source,
      session_id: sessionId,
      organization_id: organizationId,
      attempt_id: attemptIdValue,
    });
  };
  return {
    database,
    receipts: new CallbackReceipts(database as unknown as CallDatabase, {
      settlement: options.settlement,
    }),
    query,
    execute,
    bindings,
    pending,
    addBinding,
  };
}

function providerEvent(overrides: Partial<DurableCallbackEvent> = {}): DurableCallbackEvent {
  return {
    source: CALLBACK_SOURCES.africasTalking,
    sessionId: 'ATVId_abc',
    eventKey,
    state: 'RINGING',
    receivedAt: occurredAt,
    occurredAt,
    ...overrides,
  };
}

describe('internal voice callback receipts', () => {
  it('uses one deterministic unique key for concurrent synthetic duplicates', async () => {
    const { receipts, execute } = fixture();
    const event = { sessionId: 'session-1', state: 'QUEUED' as const, occurredAt };
    await Promise.all([receipts.receiveSynthetic(event), receipts.receiveSynthetic(event)]);
    const [first, second] = execute.mock.calls;
    expect(first?.[0].join('?')).toContain('ON CONFLICT (source, event_key) DO NOTHING');
    expect(first?.[4]).toEqual(second?.[4]);
    expect(first?.[1]).not.toEqual(second?.[1]);
  });

  it('rejects malformed synthetic input before writing a receipt', async () => {
    const { receipts, execute } = fixture();
    await expect(receipts.receiveSynthetic({ sessionId: '../bad', state: 'QUEUED', occurredAt }))
      .rejects.toThrow('invalid_request');
    expect(execute).not.toHaveBeenCalled();
  });

  it('rejects an unknown callback source before writing a receipt', async () => {
    const { receipts, execute } = fixture();
    await expect(receipts.receive(providerEvent({ source: 'worker' })))
      .rejects.toThrow('invalid_callback_source');
    expect(execute).not.toHaveBeenCalled();
  });

  it('persists receipt time separately from provider event time', async () => {
    const { receipts, execute } = fixture();
    const receivedAt = new Date('2026-11-23T12:00:00Z');
    const eventTime = new Date('2026-11-23T11:59:00Z');
    await receipts.receive(providerEvent({ receivedAt, occurredAt: eventTime }));
    expect(execute.mock.calls[0]?.[7]).toEqual(receivedAt);
    expect(execute.mock.calls[0]?.[6]).toEqual(eventTime);
  });

  it('defers an unresolved session with a bounded durable retry', async () => {
    const { receipts, execute } = fixture();
    await receipts.process(receiptId);
    expect(execute.mock.calls).toHaveLength(1);
    expect(execute.mock.calls[0]?.[0].join('?')).toContain("WHEN attempts + 1 >= 8 THEN 'dead'");
    expect(execute.mock.calls[0]?.[1]).toBe('awaiting_binding');
  });

  it('refuses a second tenant binding for an existing session', async () => {
    const { receipts, addBinding, execute } = fixture();
    addBinding();
    await expect(receipts.bindSession(CALLBACK_SOURCES.synthetic, 'session-1', receiptId, attemptId))
      .rejects.toThrow('idempotency_conflict');
    expect(execute).toHaveBeenCalledOnce();
  });

  it('binds the dispatch-owned attempt and wakes its earlier receipt', async () => {
    const { receipts, addBinding, execute, query } = fixture();
    await receipts.process(receiptId);
    expect(execute.mock.calls[0]?.[1]).toBe('awaiting_binding');
    execute.mockImplementationOnce(async () => {
      addBinding();
      return 1;
    });
    await receipts.bindSession(CALLBACK_SOURCES.synthetic, 'session-1', orgId, attemptId);
    expect(execute.mock.calls[1]?.slice(1)).toEqual([
      CALLBACK_SOURCES.synthetic,
      'session-1',
      orgId,
      attemptId,
    ]);
    expect(execute.mock.calls[2]?.[0].join('?')).toContain('SET next_run_at = now()');
    await receipts.process(receiptId);
    expect(query.mock.calls.find(([sql]) => sql.join('?').includes('FROM call_attempts')))
      .toEqual(expect.arrayContaining([orgId, attemptId]));
    expect(execute.mock.calls.at(-1)?.[0].join('?')).toContain("status = 'completed'");
  });

  it('accepts an identical provider-session binding retry without overwriting it', async () => {
    const { receipts, addBinding, execute } = fixture();
    addBinding();
    execute.mockResolvedValueOnce(0);
    await expect(
      receipts.bindSession(CALLBACK_SOURCES.synthetic, 'session-1', orgId, attemptId),
    ).resolves.toBeUndefined();
    expect(execute.mock.calls[0]?.[0].join('?')).toContain('ON CONFLICT (source, session_id) DO NOTHING');
    expect(receipts).toBeDefined();
  });

  it('resolves an Africa’s Talking receipt only through a provider binding', async () => {
    const { receipts, addBinding, execute, query } = fixture({
      source: CALLBACK_SOURCES.africasTalking,
      sessionId: 'ATVId_abc',
      state: 'ANSWERED',
    });
    addBinding(CALLBACK_SOURCES.africasTalking, 'ATVId_abc');
    await receipts.process(receiptId);

    const lookup = query.mock.calls.find(([sql]) => sql.join('?').includes('FROM voice_callback_bindings'));
    expect(lookup).toEqual(expect.arrayContaining([
      CALLBACK_SOURCES.africasTalking,
      'ATVId_abc',
    ]));
    expect(query.mock.calls.find(([sql]) => sql.join('?').includes('FROM call_attempts')))
      .toEqual(expect.arrayContaining([orgId, attemptId]));
    expect(execute.mock.calls.at(-1)?.[0].join('?')).toContain("status = 'completed'");
  });

  it('does not resolve a provider receipt through a synthetic binding', async () => {
    const { receipts, addBinding, execute } = fixture({
      source: CALLBACK_SOURCES.africasTalking,
      sessionId: 'ATVId_abc',
    });
    addBinding(CALLBACK_SOURCES.synthetic, 'ATVId_abc');
    await receipts.process(receiptId);
    expect(execute.mock.calls[0]?.[1]).toBe('awaiting_binding');
  });

  it('does not resolve a synthetic receipt through a provider binding', async () => {
    const { receipts, addBinding, execute } = fixture();
    addBinding(CALLBACK_SOURCES.africasTalking, 'session-1');
    await receipts.process(receiptId);
    expect(execute.mock.calls[0]?.[1]).toBe('awaiting_binding');
  });

  it('keeps a terminal attempt unchanged when a late provider event arrives', async () => {
    const { receipts, addBinding, execute } = fixture({
      source: CALLBACK_SOURCES.africasTalking,
      sessionId: 'ATVId_abc',
      state: 'RINGING',
      currentState: 'COMPLETED',
    });
    addBinding(CALLBACK_SOURCES.africasTalking, 'ATVId_abc');
    await receipts.process(receiptId);
    expect(execute.mock.calls.some(([sql]) => sql.join('?').includes('UPDATE call_attempts'))).toBe(false);
    expect(execute.mock.calls.at(-1)?.[1]).toBe('CONFLICT');
    expect(execute.mock.calls.at(-1)?.[0].join('?')).toContain("status = 'completed'");
  });

  it('uses tenant keys from the binding and leaves a terminal attempt unchanged', async () => {
    const { receipts, addBinding, execute, query } = fixture();
    addBinding();
    await receipts.process(receiptId);
    const attemptLock = query.mock.calls.find(([sql]) => sql.join('?').includes('FROM call_attempts'));
    expect(attemptLock).toEqual(expect.arrayContaining([orgId, attemptId]));
    expect(execute.mock.calls.some(([sql]) => sql.join('?').includes('UPDATE call_attempts'))).toBe(false);
    expect(execute.mock.calls.at(-1)?.[0].join('?')).toContain("status = 'completed'");
  });

  it('leaves completed or missing jobs alone after a restart or redelivery', async () => {
    const { receipts, pending, execute } = fixture();
    pending.value = false;
    await receipts.process(receiptId);
    expect(execute).not.toHaveBeenCalled();
  });

  it('propagates an unavailable database so the dispatcher can retry the durable receipt', async () => {
    const { receipts, database, execute } = fixture();
    database.$transaction.mockRejectedValueOnce(new Error('database offline'));
    execute.mockRejectedValueOnce(new Error('database offline'));
    await expect(receipts.process(receiptId)).rejects.toThrow('database offline');
  });

  it('suppresses a chronologically stale event for a bound session', async () => {
    const { receipts, addBinding, execute } = fixture({ latestOccurredAt: occurredAt });
    addBinding(CALLBACK_SOURCES.synthetic, 'session-1');
    const stale = new Date(occurredAt.getTime() - 1_000);

    await expect(
      receipts.receiveSynthetic(
        { sessionId: 'session-1', state: 'RINGING', occurredAt: stale },
        { enforceChronology: true },
      ),
    ).resolves.toEqual({ accepted: false, reason: 'stale' });
    expect(execute).not.toHaveBeenCalled();
  });

  it('accepts a same-time or later event while preserving default synthetic behavior', async () => {
    const { receipts, addBinding, execute } = fixture({ latestOccurredAt: occurredAt });
    addBinding();

    await expect(
      receipts.receiveSynthetic(
        { sessionId: 'session-1', state: 'RINGING', occurredAt },
        { enforceChronology: true },
      ),
    ).resolves.toEqual({ accepted: true, reason: 'queued' });
    await expect(
      receipts.receiveSynthetic({ sessionId: 'session-1', state: 'RINGING', occurredAt }),
    ).resolves.toEqual({ accepted: true, reason: 'queued' });
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it('settles inside the receipt transaction with binding-derived tenant identity', async () => {
    const settlement = {
      settle: vi.fn(
        async (_tx: CallSql, _input: CallbackSettlementInput): Promise<CallbackSettlementOutcome> =>
          'SETTLED',
      ),
    };
    const { receipts, addBinding, execute } = fixture({
      state: 'ANSWERED',
      currentState: 'RINGING',
      eventKey,
      settlement,
    });
    addBinding();
    await receipts.process(receiptId);

    expect(settlement.settle).toHaveBeenCalledOnce();
    const tx = settlement.settle.mock.calls[0]?.[0];
    expect(tx).toHaveProperty('$queryRaw');
    expect(settlement.settle.mock.calls[0]?.[1]).toEqual({
      source: CALLBACK_SOURCES.synthetic,
      sessionId: 'session-1',
      eventKey,
      organizationId: orgId,
      attemptId,
      state: 'ANSWERED',
      occurredAt,
    });
    expect(execute.mock.calls.at(-1)?.[0].join('?')).toContain("status = 'completed'");
    expect(execute.mock.calls.at(-1)?.[1]).toBe('APPLIED:SETTLED');
  });

  it('rolls back receipt completion when settlement fails', async () => {
    const settlement = {
      settle: vi.fn(
        async (_tx: CallSql, _input: CallbackSettlementInput): Promise<CallbackSettlementOutcome> => {
          throw new Error('ledger offline');
        },
      ),
    };
    const { receipts, addBinding, execute } = fixture({
      state: 'ANSWERED',
      currentState: 'RINGING',
      eventKey,
      settlement,
    });
    addBinding();
    await expect(receipts.process(receiptId)).resolves.toBeUndefined();
    expect(settlement.settle).toHaveBeenCalledOnce();
    expect(execute.mock.calls.at(-1)?.[1]).toBe('processing_failed');
    expect(execute.mock.calls.at(-1)?.[0].join('?')).not.toContain("status = 'completed'");
  });
});
