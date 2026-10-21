import { describe, expect, it } from 'vitest';
import { canonicalRequest, destination, eventDisposition, usageEvidence } from './call-contract.js';
import { CallPersistence, type CallDatabase } from './call-persistence.js';

const org = '11111111-1111-4111-8111-111111111111';
const campaign = '22222222-2222-4222-8222-222222222222';
const recipient = '33333333-3333-4333-8333-333333333333';
const request = {
  organizationId: org,
  campaignId: campaign,
  recipientId: recipient,
  idempotencyKey: 'request-1',
};

describe('internal call persistence contracts', () => {
  it('canonicalizes key whitespace and UUID case with a stable versioned fingerprint', () => {
    expect(canonicalRequest({ ...request, idempotencyKey: ' request-1 ' })).toEqual(
      canonicalRequest(request),
    );
    const changed = canonicalRequest({ ...request, recipientId: org });
    expect(changed.fingerprint).not.toBe(canonicalRequest(request).fingerprint);
    expect(
      canonicalRequest({ ...request, previousAttemptId: org, redialReason: ' Retry ' }).fingerprint,
    ).toBe(
      canonicalRequest({ ...request, previousAttemptId: org, redialReason: 'Retry' }).fingerprint,
    );
  });
  it('rejects incomplete redials, invalid keys, tenant IDs and phone numbers without echoing PII', () => {
    expect(() => canonicalRequest({ ...request, previousAttemptId: org })).toThrow(
      'invalid_redial',
    );
    expect(() => canonicalRequest({ ...request, idempotencyKey: ' ' })).toThrow('invalid_request');
    expect(() => canonicalRequest({ ...request, organizationId: '' })).toThrow('invalid_request');
    expect(() => destination('sensitive invalid value')).toThrow(/^invalid_request$/);
    expect(destination(' +256700000001 ')).toBe('+256700000001');
  });
  it('distinguishes duplicates, conflicting late states and illegal transitions', () => {
    expect(eventDisposition('COMPLETED', 'COMPLETED')).toBe('DUPLICATE');
    expect(eventDisposition('COMPLETED', 'FAILED')).toBe('CONFLICT');
    expect(eventDisposition('COMPLETED', 'RINGING')).toBe('CONFLICT');
    expect(eventDisposition('QUEUED', 'COMPLETED')).toBe('ILLEGAL');
    expect(eventDisposition('ANSWERED', 'COMPLETED')).toBe('APPLIED');
  });
  it('retains only validated neutral provider evidence and never derives billable usage', () => {
    expect(usageEvidence({ connectedSeconds: 3, providerBillableSeconds: 60 })).toEqual({
      connectedSeconds: 3,
      providerBillableSeconds: 60,
    });
    expect(() => usageEvidence({ connectedSeconds: 0.5 })).toThrow('invalid_request');
    expect(() => usageEvidence({ connectedSeconds: Number.MAX_SAFE_INTEGER + 1 })).toThrow(
      'invalid_request',
    );
    expect(() => usageEvidence({ connectedSeconds: 3, providerBillableSeconds: -1 })).toThrow(
      'invalid_request',
    );
  });
  it('validates before entering a transaction', async () => {
    let entered = false;
    const database: CallDatabase = {
      $queryRaw: async <T>() => [] as T,
      $executeRaw: async () => 0,
      $transaction: async () => {
        entered = true;
        throw new Error('unexpected');
      },
    };
    await expect(
      new CallPersistence(database).accept({ ...request, idempotencyKey: '' }),
    ).rejects.toMatchObject({ code: 'invalid_request' });
    expect(entered).toBe(false);
  });
});
