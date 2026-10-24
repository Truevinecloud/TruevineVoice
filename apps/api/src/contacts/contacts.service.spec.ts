import { describe, expect, it, vi } from 'vitest';

import { ContactsService } from './contacts.service.js';
import type { ContactStore } from './contact.store.js';

const contactRecord = {
  organizationId: 'org-a',
  id: '10000000-0000-4000-8000-000000000001',
  phoneE164: '+256772000001',
  name: null,
  email: null,
  voiceConsentAt: null,
  suppressedAt: null,
  suppressionReason: null,
  createdAt: new Date('2026-10-22T00:00:00Z'),
  updatedAt: new Date('2026-10-22T00:00:00Z'),
  groups: [],
};

describe('ContactsService', () => {
  it('normalizes Uganda phones and never creates a consent or unsuppressed opt-in claim', async () => {
    const createContact = vi.fn(async () => contactRecord);
    const service = new ContactsService({ createContact } as unknown as ContactStore);

    const result = await service.createContact('org-a', 'user-a', { phone: '0772 000 001' });

    expect(createContact).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: 'org-a',
        phoneE164: '+256772000001',
        name: null,
        email: null,
      }),
    );
    expect(result).toMatchObject({ voiceConsent: 'NOT_RECORDED', suppressed: false });
  });

  it('rejects attempts to edit consent or clear suppression through contact updates', async () => {
    const updateContact = vi.fn();
    const service = new ContactsService({ updateContact } as unknown as ContactStore);
    const id = contactRecord.id;

    await expect(
      service.updateContact('org-a', 'user-a', id, { voiceConsent: true }),
    ).rejects.toThrow();
    await expect(
      service.updateContact('org-a', 'user-a', id, { suppressed: false }),
    ).rejects.toThrow();
    expect(updateContact).not.toHaveBeenCalled();
  });

  it('deletes only an unreferenced, unsuppressed contact and preserves refusal statuses', async () => {
    const deleteContact = vi.fn()
      .mockResolvedValueOnce('DELETED')
      .mockResolvedValueOnce('SUPPRESSED')
      .mockResolvedValueOnce('HAS_RECIPIENTS')
      .mockResolvedValueOnce('NOT_FOUND');
    const service = new ContactsService({ deleteContact } as unknown as ContactStore);

    await expect(service.deleteContact('org-a', 'user-a', contactRecord.id)).resolves.toEqual({ deleted: true });
    await expect(service.deleteContact('org-a', 'user-a', contactRecord.id)).rejects.toMatchObject({
      response: { error: { code: 'suppressed_contact_retained' } },
    });
    await expect(service.deleteContact('org-a', 'user-a', contactRecord.id)).rejects.toMatchObject({
      response: { error: { code: 'contact_has_campaign_history' } },
    });
    await expect(service.deleteContact('org-a', 'user-a', contactRecord.id)).rejects.toMatchObject({
      response: { error: { code: 'contact_not_found' } },
    });
    expect(deleteContact).toHaveBeenCalledTimes(4);
    expect(deleteContact).toHaveBeenCalledWith({
      organizationId: 'org-a',
      actorUserId: 'user-a',
      contactId: contactRecord.id,
    });
  });

  it('records consent only with verified evidence and a valid timestamp, purpose and opaque reference', async () => {
    const recordVoiceConsent = vi.fn(async () => ({ ...contactRecord, voiceConsentAt: new Date('2026-10-21T12:00:00Z') }));
    const service = new ContactsService({ recordVoiceConsent } as unknown as ContactStore);
    const id = contactRecord.id;
    const evidence = {
      consentedAt: '2026-10-21T12:00:00Z', source: 'signed_form', purpose: 'voice_calling',
      evidenceReference: 'form-123', sourceVerified: true,
    };
    await service.recordVoiceConsent('org-a', 'user-a', id, evidence);
    expect(recordVoiceConsent).toHaveBeenCalledWith(expect.objectContaining({
      organizationId: 'org-a', actorUserId: 'user-a', contactId: id,
      purpose: 'voice_calling', evidenceReference: 'form-123',
    }));
    for (const invalidInput of [
      { ...evidence, sourceVerified: false },
      { ...evidence, purpose: 'marketing' },
      { ...evidence, source: 'person name or private URL' },
      { ...evidence, evidenceReference: 'https://private.example/form' },
      { ...evidence, consentedAt: '2026-10-21' },
    ]) {
      await expect(service.recordVoiceConsent('org-a', 'user-a', id, invalidInput)).rejects.toThrow();
    }
    expect(recordVoiceConsent).toHaveBeenCalledTimes(1);
  });

  it('asks the store for current dispatch eligibility under the authenticated organization', async () => {
    const listEligibleForExecution = vi.fn(async () => []);
    const service = new ContactsService({ listEligibleForExecution } as unknown as ContactStore);
    const groupId = '20000000-0000-4000-8000-000000000002';

    await service.recipientsForExecution('org-a', [groupId]);

    expect(listEligibleForExecution).toHaveBeenCalledWith({
      organizationId: 'org-a',
      groupIds: [groupId],
      limit: 10_000,
    });
  });
});
