/**
 * Strict normalization for Africa's Talking voice Events POSTs.
 *
 * This is adapter-boundary code: provider field names stop here. It performs no
 * I/O, proves no provider identity, and never turns an unrecognized event word
 * into a call state. The endpoint remains unwired until callback authentication
 * is approved separately.
 */

import { isPhoneNumber } from '@truevine/domain';

import { fingerprint } from '../../call-contract.js';
import { CALLBACK_SOURCES } from '../../callback-sources.js';
import type { ProviderCallState } from '../../voice.port.js';

export type CallbackNormalizationErrorCode =
  | 'invalid_body'
  | 'unsupported_field'
  | 'invalid_session_id'
  | 'invalid_state'
  | 'unsupported_state'
  | 'invalid_is_active'
  | 'inconsistent_is_active'
  | 'invalid_optional_field';

export class CallbackNormalizationError extends Error {
  constructor(readonly code: CallbackNormalizationErrorCode) {
    super(code);
    this.name = 'CallbackNormalizationError';
  }
}

/** Documented Events URL fields accepted by this boundary. Unknown fields are rejected. */
export const AFRICA_TALKING_CALLBACK_FIELDS = Object.freeze([
  'sessionId',
  'callSessionState',
  'isActive',
  'direction',
  'callerCountryCode',
  'callerNumber',
  'destinationNumber',
  'callStartTime',
  'clientRequestId',
  'durationInSeconds',
  'currencyCode',
  'amount',
  'errorMessage',
  'hangupCause',
] as const);

const FIELD_SET: ReadonlySet<string> = new Set(AFRICA_TALKING_CALLBACK_FIELDS);

/**
 * Documented call transition states with an unambiguous neutral equivalent.
 * `Active`, `Enqueued` and `Dequeued` are documented but intentionally absent:
 * they do not identify a terminal or answer state for an outbound call we
 * initiated, and are rejected rather than guessed.
 */
const STATE_MAP: Readonly<Record<string, ProviderCallState>> = Object.freeze({
  DIALING: 'DIALING',
  RINGING: 'RINGING',
  BRIDGED: 'ANSWERED',
  COMPLETED: 'COMPLETED',
  NOTANSWERED: 'NO_ANSWER',
  EXPIRED: 'FAILED',
});

const TERMINAL: ReadonlySet<ProviderCallState> = new Set([
  'COMPLETED',
  'NO_ANSWER',
  'FAILED',
]);

export interface AfricaTalkingCallbackEvidence {
  readonly durationSeconds?: number;
  readonly currencyCode?: string;
  /** Raw provider text only. Never parsed into money or used for charging. */
  readonly amount?: string;
  readonly errorMessage?: string;
  readonly hangupCause?: string;
}

export interface NormalizedAfricaTalkingCallback {
  readonly source: typeof CALLBACK_SOURCES.africasTalking;
  readonly sessionId: string;
  readonly state: ProviderCallState;
  readonly active: 0 | 1;
  /** Africa's Talking Events POSTs have no documented event timestamp. */
  readonly eventTime: null;
  /** Exact time the request was accepted; stored separately as received_at. */
  readonly receivedAt: Date;
  /** What downstream persistence treats as event time: eventTime ?? receivedAt. */
  readonly occurredAt: Date;
  /** Stable across exact provider retries because no wall-clock time is included. */
  readonly eventKey: string;
  /** Optional, non-authoritative evidence. Never used as a billing record. */
  readonly evidence: AfricaTalkingCallbackEvidence;
}

function fail(code: CallbackNormalizationErrorCode): never {
  throw new CallbackNormalizationError(code);
}

function sessionIdOf(value: unknown): string {
  if (typeof value !== 'string' || value === 'None' || !/^[A-Za-z0-9_-]{1,160}$/.test(value))
    fail('invalid_session_id');
  return value;
}

function stateOf(value: unknown): ProviderCallState {
  if (typeof value !== 'string' || value.length === 0 || value.length > 64) fail('invalid_state');
  const canonical = value.replace(/[\s_-]+/g, '').toUpperCase();
  const state = STATE_MAP[canonical];
  if (!state) fail('unsupported_state');
  return state;
}

