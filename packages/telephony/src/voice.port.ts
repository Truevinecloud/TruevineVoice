/**
 * The provider-neutral Voice port.
 *
 * ARCHITECTURAL RULES ENFORCED HERE
 * ---------------------------------
 * - This is the only surface the rest of the system uses to place and observe a
 *   call. Africa's Talking is a later adapter behind this interface; nothing
 *   outside an adapter imports provider SDK code (AGENTS.md 8).
 * - Every operation that can cost money accepts a mandatory `IdempotencyKey`.
 *   The type is branded in `@truevine/domain`, so a caller cannot obtain one
 *   without validating it. Durable duplicate prevention (storing the key under a
 *   unique constraint and replaying the original result) belongs to the later
 *   persistence/worker implementation, not to this interface.
 * - Provider field names never appear here. Request and result shapes are ours;
 *   an adapter maps the provider's response onto them explicitly.
 * - This module performs no I/O and imports no provider SDK.
 */

import type {
  CallState,
  IdempotencyKey,
  PhoneNumber,
  ProviderUsage,
} from '@truevine/domain';

/** The set of provider-neutral call states a provider event may report. */
export type ProviderCallState = CallState;

/** A request to place a single outbound call. */
export interface InitiateCallRequest {
  /** The destination, already validated E.164. */
  readonly to: PhoneNumber;
  /** Our stable identifier for the attempt; correlates logs and retries. */
  readonly callId: string;
  /** Organization that owns the call. Never supplied by an untrusted body. */
  readonly organizationId: string;
  /** Mandatory: a paid initiation must be retry-safe. */
  readonly idempotencyKey: IdempotencyKey;
  /** Optional greeting/audio reference; resolved by a later task. */
  readonly audioRef?: string;
  /**
   * Public URL the provider should call back with events. The endpoint itself
   * is a later task; carrying the value here lets dispatch record intent.
   */
  readonly callbackUrl?: string;
}

/** The result of an initiation attempt, in our terms. */
export interface InitiateCallResult {
  readonly callId: string;
  readonly state: ProviderCallState;
  /** The provider's own id if it returned one; opaque to us. */
  readonly providerCallId?: string;
  /**
   * True when this result was replayed from a previously accepted initiation
   * with the same idempotency key, so no new call was placed.
   */
  readonly replayed: boolean;
}

/** A request to hang up an in-progress call. */
export interface HangUpRequest {
  readonly callId: string;
  readonly providerCallId?: string;
  readonly idempotencyKey: IdempotencyKey;
}

/** The state of a call as reported by the provider. */
export interface CallStatusResult {
  readonly callId: string;
  readonly state: ProviderCallState;
  readonly providerCallId?: string;
  /** Provider-reported usage, kept verbatim as evidence; never a charge. */
  readonly usage?: ProviderUsage;
}

/**
 * A single provider-event fact, already mapped to our vocabulary.
 *
 * Present on the port so that the later webhook handler and worker share one
 * type. Provider webhooks are untrusted input: the adapter validates and
 * verifies the signature, records the event, and only then maps it here.
 */
export interface CallEvent {
  readonly callId: string;
  readonly state: ProviderCallState;
  readonly providerCallId?: string;
  readonly usage?: ProviderUsage;
  /** Provider's event timestamp, if given, for ordering and dedupe. */
  readonly occurredAt?: Date;
}

/**
 * The Voice port.
 *
 * A provider adapter implements this interface. Callers depend only on this
 * type. Every money-affecting method requires an idempotency key.
 */
export interface VoicePort {
  /** Places an outbound call. Requires an idempotency key. */
  initiateCall(request: InitiateCallRequest): Promise<InitiateCallResult>;
  /** Ends an in-progress call. Requires an idempotency key. */
  hangUp(request: HangUpRequest): Promise<CallStatusResult>;
  /** Reads the current state of a call. Read-only; no key required. */
  fetchCallStatus(callId: string): Promise<CallStatusResult>;
}

/** The categories of failure a provider operation can produce. */
export type TelephonyErrorKind =
  | 'invalid_request'
  | 'unauthorized'
  | 'rate_limited'
  | 'provider_unavailable'
  | 'not_found'
  | 'unknown';

/**
 * A provider-neutral telephony error.
 *
 * `kind` is stable and ours; `providerMessage` is opaque diagnostic text from
 * the provider and must never be parsed for control flow. `retryable` states
 * whether the caller may retry with the SAME idempotency key.
 */
export class TelephonyError extends Error {
  readonly kind: TelephonyErrorKind;
  readonly retryable: boolean;
  readonly providerMessage?: string;

  constructor(
    kind: TelephonyErrorKind,
    message: string,
    options: { readonly retryable?: boolean; readonly providerMessage?: string } = {},
  ) {
    super(message);
    this.name = 'TelephonyError';
    this.kind = kind;
    this.retryable = options.retryable ?? false;
    this.providerMessage = options.providerMessage;
  }
}

/**
 * Compile-time proof that an implementation satisfies the port.
 *
 * Used by adapters and by the fake; if a method signature drifts, the adapter
 * fails to typecheck rather than failing at runtime.
 */
export function assertVoicePort(port: VoicePort): VoicePort {
  return port;
}
