/**
 * The outbound call entity and its invariants.
 *
 * ARCHITECTURAL RULES ENFORCED HERE
 * ---------------------------------
 * - The call is organization-scoped. `organizationId` is part of the identity
 *   and is never optional (AGENTS.md 5).
 * - Duration, provider usage and billable usage are conceptually separate
 *   (condition 5). A provider may report rounding or a different unit; the
 *   billable amount is derived here from an explicit, recorded rate, not read
 *   off the wire.
 * - Money is exact (`Money`), never a float.
 * - This module is pure: no I/O, no clocks, no provider SDK. Timestamps are
 *   supplied by the caller.
 */

import type { CallState } from './call-state.js';
import { transition, type TransitionResult } from './call-state.js';
import type { Money } from './money.js';
import { multiply, money, subtract } from './money.js';
import type { PhoneNumber } from './phone-number.js';

/** Raised when a call invariant is violated. */
export class CallError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CallError';
  }
}

/**
 * Provider-reported usage, in the provider's own terms.
 *
 * Kept separate from billing on purpose: the provider may bill in whole
 * seconds, may round, and may report billable duration that differs from the
 * audio duration. It is evidence, not a charge.
 */
export interface ProviderUsage {
  /** The provider's own identifier for the call attempt, if any. */
  readonly providerCallId?: string;
  /** Whole seconds of connected audio the provider reports. */
  readonly connectedSeconds: number;
  /** Whole seconds the provider says are billable, if it distinguishes them. */
  readonly providerBillableSeconds?: number;
  /** The provider's own terminal status string, preserved verbatim as evidence. */
  readonly providerStatus?: string;
}

/**
 * The billable usage we decide on, derived from a recorded rate.
 *
 * This is intentionally a distinct type from `ProviderUsage`: it is our
 * decision, not the provider's claim.
 */
export interface BillableUsage {
  /** Whole seconds we will bill for, after our own rounding rule. */
  readonly billedSeconds: number;
  /** The rate applied, kept so a charge can be explained later. */
  readonly ratePerSecond: Money;
  /** The resulting charge, exact. */
  readonly charge: Money;
}

/**
 * A call attempt, keyed by organization and call id.
 *
 * Immutable value: mutations return a new `Call`. The persisted form lives in
 * a later task; this is the in-memory invariant holder.
 */
export interface Call {
  readonly organizationId: string;
  readonly id: string;
  readonly to: PhoneNumber;
  readonly state: CallState;
  /** Correlates retries; the durable uniqueness lives in persistence (later task). */
  readonly idempotencyKey: string;
  readonly providerUsage?: ProviderUsage;
  readonly billableUsage?: BillableUsage;
}

/** A non-empty, validated idempotency key. */
export type IdempotencyKey = string & { readonly __brand: 'IdempotencyKey' };

const MAX_IDEMPOTENCY_KEY_LENGTH = 200;

/**
 * Validates an idempotency key for a paid operation.
 *
 * A paid call MUST carry one. An empty or whitespace-only key is refused, since
 * it is indistinguishable from "no key" and would defeat duplicate prevention.
 * This only checks the key's *shape*; durable duplicate prevention — storing it
 * under a unique constraint and replaying the original result — belongs to the
 * later persistence/worker implementation, not here.
 */
export function parseIdempotencyKey(input: string): IdempotencyKey {
  if (typeof input !== 'string') {
    throw new CallError('Idempotency key must be a string.');
  }
  const candidate = input.trim();
  if (candidate.length === 0) {
    throw new CallError('Idempotency key must be non-empty for a paid call initiation.');
  }
  if (candidate.length > MAX_IDEMPOTENCY_KEY_LENGTH) {
    throw new CallError(
      `Idempotency key must be at most ${MAX_IDEMPOTENCY_KEY_LENGTH} characters.`,
    );
  }
  return candidate as IdempotencyKey;
}

export interface NewCallInput {
  readonly organizationId: string;
  readonly id: string;
  readonly to: PhoneNumber;
  readonly idempotencyKey: IdempotencyKey;
}

/**
 * Creates a new call in `QUEUED`.
 *
 * `idempotencyKey` is already validated by `parseIdempotencyKey`; the branded
 * type makes it impossible to reach this factory with an unvalidated key, so the
 * idempotency requirement cannot be bypassed by construction.
 */
export function newCall(input: NewCallInput): Call {
  if (!input.organizationId) {
    throw new CallError('A call must belong to an organization.');
  }
  if (!input.id) {
    throw new CallError('A call must have an id.');
  }
  return Object.freeze({
    organizationId: input.organizationId,
    id: input.id,
    to: input.to,
    state: 'QUEUED',
    idempotencyKey: input.idempotencyKey,
  });
}

/** Applies a state event to a call, returning the updated call (or the same one). */
export function applyState(call: Call, to: CallState): { readonly call: Call; readonly result: TransitionResult } {
  const result = transition(call.state, to);
  if (!result.changed) {
    return { call, result };
  }
  return { call: Object.freeze({ ...call, state: result.state }), result };
}

/**
 * Records provider usage verbatim. Does not compute any charge.
 *
 * Recording is idempotent by overwrite, because a provider may re-send a final
 * usage record; the latest value from the provider is the evidence we keep.
 */
export function recordProviderUsage(call: Call, usage: ProviderUsage): Call {
  if (!Number.isInteger(usage.connectedSeconds) || usage.connectedSeconds < 0) {
    throw new CallError('connectedSeconds must be a non-negative integer.');
  }
  if (
    usage.providerBillableSeconds !== undefined &&
    (!Number.isInteger(usage.providerBillableSeconds) || usage.providerBillableSeconds < 0)
  ) {
    throw new CallError('providerBillableSeconds must be a non-negative integer when present.');
  }
  return Object.freeze({ ...call, providerUsage: Object.freeze({ ...usage }) });
}

/**
 * Computes billable usage from connected seconds and a recorded per-second rate.
 *
 * Rounding rule (documented, single place): billable seconds are the provider's
 * connected seconds rounded UP to the next whole second (ceiling), because a
 * connection that started is a cost even in a partial second. This is our rule,
 * stated once, and it is deliberately NOT read from the provider's numbers.
 * The charge is `ratePerSecond * billedSeconds`, exact integer minor units.
 */
export function computeBillableUsage(
  call: Call,
  ratePerSecond: Money,
  currencyIsExact = true,
): BillableUsage {
  if (!currencyIsExact) {
    throw new CallError('Only exact per-second rates are supported; provide an exact Money rate.');
  }
  const usage = call.providerUsage;
  if (!usage) {
    throw new CallError('Cannot compute billable usage before provider usage is recorded.');
  }
  const billedSeconds = Math.ceil(usage.connectedSeconds);
  const charge = multiply(ratePerSecond, BigInt(billedSeconds));
  return Object.freeze({ billedSeconds, ratePerSecond, charge });
}

/** Attaches a computed billable usage to the call. */
export function withBillableUsage(call: Call, billable: BillableUsage): Call {
  return Object.freeze({ ...call, billableUsage: billable });
}

/**
 * Convenience: the zero amount in the same currency as an existing rate.
 *
 * Useful for "no charge" cases (e.g. a call that never connected) while keeping
 * the currency explicit.
 */
export function zeroChargeLike(reference: Money): Money {
  return money(0n, reference.currency);
}

/** The amount to reverse from a pre-authorised charge, given actual usage. */
export function unusedAuthorization(authorized: Money, used: Money): Money {
  return subtract(authorized, used);
}
