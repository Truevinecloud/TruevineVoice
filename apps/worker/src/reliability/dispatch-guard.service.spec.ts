import { describe, expect, it } from 'vitest';

import {
  FailClosedDispatchCostPolicy,
  SyntheticDispatchCostPolicy,
  type DispatchCostPolicy,
} from './dispatch-cost-policy.js';
import { DispatchGuard } from './dispatch-guard.service.js';

const ORGANIZATION_ID = '26c3e32b-8458-46ed-a272-47931f2b75bb';
const CAMPAIGN_ID = '64e5f6f2-6f43-4f04-8e8f-91a5d498faaa';
const ATTEMPT_ID = 'b7b7a7cc-1c9d-4e35-9bb2-9f83d8e40f70';

class FakeSql {
  readonly statements: string[] = [];
  state = {
    status: 'ACTIVE',
    dispatch_state: 'RUNNING',
    emergency_stopped: false,
    organization_suspended: false,
  };
  balance = '5000';
  held = '0';
  queryFailure: Error | null = null;

  async $queryRaw<T>(strings: TemplateStringsArray, ..._values: readonly unknown[]): Promise<T> {
    const sql = strings.join(' ');
    this.statements.push(sql);
    if (this.queryFailure) throw this.queryFailure;
    if (sql.includes('FROM campaigns c')) return [this.state] as T;
    if (sql.includes('FROM wallet_entries')) return [{ total: this.balance }] as T;
    if (sql.includes('FROM campaign_dispatch_reservations')) return [{ total: this.held }] as T;
    throw new Error(`unexpected query: ${sql}`);
  }

  async $executeRaw(strings: TemplateStringsArray, ..._values: readonly unknown[]): Promise<number> {
    const sql = strings.join(' ');
    this.statements.push(sql);
    if (sql.includes('INSERT INTO campaign_dispatch_reservations')) return 1;
    return 1;
  }

  hasInsert(): boolean {
    return this.statements.some((statement) =>
      statement.includes('INSERT INTO campaign_dispatch_reservations'),
    );
  }

  hasSystemPause(): boolean {
    return this.statements.some(
      (statement) => statement.includes("SET dispatch_state = 'PAUSED'"),
    );
  }
}

function input() {
  return {
    organizationId: ORGANIZATION_ID,
    campaignId: CAMPAIGN_ID,
    recipientId: '65ad3f7d-2d29-4a58-9f9a-1506ad6db110',
    attemptId: ATTEMPT_ID,
    currency: 'UGX' as const,
  };
}

async function authorizeWith(
  sql: FakeSql,
  policy: DispatchCostPolicy = new SyntheticDispatchCostPolicy(1_000n),
) {
  return new DispatchGuard(policy).authorize(sql as never, input());
}

describe('DispatchGuard', () => {
  const blockedStates = [
    ['paused', { dispatch_state: 'PAUSED' }, 'campaign_paused'],
    ['cancelled', { dispatch_state: 'CANCELLED' }, 'campaign_cancelled'],
    ['emergency stopped', { emergency_stopped: true }, 'campaign_emergency_stopped'],
    ['not active', { status: 'COMPLETED' }, 'campaign_not_active'],
    ['suspended', { organization_suspended: true }, 'organization_suspended'],
  ] as const;

  it.each(blockedStates)('refuses paid work when the campaign is %s', async (_label, patch, reason) => {
    const sql = new FakeSql();
    sql.state = { ...sql.state, ...patch };
    const result = await authorizeWith(sql);

    expect(result).toEqual({ ok: false, reason });
    expect(sql.hasInsert()).toBe(false);
    expect(sql.hasSystemPause()).toBe(false);
  });

  it('pauses with an explicit reason when the reserve cannot be covered', async () => {
    const sql = new FakeSql();
    sql.balance = '999';

    expect(await authorizeWith(sql)).toEqual({ ok: false, reason: 'insufficient_balance' });
    expect(sql.hasInsert()).toBe(false);
    expect(sql.hasSystemPause()).toBe(true);
  });

  it('subtracts other held reservations from available balance', async () => {
    const sql = new FakeSql();
    sql.balance = '1500';
    sql.held = '600';

    expect(await authorizeWith(sql)).toEqual({ ok: false, reason: 'insufficient_balance' });
  });

  it('fails closed when no approved cost policy is configured', async () => {
    const sql = new FakeSql();

    expect(await authorizeWith(sql, new FailClosedDispatchCostPolicy())).toEqual({
      ok: false,
      reason: 'dispatch_policy_unavailable',
    });
    expect(sql.hasInsert()).toBe(false);
    expect(sql.hasSystemPause()).toBe(true);
  });

  it('creates one durable reservation before permitting provider work', async () => {
    const sql = new FakeSql();
    const result = await authorizeWith(sql);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.amountMinor).toBe(1_000n);
      expect(result.policyVersion).toBe('w601-synthetic-fixed');
      expect(result.reservationId).toMatch(/^[0-9a-f-]{36}$/);
    }
    expect(sql.hasInsert()).toBe(true);
  });

  it('fails closed when authoritative state cannot be read', async () => {
    const sql = new FakeSql();
    sql.queryFailure = new Error('database unavailable');

    await expect(authorizeWith(sql)).rejects.toThrow('database unavailable');
    expect(sql.hasInsert()).toBe(false);
  });
});
