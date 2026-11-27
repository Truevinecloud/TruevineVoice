import { describe, expect, it } from 'vitest';

import { canonicalCampaignCallInitiation, CALL_OPERATION_TYPES, CallPersistenceError } from './call-contract.js';

const request = {
  organizationId: '00000000-0000-4000-8000-000000000001',
  campaignId: '00000000-0000-4000-8000-000000000002',
  recipientId: '00000000-0000-4000-8000-000000000003',
  attemptId: '00000000-0000-4000-8000-000000000004',
  attemptNumber: 1,
  destination: '+15550001111',
  bindingSource: 'w402-recovery-test',
};

describe('call operation contracts', () => {
  it('canonicalizes campaign initiation identity and fingerprints request fields', () => {
    const canonical = canonicalCampaignCallInitiation(request);
    expect(canonical.operation).toBe(CALL_OPERATION_TYPES.campaignCallInitiation);
    expect(canonical.idempotencyKey).toBe(
      `${request.organizationId}:${request.campaignId}:${request.recipientId}:1`,
    );
    expect(canonical.fingerprintVersion).toBe(1);
    expect(canonical.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(canonicalCampaignCallInitiation(request).fingerprint).toBe(canonical.fingerprint);
    expect(
      canonicalCampaignCallInitiation({ ...request, destination: '+15550001112' }).fingerprint,
    ).not.toBe(canonical.fingerprint);
    expect(
      canonicalCampaignCallInitiation({ ...request, bindingSource: 'another-provider-account' }).fingerprint,
    ).not.toBe(canonical.fingerprint);
    expect(
      canonicalCampaignCallInitiation({
        ...request,
        attemptId: '00000000-0000-4000-8000-000000000005',
      }).fingerprint,
    ).not.toBe(canonical.fingerprint);
  });

  it('rejects campaign initiation for an unsupported attempt number', () => {
    expect(() => canonicalCampaignCallInitiation({ ...request, attemptNumber: 2 })).toThrow(
      CallPersistenceError,
    );
  });
});
