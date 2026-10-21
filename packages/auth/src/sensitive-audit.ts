import { AuthError } from './errors.js';
import { isSafeAuditMetadata } from './audit.js';

export interface AuditReason {
  readonly reasonCode?: unknown;
  readonly justification?: unknown;
}
const CALLER_REASONS = new Set([
  'routine_administration',
  'security_incident',
  'membership_request',
  'correction',
  'customer_request',
]);
/** Existing clients retain explicit server purpose codes; supplied reasons are validated. */
export function auditReason(input: unknown, serverCode: string) {
  if (input === undefined)
    return { reasonCode: serverCode, justification: null, reasonSource: 'server' };
  const invalid = (): never => {
    throw new AuthError('invalid_audit_reason', 'A valid audit reason is required.', 400);
  };
  if (!input || typeof input !== 'object' || Array.isArray(input)) return invalid();
  const reason = input as AuditReason;
  if (typeof reason.reasonCode !== 'string' || !CALLER_REASONS.has(reason.reasonCode))
    return invalid();
  const justification = auditJustification(reason.justification);
  return { reasonCode: reason.reasonCode, justification, reasonSource: 'caller' };
}

/** Shared bounded, sanitized text for supported reason-bearing commands. */
export function auditJustification(value: unknown): string | null {
  if (value === undefined) return null;
  if (typeof value !== 'string' || !value.trim() || value.length > 300)
    throw new AuthError('invalid_audit_reason', 'A valid audit justification is required.', 400);
  const text = value.trim();
  return /(?:password|token|secret|api[_ -]?key|authorization|cookie)\s*[:=]|bearer\s|-----BEGIN|postgres(?:ql)?:\/\/|\b(?:\d[ -]?){13,19}\b/i.test(
    text,
  )
    ? '[REDACTED]'
    : text;
}
/** Additive JSON contract in the existing audit trails. Callers project minimal states. */
export function sensitiveAudit(input: {
  targetType: string;
  targetId: string;
  before: Readonly<Record<string, unknown>> | null;
  change: Readonly<Record<string, unknown>>;
  after: Readonly<Record<string, unknown>> | null;
  reasonCode: string;
  justification?: string | null;
  reasonSource?: string;
  requestId?: string | null;
}): Record<string, unknown> {
  if (!input.targetType || !input.targetId || !/^[a-z][a-z0-9_]{0,63}$/.test(input.reasonCode))
    throw new Error('Invalid sensitive audit contract.');
  const metadata = {
    auditVersion: 1,
    target: { type: input.targetType, id: input.targetId },
    before: input.before,
    change: input.change,
    after: input.after,
    reasonCode: input.reasonCode,
    justification: auditJustification(input.justification ?? undefined),
    reasonSource: input.reasonSource ?? 'server',
    requestId: input.requestId ?? null,
  };
  if (!isSafeAuditMetadata(metadata)) throw new Error('Unsafe sensitive audit metadata.');
  return metadata;
}
