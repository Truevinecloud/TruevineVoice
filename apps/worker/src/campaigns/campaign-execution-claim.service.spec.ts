import { describe, expect, it } from 'vitest';

import { CampaignExecutionClaimService } from './campaign-execution-claim.service.js';

function makePrisma(overrides: Record<string, unknown> = {}) {
  const {
    execution = { id: 'exec-1', organizationId: 'org-1', campaignId: 'camp-1' },
    campaign = { organizationId: 'org-1', id: 'camp-1', status: 'ACTIVE' },
    recipient = { id: 'recipient-1', organizationId: 'org-1', campaignId: 'camp-1', contactId: 'contact-1', destination: '+123' },
    existing = null,
  } = overrides;

  const tx = {
    campaignExecution: { findUnique: async () => execution },
    campaign: { findUnique: async () => campaign },
    campaignRecipient: { findUnique: async () => recipient },
    callAttempt: {
      findFirst: async () => existing,
      create: async () => ({ id: 'attempt-1' }),
    },
    callInitiationReconciliation: {
      create: async () => ({ attemptId: 'attempt-1' }),
    },
  };
  return { $transaction: async (work: (tx: unknown) => Promise<unknown>) => work(tx) } as never;
}

describe('CampaignExecutionClaimService', () => {
  it('claims a new attempt', async () => {
    const service = new CampaignExecutionClaimService(makePrisma());
    await expect(service.claim({ organizationId: 'org-1', campaignId: 'camp-1', recipientId: 'contact-1' })).resolves.toEqual({ status: 'claimed', attemptId: 'attempt-1' });
  });

  it('returns already_claimed for existing attempt', async () => {
    const service = new CampaignExecutionClaimService(makePrisma({ existing: { id: 'attempt-0', state: 'QUEUED' } }));
    await expect(service.claim({ organizationId: 'org-1', campaignId: 'camp-1', recipientId: 'contact-1' })).resolves.toEqual({ status: 'already_claimed', attemptId: 'attempt-0' });
  });

  it('returns already_completed for completed attempt', async () => {
    const service = new CampaignExecutionClaimService(makePrisma({ existing: { id: 'attempt-0', state: 'COMPLETED' } }));
    await expect(service.claim({ organizationId: 'org-1', campaignId: 'camp-1', recipientId: 'contact-1' })).resolves.toEqual({ status: 'already_completed', attemptId: 'attempt-0' });
  });

  it('returns missing_execution when absent', async () => {
    const service = new CampaignExecutionClaimService(makePrisma({ execution: null }));
    await expect(service.claim({ organizationId: 'org-1', campaignId: 'camp-1', recipientId: 'contact-1' })).resolves.toEqual({ status: 'missing_execution' });
  });

  it('returns organization_mismatch', async () => {
    const service = new CampaignExecutionClaimService(makePrisma({ campaign: { organizationId: 'other', id: 'camp-1', status: 'ACTIVE' } }));
    await expect(service.claim({ organizationId: 'org-1', campaignId: 'camp-1', recipientId: 'contact-1' })).resolves.toEqual({ status: 'organization_mismatch' });
  });

  it('returns cancelled', async () => {
    const service = new CampaignExecutionClaimService(makePrisma({ campaign: { organizationId: 'org-1', id: 'camp-1', status: 'CANCELLED' } }));
    await expect(service.claim({ organizationId: 'org-1', campaignId: 'camp-1', recipientId: 'contact-1' })).resolves.toEqual({ status: 'cancelled' });
  });

  it('returns paused', async () => {
    const service = new CampaignExecutionClaimService(makePrisma({ campaign: { organizationId: 'org-1', id: 'camp-1', status: 'PAUSED' } }));
    await expect(service.claim({ organizationId: 'org-1', campaignId: 'camp-1', recipientId: 'contact-1' })).resolves.toEqual({ status: 'paused' });
  });

  it('returns ineligible_recipient', async () => {
    const service = new CampaignExecutionClaimService(makePrisma({ recipient: null }));
    await expect(service.claim({ organizationId: 'org-1', campaignId: 'camp-1', recipientId: 'contact-1' })).resolves.toEqual({ status: 'ineligible_recipient' });
  });
});