function activeOf(value: unknown): 0 | 1 {
  if (value === 0 || value === '0') return 0;
  if (value === 1 || value === '1') return 1;
  return fail('invalid_is_active');
}

function optionalString(
  record: Readonly<Record<string, unknown>>,
  field: string,
  max: number,
  pattern?: RegExp,
  allowEmpty = false,
): string | undefined {
  const value = record[field];
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.length > max || (!allowEmpty && value.length === 0))
    fail('invalid_optional_field');
  if (pattern && !pattern.test(value)) fail('invalid_optional_field');
  return value;
}

function evidenceOf(record: Readonly<Record<string, unknown>>): AfricaTalkingCallbackEvidence {
  const evidence: {
    durationSeconds?: number;
    currencyCode?: string;
    amount?: string;
    errorMessage?: string;
    hangupCause?: string;
  } = {};

  const duration = record['durationInSeconds'];
  if (duration !== undefined) {
    const text = typeof duration === 'number' ? String(duration) : duration;
    if (typeof text !== 'string' || !/^\d{1,5}$/.test(text)) fail('invalid_optional_field');
    const seconds = Number(text);
    if (!Number.isSafeInteger(seconds) || seconds > 86_400) fail('invalid_optional_field');
    evidence.durationSeconds = seconds;
  }

  const currencyCode = optionalString(record, 'currencyCode', 3, /^[A-Z]{3}$/);
  if (currencyCode !== undefined) evidence.currencyCode = currencyCode;

  const amount = optionalString(record, 'amount', 32, /^\d+(?:\.\d{1,4})?$/);
  if (amount !== undefined) evidence.amount = amount;

  const errorMessage = optionalString(record, 'errorMessage', 200, undefined, true);
  if (errorMessage !== undefined) evidence.errorMessage = errorMessage;

  const hangupCause = optionalString(record, 'hangupCause', 80, /^[A-Za-z0-9_]+$/);
  if (hangupCause !== undefined) evidence.hangupCause = hangupCause;

  return Object.freeze(evidence);
}

function validateContextFields(record: Readonly<Record<string, unknown>>): void {
  const direction = optionalString(record, 'direction', 16);
  if (direction !== undefined && !/^(inbound|outbound)$/i.test(direction)) fail('invalid_optional_field');

  optionalString(record, 'callerCountryCode', 5, /^\d{1,5}$/);
  optionalString(record, 'clientRequestId', 200);

  for (const field of ['callerNumber', 'destinationNumber'] as const) {
    const number = record[field];
    if (number === undefined) continue;
    if (typeof number !== 'string' || !isPhoneNumber(number)) fail('invalid_optional_field');
  }

  // `callStartTime` is commonly `None` and is not an event timestamp. It is
  // accepted only as a bounded opaque string and never parsed into occurredAt.
  optionalString(record, 'callStartTime', 32);
}

/** Normalizes one untrusted callback body into a durable receipt input. */
export function normalizeAfricaTalkingCallback(
  body: unknown,
  receivedAt: Date = new Date(),
): NormalizedAfricaTalkingCallback {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) fail('invalid_body');
  const record = body as Record<string, unknown>;
  const proto = Object.getPrototypeOf(record);
  if (proto !== Object.prototype && proto !== null) fail('invalid_body');

  for (const field of Object.keys(record)) {
    if (!FIELD_SET.has(field)) fail('unsupported_field');
  }

  const sessionId = sessionIdOf(record['sessionId']);
  const state = stateOf(record['callSessionState']);
  const active = activeOf(record['isActive']);
  if ((active === 0) !== TERMINAL.has(state)) fail('inconsistent_is_active');

  validateContextFields(record);
  const evidence = evidenceOf(record);
  if (!(receivedAt instanceof Date) || !Number.isFinite(receivedAt.getTime())) fail('invalid_body');

  const source = CALLBACK_SOURCES.africasTalking;
  return Object.freeze({
    source,
    sessionId,
    state,
    active,
    eventTime: null,
    receivedAt,
    occurredAt: receivedAt,
    eventKey: fingerprint([1, source, sessionId, state, active]),
    evidence,
  });
}
