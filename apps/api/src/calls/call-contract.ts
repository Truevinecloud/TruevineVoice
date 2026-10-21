import { createHash } from 'node:crypto';
import {
  CALL_TRANSITIONS,
  isTerminal,
  parseIdempotencyKey,
  parsePhoneNumber,
  type CallState,
} from '@truevine/domain';

export class CallPersistenceError extends Error {
  constructor(
    readonly code:
      | 'invalid_request'
      | 'not_found'
      | 'idempotency_conflict'
      | 'duplicate_execution'
      | 'invalid_redial',
  ) {
    super(code);
    this.name = 'CallPersistenceError';
  }
}

export function uuid(value: string): string {
  if (
    typeof value !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
  )
    throw new CallPersistenceError('invalid_request');
  return value.toLowerCase();
}

export function bounded(value: string, max = 200): string {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > max)
    throw new CallPersistenceError('invalid_request');
  return value.trim();
}

export function destination(value: string): string {
  try {
    return parsePhoneNumber(value);
  } catch {
    throw new CallPersistenceError('invalid_request');
  }
}

export function key(value: string): string {
  try {
    return parseIdempotencyKey(value);
  } catch {
    throw new CallPersistenceError('invalid_request');
  }
}

/** Inputs are explicit ordered tuples: no user object key ordering or omitted-field ambiguity. */
export function fingerprint(tuple: readonly unknown[]): string {
  return createHash('sha256').update(JSON.stringify(tuple)).digest('hex');
}

export interface AcceptCall {
  organizationId: string;
  campaignId: string;
  recipientId: string;
  idempotencyKey: string;
  previousAttemptId?: string;
  redialReason?: string;
}

export function canonicalRequest(input: AcceptCall) {
  const organizationId = uuid(input.organizationId);
  const campaignId = uuid(input.campaignId);
  const recipientId = uuid(input.recipientId);
  const previousAttemptId =
    input.previousAttemptId === undefined ? null : uuid(input.previousAttemptId);
  const redialReason = input.redialReason === undefined ? null : bounded(input.redialReason);
  if ((previousAttemptId === null) !== (redialReason === null))
    throw new CallPersistenceError('invalid_redial');
  return {
    organizationId,
    campaignId,
    recipientId,
    previousAttemptId,
    redialReason,
    idempotencyKey: key(input.idempotencyKey),
    fingerprint: fingerprint([
      1,
      'call.accept',
      organizationId,
      campaignId,
      recipientId,
      previousAttemptId,
      redialReason,
    ]),
  };
}

export type EventDisposition = 'APPLIED' | 'DUPLICATE' | 'CONFLICT' | 'ILLEGAL';
export function eventDisposition(from: CallState, to: CallState): EventDisposition {
  if (!Object.hasOwn(CALL_TRANSITIONS, from) || !Object.hasOwn(CALL_TRANSITIONS, to))
    throw new CallPersistenceError('invalid_request');
  if (from === to) return 'DUPLICATE';
  if (isTerminal(from)) return 'CONFLICT';
  return CALL_TRANSITIONS[from].includes(to) ? 'APPLIED' : 'ILLEGAL';
}

/** Sanitized neutral evidence only; untrusted provider payloads never reach diagnostics. */
export interface UsageEvidence {
  connectedSeconds: number;
  providerBillableSeconds?: number;
}
export function usageEvidence(input?: UsageEvidence): UsageEvidence | null {
  if (input === undefined) return null;
  if (
    !input ||
    !Number.isSafeInteger(input.connectedSeconds) ||
    input.connectedSeconds < 0 ||
    (input.providerBillableSeconds !== undefined &&
      (!Number.isSafeInteger(input.providerBillableSeconds) || input.providerBillableSeconds < 0))
  )
    throw new CallPersistenceError('invalid_request');
  return {
    connectedSeconds: input.connectedSeconds,
    ...(input.providerBillableSeconds === undefined
      ? {}
      : { providerBillableSeconds: input.providerBillableSeconds }),
  };
}
