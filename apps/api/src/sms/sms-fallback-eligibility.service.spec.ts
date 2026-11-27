import { describe, expect, it } from 'vitest';

import { SmsFallbackEligibilityService } from './sms-fallback-eligibility.service.js';

describe('SmsFallbackEligibilityService', () => {
  const service = new SmsFallbackEligibilityService();

  const baseInput = {
    organizationId: 'org-1',
    campaignId: 'camp-1',
    voiceAttemptId: 'attempt-1',
    voiceOutcome: 'FAILED',
    voiceTerminal: true,
    recipientId: 'recipient-1',
    recipientPhone: '+256700000000',
    recipientSuppressed: false,
    recipientSmsConsent: true,
    campaignSmsEnabled: true,
    organizationSmsEntitled: true,
    providerReady: true,
    billingAuthorized: true,
    operationalStop: false,
    approvedMessage: 'Your voice call failed. Please call back.',
  };

  it('returns eligible when all checks pass', () => {
    const result = service.evaluate(baseInput);
    expect(result.status).toBe('eligible');
    expect(result.reason).toBeNull();
  });

  it('rejects non-terminal voice call', () => {
    const result = service.evaluate({ ...baseInput, voiceTerminal: false });
    expect(result.status).toBe('not_terminal');
  });

  it('rejects answered voice call', () => {
    const result = service.evaluate({ ...baseInput, voiceOutcome: 'ANSWERED' });
    expect(result.status).toBe('not_terminal');
  });

  it('rejects completed voice call', () => {
    const result = service.evaluate({ ...baseInput, voiceOutcome: 'COMPLETED' });
    expect(result.status).toBe('not_terminal');
  });

  it('rejects when campaign SMS is not enabled', () => {
    const result = service.evaluate({ ...baseInput, campaignSmsEnabled: false });
    expect(result.status).toBe('sms_not_enabled');
  });

  it('rejects when organization has no SMS entitlement', () => {
    const result = service.evaluate({ ...baseInput, organizationSmsEntitled: false });
    expect(result.status).toBe('no_entitlement');
  });

  it('rejects when recipient is suppressed', () => {
    const result = service.evaluate({ ...baseInput, recipientSuppressed: true });
    expect(result.status).toBe('suppressed_recipient');
  });

  it('rejects when recipient has no SMS consent', () => {
    const result = service.evaluate({ ...baseInput, recipientSmsConsent: false });
    expect(result.status).toBe('suppressed_recipient');
  });

  it('rejects when phone number is missing', () => {
    const result = service.evaluate({ ...baseInput, recipientPhone: null });
    expect(result.status).toBe('invalid_phone_number');
  });

  it('rejects when no approved message exists', () => {
    const result = service.evaluate({ ...baseInput, approvedMessage: null });
    expect(result.status).toBe('no_approved_message');
  });

  it('rejects when provider is not ready', () => {
    const result = service.evaluate({ ...baseInput, providerReady: false });
    expect(result.status).toBe('provider_not_ready');
  });

  it('rejects when billing is not authorized', () => {
    const result = service.evaluate({ ...baseInput, billingAuthorized: false });
    expect(result.status).toBe('billing_not_authorized');
  });

  it('rejects when operational stop is active', () => {
    const result = service.evaluate({ ...baseInput, operationalStop: true });
    expect(result.status).toBe('operational_restriction');
  });

  it('rejects when voice outcome is busy (eligible terminal)', () => {
    const result = service.evaluate({ ...baseInput, voiceOutcome: 'BUSY' });
    expect(result.status).toBe('eligible');
  });

  it('rejects when voice outcome is no_answer (eligible terminal)', () => {
    const result = service.evaluate({ ...baseInput, voiceOutcome: 'NO_ANSWER' });
    expect(result.status).toBe('eligible');
  });

  it('rejects when voice outcome is timeout (eligible terminal)', () => {
    const result = service.evaluate({ ...baseInput, voiceOutcome: 'TIMEOUT' });
    expect(result.status).toBe('eligible');
  });
});
