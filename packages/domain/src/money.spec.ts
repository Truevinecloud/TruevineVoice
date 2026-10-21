import { describe, expect, it } from 'vitest';

import {
  UGX,
  MoneyError,
  add,
  compare,
  equals,
  isCredit,
  isDebit,
  isZero,
  minorUnitScale,
  money,
  moneyFromDecimalString,
  multiply,
  subtract,
} from './money.js';

describe('money — construction and currency', () => {
  it('refuses a numeric amount: minor units must be bigint', () => {
    expect(() => money(5000 as unknown as bigint, UGX)).toThrow(MoneyError);
  });

  it('requires a valid ISO 4217 currency code', () => {
    expect(() => money(100n, 'ugx')).toThrow(MoneyError);
    expect(() => money(100n, 'UG')).toThrow(MoneyError);
    expect(() => money(100n, '')).toThrow(MoneyError);
  });

  it('treats currency as part of the value', () => {
    expect(equals(money(100n, 'UGX'), money(100n, 'USD'))).toBe(false);
  });

  it('knows UGX has no minor sub-unit', () => {
    expect(minorUnitScale('UGX')).toBe(0);
    expect(minorUnitScale('USD')).toBe(2);
  });
});

describe('money — decimal conversion and the single rounding point', () => {
  it('converts a whole UGX amount with no rounding', () => {
    expect(moneyFromDecimalString('5000', UGX).amountMinor).toBe(5000n);
  });

  it('rounds UGX half-up at the minor unit', () => {
    expect(moneyFromDecimalString('5000.4', UGX).amountMinor).toBe(5000n);
    expect(moneyFromDecimalString('5000.5', UGX).amountMinor).toBe(5001n);
    expect(moneyFromDecimalString('5000.6', UGX).amountMinor).toBe(5001n);
  });

  it('rounds a two-decimal currency to cents half-up', () => {
    expect(moneyFromDecimalString('1.234', 'USD').amountMinor).toBe(123n);
    expect(moneyFromDecimalString('1.235', 'USD').amountMinor).toBe(124n);
    expect(moneyFromDecimalString('1.236', 'USD').amountMinor).toBe(124n);
  });

  it('does not introduce binary floating-point error', () => {
    // 0.1 + 0.2 !== 0.3 in floats; here each is exact minor units and the sum
    // is exact. 0.1 UGX -> 0, 0.2 UGX -> 0; USD -> 10 + 20 = 30 cents.
    const tenth = moneyFromDecimalString('0.1', 'USD');
    const fifth = moneyFromDecimalString('0.2', 'USD');
    expect(add(tenth, fifth).amountMinor).toBe(30n);
  });

  it('rejects non-decimal input', () => {
    expect(() => moneyFromDecimalString('1e3', UGX)).toThrow(MoneyError);
    expect(() => moneyFromDecimalString('abc', UGX)).toThrow(MoneyError);
    expect(() => moneyFromDecimalString('', UGX)).toThrow(MoneyError);
  });

  it('handles negative decimals', () => {
    expect(moneyFromDecimalString('-2.5', 'USD').amountMinor).toBe(-250n);
  });
});

describe('money — arithmetic invariants', () => {
  it('adds and subtracts within one currency', () => {
    expect(add(money(1000n, UGX), money(500n, UGX)).amountMinor).toBe(1500n);
    expect(subtract(money(1000n, UGX), money(250n, UGX)).amountMinor).toBe(750n);
  });

  it('refuses to combine different currencies', () => {
    expect(() => add(money(1000n, 'UGX'), money(500n, 'USD'))).toThrow(MoneyError);
    expect(() => subtract(money(1000n, 'UGX'), money(500n, 'USD'))).toThrow(MoneyError);
    expect(() => compare(money(1000n, 'UGX'), money(500n, 'USD'))).toThrow(MoneyError);
  });

  it('multiplies by a bigint factor only', () => {
    expect(multiply(money(50n, UGX), 60n).amountMinor).toBe(3000n);
    expect(() => multiply(money(50n, UGX), 60 as unknown as bigint)).toThrow(MoneyError);
  });

  it('classifies zero, credit and debit', () => {
    expect(isZero(money(0n, UGX))).toBe(true);
    expect(isCredit(money(5n, UGX))).toBe(true);
    expect(isDebit(money(-5n, UGX))).toBe(true);
  });

  it('compares by minor units', () => {
    expect(compare(money(100n, UGX), money(100n, UGX))).toBe(0);
    expect(compare(money(99n, UGX), money(100n, UGX))).toBe(-1);
    expect(compare(money(101n, UGX), money(100n, UGX))).toBe(1);
  });
});
