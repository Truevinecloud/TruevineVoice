import { describe, expect, it } from 'vitest';
import { auditReason, sensitiveAudit } from './sensitive-audit.js';
import { isSafeAuditMetadata } from './audit.js';

describe('sensitive audit contract', () => {
  it('preserves client compatibility with an explicit server purpose', () => {
    expect(auditReason(undefined, 'membership_role_change')).toEqual({
      reasonCode: 'membership_role_change',
      justification: null,
      reasonSource: 'server',
    });
  });
  it.each([
    null,
    {},
    [],
    { reasonCode: '' },
    { reasonCode: 'invented' },
    { reasonCode: 'correction', justification: '' },
    { reasonCode: 'correction', justification: 'x'.repeat(301) },
  ])('rejects an invalid supplied reason (%j)', (input) => {
    expect(() => auditReason(input, 'fallback')).toThrow(
      expect.objectContaining({ code: 'invalid_audit_reason', status: 400 }),
    );
  });
  it('retains a bounded operational justification and redacts credential-bearing text', () => {
    expect(
      auditReason({ reasonCode: 'correction', justification: ' Reviewed request ' }, 'unused'),
    ).toMatchObject({
      justification: 'Reviewed request',
      reasonSource: 'caller',
    });
    for (const justification of [
      'password=do-not-retain',
      'Bearer private-value',
      'postgresql://secret@db/database',
      '4111 1111 1111 1111',
    ])
      expect(auditReason({ reasonCode: 'correction', justification }, 'unused').justification).toBe(
        '[REDACTED]',
      );
  });
  it.each(['password', 'access_token', 'API-KEY', 'private_key', 'cvv', 'cardNumber'])(
    'refuses forbidden keys at any depth: %s',
    (key) => {
      expect(
        isSafeAuditMetadata({ before: { nested: [{ [key]: 'must-not-enter-history' }] } }),
      ).toBe(false);
    },
  );
  it('refuses cycles, non-JSON values and excessive nesting without throwing secrets', () => {
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    expect(isSafeAuditMetadata(cycle)).toBe(false);
    expect(isSafeAuditMetadata({ value: 1n })).toBe(false);
    expect(isSafeAuditMetadata({ value: Number.NaN })).toBe(false);
    expect(isSafeAuditMetadata({ value: new Date() })).toBe(false);
  });
  it('requires an explicit target and code, and builds an additive versioned record', () => {
    const input = {
      targetType: 'membership',
      targetId: 'user-a',
      before: { role: 'VIEWER' },
      change: { role: 'ADMIN' },
      after: { role: 'ADMIN' },
      reasonCode: 'membership_role_change',
    };
    expect(sensitiveAudit(input)).toMatchObject({
      auditVersion: 1,
      target: { type: 'membership', id: 'user-a' },
      before: input.before,
      change: input.change,
      after: input.after,
      requestId: null,
    });
    expect(() => sensitiveAudit({ ...input, targetId: '' })).toThrow(
      'Invalid sensitive audit contract',
    );
    expect(() => sensitiveAudit({ ...input, reasonCode: '' })).toThrow(
      'Invalid sensitive audit contract',
    );
    expect(() => sensitiveAudit({ ...input, before: { password: 'unsafe' } })).toThrow(
      'Unsafe sensitive audit',
    );
  });
});
