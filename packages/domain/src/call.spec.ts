import { describe, expect, it } from 'vitest';

import {
  CallError,
  applyState,
  computeBillableUsage,
  newCall,
  parseIdempotencyKey,
  recordProviderUsage,
  unusedAuthorization,
  withBillableUsage,
  zeroChargeLike,
} from './call.js';
import { UGX, money } from './money.js';
import { parsePhoneNumber } from './phone-number.js';

const baseInput = () => ({
  organizationId: 'org-1',
  id: 'call-1',
  to: parsePhoneNumber('+256772123456'),
  idempotencyKey: parseIdempotencyKey('idem-1'),
});

describe('call — idempotency requirement', () => {
  it('refuses an empty idempotency key on a paid initiation', () => {
    expect(() => parseIdempotencyKey('')).toThrow(CallError);
    expect(() => parseIdempotencyKey('   ')).toThrow(CallError);
  });

  it('accepts and trims a non-empty key', () => {
    expect(parseIdempotencyKey('  key  ')).toBe('key');
  });

  it('refuses an over-long key', () => {
    expect(() => parseIdempotencyKey('x'.repeat(201))).toThrow(CallError);
  });
});

describe('call — construction invariants', () => {
  it('starts in QUEUED and is organization-scoped', () => {
    const call = newCall(baseInput());
    expect(call.state).toBe('QUEUED');
    expect(call.organizationId).toBe('org-1');
  });

  it('refuses a call without an organization', () => {
    expect(() => newCall({ ...baseInput(), organizationId: '' })).toThrow(CallError);
  });

  it('refuses a call without an id', () => {
    expect(() => newCall({ ...baseInput(), id: '' })).toThrow(CallError);
  });
});

describe('call — state application', () => {
  it('moves the call forward and reports change', () => {
    const { call, result } = applyState(newCall(baseInput()), 'DIALING');
    expect(result.changed).toBe(true);
    expect(call.state).toBe('DIALING');
  });

  it('returns the same call for a duplicate/late event', () => {
    const dialing = applyState(newCall(baseInput()), 'DIALING').call;
    const { call, result } = applyState(dialing, 'DIALING');
    expect(result.changed).toBe(false);
    expect(call).toBe(dialing);
  });
});

describe('call — provider usage vs billable usage are separate', () => {
  it('records provider usage without computing any charge', () => {
    const call = recordProviderUsage(newCall(baseInput()), {
      providerCallId: 'AT-123',
      connectedSeconds: 42,
      providerBillableSeconds: 60,
      providerStatus: 'completed',
    });
    expect(call.providerUsage?.connectedSeconds).toBe(42);
    expect(call.billableUsage).toBeUndefined();
  });

  it('keeps the provider status verbatim as evidence', () => {
    const call = recordProviderUsage(newCall(baseInput()), {
      connectedSeconds: 5,
      providerStatus: 'completed-weird-vendor-string',
    });
    expect(call.providerUsage?.providerStatus).toBe('completed-weird-vendor-string');
  });

  it('refuses negative or fractional seconds', () => {
    expect(() =>
      recordProviderUsage(newCall(baseInput()), { connectedSeconds: -1 }),
    ).toThrow(CallError);
    expect(() =>
      recordProviderUsage(newCall(baseInput()), { connectedSeconds: 1.5 }),
    ).toThrow(CallError);
  });

  it('computes billable usage by our ceiling rule, not the provider number', () => {
    const call = recordProviderUsage(newCall(baseInput()), {
      connectedSeconds: 42,
      providerBillableSeconds: 60,
    });
    const billable = computeBillableUsage(call, money(10n, UGX));
    // Our rule: ceil(42) = 42 seconds, NOT the provider's 60.
    expect(billable.billedSeconds).toBe(42);
    expect(billable.charge.amountMinor).toBe(420n);
  });

  it('rounds partial connected seconds up to the next whole second', () => {
    const call = recordProviderUsage(newCall(baseInput()), { connectedSeconds: 12 });
    // connectedSeconds is an integer by construction; ceiling preserves it.
    expect(computeBillableUsage(call, money(3n, UGX)).billedSeconds).toBe(12);
  });

  it('refuses to compute billable usage before usage is recorded', () => {
    expect(() => computeBillableUsage(newCall(baseInput()), money(10n, UGX))).toThrow(CallError);
  });

  it('attaches computed billable usage', () => {
    const call = recordProviderUsage(newCall(baseInput()), { connectedSeconds: 10 });
    const billable = computeBillableUsage(call, money(10n, UGX));
    const charged = withBillableUsage(call, billable);
    expect(charged.billableUsage?.charge.amountMinor).toBe(100n);
  });
});

describe('call — money helpers for charging', () => {
  it('produces a zero charge in the same currency', () => {
    expect(zeroChargeLike(money(10n, UGX)).amountMinor).toBe(0n);
  });

  it('computes the unused part of an authorization', () => {
    const unused = unusedAuthorization(money(1000n, UGX), money(420n, UGX));
    expect(unused.amountMinor).toBe(580n);
  });
});
