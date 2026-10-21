/**
 * Money as an exact value.
 *
 * ARCHITECTURAL RULES ENFORCED HERE
 * ---------------------------------
 * - Money is NEVER a JavaScript floating-point number. `0.1 + 0.2 !== 0.3`, and
 *   a rounding error in a chargeable amount is a real loss or a real
 *   overcharge. Amounts are integer minor units with an explicit currency code
 *   (AGENTS.md 6).
 * - Currency is part of the value. An amount without a currency is incomplete,
 *   so there is no way to construct a `Money` that omits it.
 * - Rounding happens once, in one documented place (`roundHalfUpMinor`), with a
 *   stated rounding mode. Nothing in this package rounds implicitly.
 * - This module performs no I/O and imports nothing from a provider SDK. It is
 *   pure.
 */

/** A currency code, as published by ISO 4217 (three upper-case letters). */
export type CurrencyCode = string;

/**
 * A non-negative integer count of minor units, unless stated otherwise.
 *
 * `bigint` rather than `number` so that very large amounts and very large
 * aggregates do not silently lose precision past `Number.MAX_SAFE_INTEGER`.
 */
export type MinorUnits = bigint;

/** UGX is the only currency the product currently price in; it has no sub-unit. */
export const UGX: CurrencyCode = 'UGX';

const CURRENCY_PATTERN = /^[A-Z]{3}$/;

/** Raised when a money value or operation is malformed. */
export class MoneyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MoneyError';
  }
}

/**
 * An exact monetary amount: integer minor units plus its currency.
 *
 * Immutable. Use the factory functions; the constructor is not exported.
 */
export interface Money {
  readonly amountMinor: MinorUnits;
  readonly currency: CurrencyCode;
}

/**
 * Number of decimal places a currency's minor unit represents.
 *
 * This table is deliberately small and explicit rather than inferred. A currency
 * that is not listed is treated as having two decimal places, which is the most
 * common case, but callers can and should pass the correct scale when it
 * matters. UGX is listed because it is the product's currency and has none.
 */
const MINOR_UNIT_SCALE: Readonly<Record<CurrencyCode, number>> = Object.freeze({
  UGX: 0,
  USD: 2,
  EUR: 2,
  GBP: 2,
  KES: 2,
  TZS: 2,
});

/** The number of decimal places for a currency's minor unit. */
export function minorUnitScale(currency: CurrencyCode): number {
  assertCurrency(currency);
  return MINOR_UNIT_SCALE[currency] ?? 2;
}

function assertCurrency(currency: CurrencyCode): void {
  if (typeof currency !== 'string' || !CURRENCY_PATTERN.test(currency)) {
    throw new MoneyError(
      `Currency must be a three-letter upper-case ISO 4217 code; received "${String(currency)}".`,
    );
  }
}

/**
 * Builds a `Money` from an integer count of minor units.
 *
 * The amount MUST already be an integer number of minor units. A fractional
 * `bigint` is not representable, and a fractional `number` is rejected rather
 * than truncated, so a float can never be smuggled in through this door.
 */
export function money(amountMinor: bigint, currency: CurrencyCode): Money {
  if (typeof amountMinor !== 'bigint') {
    throw new MoneyError('amountMinor must be a bigint of integer minor units, never a number.');
  }
  assertCurrency(currency);
  return Object.freeze({ amountMinor, currency });
}

/**
 * Builds a `Money` from a decimal amount expressed as a string, rounding to the
 * currency's minor unit with half-up rounding.
 *
 * This is the ONLY conversion point from a human decimal (e.g. provider tariff
 * text, a user-entered price) into minor units, and the only place rounding is
 * applied. Passing a `number` is intentionally impossible: callers must supply
 * the decimal as a string so no binary floating-point error is introduced before
 * rounding.
 */
export function moneyFromDecimalString(decimal: string, currency: CurrencyCode): Money {
  assertCurrency(currency);
  const trimmed = decimal.trim();
  if (!/^-?\d+(\.\d+)?$/.test(trimmed)) {
    throw new MoneyError(`"${decimal}" is not a plain decimal string.`);
  }
  const scale = minorUnitScale(currency);
  const negative = trimmed.startsWith('-');
  const [whole = '0', fraction = ''] = trimmed.replace(/^-/, '').split('.');
  const paddedFraction = (fraction + '0'.repeat(scale)).slice(0, scale);
  const droppedFraction = fraction.slice(scale);

  let minor = BigInt(whole) * 10n ** BigInt(scale) + BigInt(paddedFraction);
  if (shouldRoundHalfUp(droppedFraction)) {
    minor += 1n;
  }
  return money(negative ? -minor : minor, currency);
}

/**
 * Half-up rounding decision for the first dropped digit.
 *
 * A dropped part of at least one half rounds up; anything less than half rounds
 * down. So a leading digit > 5 rounds up, < 5 rounds down, and exactly 5 rounds
 * up (this is "half-up", not "half-even"). This is the single documented
 * rounding mode for the whole codebase.
 */
function shouldRoundHalfUp(dropped: string): boolean {
  if (dropped.length === 0) return false;
  const first = dropped[0];
  if (first === undefined) return false;
  const firstDigit = Number(first);
  return firstDigit >= 5;
}

/** Adds two amounts of the same currency. Currencies must match exactly. */
export function add(a: Money, b: Money): Money {
  assertSameCurrency(a, b);
  return money(a.amountMinor + b.amountMinor, a.currency);
}

/** Subtracts `b` from `a`. Result may be negative (a credit/debit direction). */
export function subtract(a: Money, b: Money): Money {
  assertSameCurrency(a, b);
  return money(a.amountMinor - b.amountMinor, a.currency);
}

/** Multiplies by a whole-number factor (e.g. quantity of call seconds billed). */
export function multiply(a: Money, factor: bigint): Money {
  if (typeof factor !== 'bigint') {
    throw new MoneyError('Multiplier must be a bigint.');
  }
  return money(a.amountMinor * factor, a.currency);
}

/** True when the amount is exactly zero. */
export function isZero(a: Money): boolean {
  return a.amountMinor === 0n;
}

/** True when the amount is a credit (positive). */
export function isCredit(a: Money): boolean {
  return a.amountMinor > 0n;
}

/** True when the amount is a debit (negative). */
export function isDebit(a: Money): boolean {
  return a.amountMinor < 0n;
}

/** Compares two amounts of the same currency: -1, 0 or 1. */
export function compare(a: Money, b: Money): -1 | 0 | 1 {
  assertSameCurrency(a, b);
  if (a.amountMinor < b.amountMinor) return -1;
  if (a.amountMinor > b.amountMinor) return 1;
  return 0;
}

/** Structural equality: same currency and same minor-unit amount. */
export function equals(a: Money, b: Money): boolean {
  return a.currency === b.currency && a.amountMinor === b.amountMinor;
}

function assertSameCurrency(a: Money, b: Money): void {
  if (a.currency !== b.currency) {
    throw new MoneyError(
      `Cannot combine amounts in different currencies: ${a.currency} and ${b.currency}.`,
    );
  }
}
