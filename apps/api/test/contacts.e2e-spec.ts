import { randomUUID } from 'node:crypto';

import { createDatabaseClient, type PrismaClient } from '@truevine/database';
import { loadEnvFiles, requireEnv } from '@truevine/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  assertConnectedToDisposableDatabase,
  assertDisposableDatabase,
} from './disposable-database.js';
import { CallPersistence } from '../src/calls/call-persistence.js';
import { ContactAlreadyConsentedError } from '../src/contacts/contact.store.js';
import {
  ContactPhoneRestrictedError,
  ContactPhoneConflictError,
} from '../src/contacts/contact.store.js';
import { ContactsService } from '../src/contacts/contacts.service.js';
import { PrismaContactStore } from '../src/contacts/prisma-contact.store.js';
import { parseContactImportBatch } from '../src/contacts/contact-import.csv.js';

describe('W2-02 PostgreSQL contacts acceptance', () => {
  let database: PrismaClient;
  let store: PrismaContactStore;
  const organizationId = randomUUID();
  const otherOrganizationId = randomUUID();
  const actorUserId = randomUUID();
  const run = randomUUID().replace(/-/g, '');
  const importId = randomUUID();

  beforeAll(async () => {
    loadEnvFiles();
    const url = requireEnv('DATABASE_URL');
    const expected = assertDisposableDatabase(url, process.env['NODE_ENV']);
    database = createDatabaseClient(url);
    let rows: Array<{ name: string }>;
    try {
      await database.$connect();
      rows = await database.$queryRaw<Array<{ name: string }>>`SELECT current_database() AS name`;
    } catch (error) {
      throw new Error(
        'W2-02 PostgreSQL tests require a running disposable database on the verified loopback URL.',
        { cause: error },
      );
    }
    await assertConnectedToDisposableDatabase(async () => rows[0]?.name, expected);
    store = new PrismaContactStore(database);
    await database.user.create({
      data: {
        id: actorUserId,
        email: `contacts-${run}@example.invalid`,
        passwordHash: 'test-only-not-used',
      },
    });
    await database.$transaction(async (transaction) => {
      await transaction.organization.createMany({
        data: [
          { id: organizationId, slug: `contacts-${run}`, name: 'W2-02 disposable test' },
          {
            id: otherOrganizationId,
            slug: `contacts-other-${run}`,
            name: 'W2-02 tenant boundary test',
          },
        ],
      });
      await transaction.membership.createMany({
        data: [organizationId, otherOrganizationId].map((tenantId) => ({
          organizationId: tenantId,
          userId: actorUserId,
          role: 'OWNER' as const,
        })),
      });
    });
  });

  afterAll(async () => {
    await database?.$disconnect();
  });

  describe('phone corrections', () => {
    const organizationId = randomUUID();
    const otherOrganizationId = randomUUID();
    beforeAll(async () => {
      await database.$transaction(async (tx) => {
        await tx.organization.createMany({
          data: [
            { id: organizationId, slug: 'phone-' + run, name: 'Phone correction tests' },
            { id: otherOrganizationId, slug: 'phone-other-' + run, name: 'Phone tenant boundary' },
          ],
        });
        await tx.membership.createMany({
          data: [organizationId, otherOrganizationId].map((id) => ({
            organizationId: id,
            userId: actorUserId,
            role: 'OWNER' as const,
          })),
        });
      });
    });
    async function phoneFixture(phoneE164: string, tenant = organizationId) {
      return store.createContact({
        organizationId: tenant,
        actorUserId,
        id: randomUUID(),
        phoneE164,
        name: 'Disposable phone correction',
        email: null,
        groupNames: [],
      });
    }

    it('normalizes a phone correction atomically, retains identity and groups, and audits field names without phone PII', async () => {
      const original = await store.createContact({
        organizationId,
        actorUserId,
        id: randomUUID(),
        phoneE164: '+256772000101',
        name: 'Correction',
        email: null,
        groupNames: [{ name: 'Correction group', normalizedName: 'correction group' }],
      });
      const result = await new ContactsService(store).updateContact(
        organizationId,
        actorUserId,
        original.id,
        { phone: '0772 000 102', name: 'Corrected' },
      );
      expect(result).toMatchObject({
        id: original.id,
        phone: '+256772000102',
        name: 'Corrected',
        voiceConsent: 'NOT_RECORDED',
        suppressed: false,
        groups: [{ id: original.groups[0]!.id }],
      });
      const persisted = await database.contact.findUniqueOrThrow({
        where: { organizationId_id: { organizationId, id: original.id } },
      });
      expect(persisted).toMatchObject({
        destination: '+256772000102',
        phoneE164: '+256772000102',
        voiceConsentAt: null,
        voiceConsentSource: null,
        suppressedAt: null,
      });
      const audit = await database.securityAuditEvent.findFirstOrThrow({
        where: { organizationId, targetId: original.id, action: 'contact.updated' },
      });
      expect(audit.metadata).toEqual({ fields: ['name', 'phone'] });
    });

    it('enforces tenant isolation and rejects both normalized and legacy organization duplicates without partial edits', async () => {
      const original = await phoneFixture('+256772000111');
      await phoneFixture('+256772000112');
      await phoneFixture('+256772000113', otherOrganizationId);
      const input = { organizationId, actorUserId, contactId: original.id, name: 'Must roll back' };
      await expect(
        store.updateContact({
          ...input,
          organizationId: otherOrganizationId,
          phoneE164: '+256772000114',
        }),
      ).resolves.toBeUndefined();
      await expect(
        store.updateContact({ ...input, phoneE164: '+256772000112' }),
      ).rejects.toBeInstanceOf(ContactPhoneConflictError);
      await database.contact.create({
        data: { organizationId, id: randomUUID(), destination: '+256772000115' },
      });
      await expect(
        store.updateContact({ ...input, phoneE164: '+256772000115' }),
      ).rejects.toBeInstanceOf(ContactPhoneConflictError);
      expect(
        await database.contact.findUniqueOrThrow({
          where: { organizationId_id: { organizationId, id: original.id } },
        }),
      ).toMatchObject({ label: original.name, phoneE164: original.phoneE164 });
      expect(
        await database.securityAuditEvent.count({
          where: { organizationId, targetId: original.id, action: 'contact.updated' },
        }),
      ).toBe(0);
      await expect(
        store.updateContact({ ...input, name: original.name, phoneE164: '+256772000113' }),
      ).resolves.toMatchObject({ phoneE164: '+256772000113' });
    });

    it('retains consent, suppression and recipient identity and still permits same-number/name updates', async () => {
      const consented = await phoneFixture('+256772000121');
      await store.recordVoiceConsent({
        organizationId,
        actorUserId,
        contactId: consented.id,
        consentedAt: new Date(Date.now() - 1000),
        source: 'test_form',
        purpose: 'voice_calling',
        evidenceReference: 'test-correction',
      });
      const suppressed = await phoneFixture('+256772000122');
      await store.suppressContact({
        organizationId,
        actorUserId,
        contactId: suppressed.id,
        reason: 'user_opt_out',
      });
      const referenced = await phoneFixture('+256772000123');
      const campaignId = randomUUID();
      await database.campaign.create({
        data: {
          organizationId,
          id: campaignId,
          name: 'Phone correction restriction',
          createdById: actorUserId,
        },
      });
      const recipient = await database.campaignRecipient.create({
        data: {
          organizationId,
          id: randomUUID(),
          campaignId,
          contactId: referenced.id,
          destination: referenced.phoneE164,
        },
      });
      for (const contact of [consented, suppressed, referenced]) {
        const before = await database.contact.findUniqueOrThrow({
          where: { organizationId_id: { organizationId, id: contact.id } },
        });
        await expect(
          store.updateContact({
            organizationId,
            actorUserId,
            contactId: contact.id,
            phoneE164: '+256772000124',
            name: 'Must not save',
          }),
        ).rejects.toBeInstanceOf(ContactPhoneRestrictedError);
        expect(
          await database.contact.findUniqueOrThrow({
            where: { organizationId_id: { organizationId, id: contact.id } },
          }),
        ).toEqual(before);
        await expect(
          new ContactsService(store).updateContact(organizationId, actorUserId, contact.id, {
            phone: contact.phoneE164,
            name: 'Name correction',
          }),
        ).resolves.toMatchObject({ phone: contact.phoneE164, name: 'Name correction' });
      }
      expect(
        await database.campaignRecipient.findUniqueOrThrow({
          where: { organizationId_id: { organizationId, id: recipient.id } },
        }),
      ).toEqual(recipient);
    });

    it('rejects partial evidence and suppression metadata even without their timestamp', async () => {
      const contact = await phoneFixture('+256772000131');
      for (const data of [
        { voiceConsentSource: 'legacy_evidence' },
        { voiceConsentPurpose: 'voice_calling' },
        { voiceConsentEvidenceReference: 'legacy-ref' },
        { voiceConsentVerifiedById: actorUserId },
        { suppressionReason: 'user_opt_out' },
      ]) {
        await database.contact.update({
          where: { organizationId_id: { organizationId, id: contact.id } },
          data: {
            voiceConsentSource: null,
            voiceConsentPurpose: null,
            voiceConsentEvidenceReference: null,
            voiceConsentVerifiedById: null,
            suppressionReason: null,
            ...data,
          },
        });
        await expect(
          store.updateContact({
            organizationId,
            actorUserId,
            contactId: contact.id,
            phoneE164: '+256772000132',
          }),
        ).rejects.toBeInstanceOf(ContactPhoneRestrictedError);
      }
    });

    it('allows only one concurrent correction to claim the same organization number', async () => {
      const contacts = await Promise.all([
        phoneFixture('+256772000141'),
        phoneFixture('+256772000142'),
      ]);
      const results = await Promise.allSettled(
        contacts.map((contact) =>
          store.updateContact({
            organizationId,
            actorUserId,
            contactId: contact.id,
            phoneE164: '+256772000143',
          }),
        ),
      );
      expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
      expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
      expect(
        await database.contact.count({ where: { organizationId, phoneE164: '+256772000143' } }),
      ).toBe(1);
    });

    it('rechecks contact:update permission in the transaction without borrowing another tenant role', async () => {
      const contact = await phoneFixture('+256772000171');
      const userId = randomUUID();
      await database.user.create({
        data: {
          id: userId,
          email: `phone-roles-${run}@example.invalid`,
          passwordHash: 'test-only-not-used',
        },
      });
      await database.membership.createMany({
        data: [
          { organizationId, userId, role: 'VIEWER' },
          { organizationId: otherOrganizationId, userId, role: 'ADMIN' },
        ],
      });
      for (const role of ['VIEWER', 'BILLING', 'ADMIN', 'CAMPAIGN_MANAGER'] as const) {
        await database.membership.update({
          where: { organizationId_userId: { organizationId, userId } },
          data: { role },
        });
        const change = store.updateContact({
          organizationId,
          actorUserId: userId,
          contactId: contact.id,
          phoneE164: '+256772000172',
        });
        if (role === 'VIEWER' || role === 'BILLING')
          await expect(change).rejects.toMatchObject({ status: 403 });
        else await expect(change).resolves.toMatchObject({ phoneE164: '+256772000172' });
      }
    });

    it('corrects an unreferenced legacy destination while preserving its contact ID', async () => {
      const id = randomUUID();
      await database.contact.create({ data: { organizationId, id, destination: '+256772000181' } });
      await expect(
        store.updateContact({
          organizationId,
          actorUserId,
          contactId: id,
          phoneE164: '+256772000182',
        }),
      ).resolves.toMatchObject({ id, phoneE164: '+256772000182' });
      expect(
        await database.contact.findUniqueOrThrow({
          where: { organizationId_id: { organizationId, id } },
        }),
      ).toMatchObject({ destination: '+256772000182', phoneE164: '+256772000182' });
    });

    it('rechecks committed suppression after waiting for a concurrent writer', async () => {
      const contact = await phoneFixture('+256772000151');
      let release!: () => void;
      let locked!: () => void;
      const ready = new Promise<void>((resolve) => {
        locked = resolve;
      });
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const writer = database.$transaction(async (tx) => {
        await tx.contact.update({
          where: { organizationId_id: { organizationId, id: contact.id } },
          data: { suppressedAt: new Date(), suppressionReason: 'user_opt_out' },
        });
        locked();
        await gate;
      });
      await ready;
      const correction = store.updateContact({
        organizationId,
        actorUserId,
        contactId: contact.id,
        phoneE164: '+256772000152',
      });
      release();
      await writer;
      await expect(correction).rejects.toBeInstanceOf(ContactPhoneRestrictedError);
    });

    it('rolls back the phone correction if the required audit cannot be inserted', async () => {
      const contact = await phoneFixture('+256772000161');
      const failedAuditStore = new PrismaContactStore(
        database.$extends({
          query: {
            securityAuditEvent: {
              create() {
                throw new Error('audit unavailable');
              },
            },
          },
        }) as unknown as PrismaClient,
      );
      await expect(
        failedAuditStore.updateContact({
          organizationId,
          actorUserId,
          contactId: contact.id,
          phoneE164: '+256772000162',
        }),
      ).rejects.toThrow('audit unavailable');
      expect(
        await database.contact.findUniqueOrThrow({
          where: { organizationId_id: { organizationId, id: contact.id } },
        }),
      ).toMatchObject({ destination: contact.phoneE164, phoneE164: contact.phoneE164 });
    });
  });

  it('scopes contacts and groups by organization and enforces consent plus current suppression at eligibility time', async () => {
    const group = await store.createGroup({
      organizationId,
      actorUserId,
      id: randomUUID(),
      name: 'Customers',
      normalizedName: 'customers',
    });
    const foreignGroup = await store.createGroup({
      organizationId: otherOrganizationId,
      actorUserId,
      id: randomUUID(),
      name: 'Foreign group',
      normalizedName: 'foreign group',
    });
    const contact = await store.createContact({
      organizationId,
      actorUserId,
      id: randomUUID(),
      phoneE164: '+256772000001',
      name: 'Ada',
      email: null,
      groupNames: [{ name: 'Customers', normalizedName: 'customers' }],
    });
    expect(await store.listContacts({ organizationId: otherOrganizationId, limit: 20 })).toEqual(
      [],
    );
    await expect(
      database.contactGroupMember.create({
        data: { organizationId, groupId: foreignGroup.id, contactId: contact.id },
      }),
    ).rejects.toMatchObject({ code: 'P2003' });
    expect(
      await store.listEligibleForExecution({ organizationId, groupIds: [group.id], limit: 10 }),
    ).toEqual([]);

    await store.recordVoiceConsent({
      organizationId, actorUserId, contactId: contact.id,
      consentedAt: new Date(Date.now() - 1_000), source: 'signed_form',
      purpose: 'voice_calling', evidenceReference: `fixture-${run}`,
    });
    expect(
      await store.listEligibleForExecution({ organizationId, groupIds: [group.id], limit: 10 }),
    ).toEqual([{ id: contact.id, phoneE164: '+256772000001' }]);
    await expect(store.recordVoiceConsent({
      organizationId, actorUserId, contactId: contact.id, consentedAt: new Date(),
      source: 'web_form', purpose: 'voice_calling', evidenceReference: `second-${run}`,
    })).rejects.toBeInstanceOf(ContactAlreadyConsentedError);
    expect(await store.recordVoiceConsent({
      organizationId: otherOrganizationId, actorUserId, contactId: contact.id,
      consentedAt: new Date(), source: 'signed_form', purpose: 'voice_calling', evidenceReference: `foreign-${run}`,
    })).toBeUndefined();
    const consentAudit = await database.securityAuditEvent.findFirst({
      where: { organizationId, actorUserId, targetId: contact.id, action: 'contact.voice_consent_recorded' },
    });
    expect(consentAudit?.metadata).toMatchObject({ purpose: 'voice_calling', source: 'signed_form', evidenceReference: `fixture-${run}` });
    await store.suppressContact({
      organizationId,
      actorUserId,
      contactId: contact.id,
      reason: 'user_opt_out',
    });
    expect(
      await store.listEligibleForExecution({ organizationId, groupIds: [group.id], limit: 10 }),
    ).toEqual([]);
    const unchangedSuppression = await store.suppressContact({
      organizationId,
      actorUserId,
      contactId: contact.id,
      reason: 'operator_request',
    });
    expect(unchangedSuppression?.suppressionReason).toBe('user_opt_out');
  });

  it('requires contact-group creators to be members of the same organization in PostgreSQL', async () => {
    const nonMemberUserId = randomUUID();
    await database.user.create({
      data: {
        id: nonMemberUserId,
        email: `nonmember-${run}@example.invalid`,
        passwordHash: 'test-only-not-used',
      },
    });
    await expect(
      database.contactGroup.create({
        data: {
          organizationId,
          id: randomUUID(),
          name: 'Invalid creator',
          normalizedName: 'invalid creator',
          createdById: nonMemberUserId,
        },
      }),
    ).rejects.toMatchObject({ code: 'P2003' });
  });

  it('processes resumable imports idempotently without granting consent or clearing suppression', async () => {
    await store.createImport({ organizationId, actorUserId, importId, mapping: {} });
    const csv =
      'phone,name,groups,consent,suppressed\n0772000002,Sam,Imported,yes,false\n0772000003,Jo,Imported,,true\n0772000002,Duplicate,Imported,,false';
    const parsed = parseContactImportBatch(csv, {});
    const batch = {
      organizationId,
      actorUserId,
      importId,
      batchNumber: 0,
      payloadHash: 'a'.repeat(64),
      rows: parsed.rows,
      resolvedMapping: parsed.resolvedMapping,
    };
    const first = await store.processImportBatch(batch);
    expect(first.rows.map((row) => row.outcome)).toEqual(['CREATED', 'CREATED', 'REJECTED']);
    expect(first.rows[0]?.warningCodes).toContain('consent_not_granted_from_import');
    expect(first.summary).toMatchObject({
      created: 2,
      rejected: 1,
      warnings: 1,
      nextBatchNumber: 1,
    });
    expect((await store.processImportBatch(batch)).summary).toEqual(first.summary);
    await expect(
      store.processImportBatch({ ...batch, payloadHash: 'b'.repeat(64) }),
    ).rejects.toThrow('import_batch_conflict');

    const followUp = parseContactImportBatch(
      'phone,name,groups,suppressed\n0772000003,Jo Updated,,false\n0772000002,,NewSegment,false',
      {},
    );
    const followUpResult = await store.processImportBatch({
      organizationId,
      actorUserId,
      importId,
      batchNumber: 1,
      payloadHash: 'c'.repeat(64),
      rows: followUp.rows,
      resolvedMapping: followUp.resolvedMapping,
    });
    expect(followUpResult.summary.updated).toBe(2);

    const contacts = await store.listContacts({ organizationId, limit: 20 });
    const importedOptIn = contacts.find((contact) => contact.phoneE164 === '+256772000002');
    const importedOptOut = contacts.find((contact) => contact.phoneE164 === '+256772000003');
    expect(importedOptIn?.voiceConsentAt).toBeNull();
    expect(importedOptIn?.suppressedAt).toBeNull();
    expect(importedOptOut?.suppressedAt).not.toBeNull();
    expect(importedOptOut?.suppressionReason).toBe('user_opt_out');
    await expect(store.getImportRecord(otherOrganizationId, importId)).resolves.toBeUndefined();
    await expect(store.getImportSummary(otherOrganizationId, importId)).resolves.toBeUndefined();
  });

  it('adopts legacy campaign contacts without changing IDs, labels, or recipient snapshots', async () => {
    const legacyId = randomUUID();
    const campaignId = randomUUID();
    const recipientId = randomUUID();
    const destination = '+256772000021';
    await database.contact.create({
      data: {
        organizationId,
        id: legacyId,
        destination,
        label: 'Legacy label',
      },
    });
    await database.campaign.create({
      data: {
        organizationId,
        id: campaignId,
        name: 'Legacy campaign',
        status: 'DRAFT',
        createdById: actorUserId,
      },
    });
    await database.campaignRecipient.create({
      data: {
        organizationId,
        id: recipientId,
        campaignId,
        contactId: legacyId,
        destination,
      },
    });

    const legacyImportId = randomUUID();
    await store.createImport({ organizationId, actorUserId, importId: legacyImportId, mapping: {} });
    const parsed = parseContactImportBatch('phone,name\n0772000021,Updated label', {});
    const result = await store.processImportBatch({
      organizationId,
      actorUserId,
      importId: legacyImportId,
      batchNumber: 0,
      payloadHash: 'd'.repeat(64),
      rows: parsed.rows,
      resolvedMapping: parsed.resolvedMapping,
    });
    expect(result.rows[0]?.outcome).toBe('UPDATED');
    const adopted = await database.contact.findUniqueOrThrow({
      where: { organizationId_id: { organizationId, id: legacyId } },
    });
    expect(adopted).toMatchObject({
      id: legacyId,
      destination,
      phoneE164: destination,
      label: 'Updated label',
      email: null,
      voiceConsentAt: null,
      suppressedAt: null,
    });
    expect(
      await database.campaignRecipient.findUniqueOrThrow({
        where: { organizationId_id: { organizationId, id: recipientId } },
      }),
    ).toMatchObject({ contactId: legacyId, destination });

    await new CallPersistence(database).updateContact(organizationId, legacyId, '+256772000022');
    const updated = await database.contact.findUniqueOrThrow({
      where: { organizationId_id: { organizationId, id: legacyId } },
    });
    expect(updated).toMatchObject({ destination: '+256772000022', phoneE164: '+256772000022' });
    expect(
      await database.campaignRecipient.findUniqueOrThrow({
        where: { organizationId_id: { organizationId, id: recipientId } },
      }),
    ).toMatchObject({ contactId: legacyId, destination });
  });

  it('rejects ambiguous legacy duplicates without selecting or deleting a record', async () => {
    const destination = '+256772000031';
    const legacyIds = [randomUUID(), randomUUID()];
    await database.contact.createMany({
      data: legacyIds.map((id, index) => ({
        organizationId,
        id,
        destination,
        label: `Legacy ${index}`,
      })),
    });
    const duplicateImportId = randomUUID();
    await store.createImport({ organizationId, actorUserId, importId: duplicateImportId, mapping: {} });
    const parsed = parseContactImportBatch('phone,name\n0772000031,Should not merge', {});
    const result = await store.processImportBatch({
      organizationId,
      actorUserId,
      importId: duplicateImportId,
      batchNumber: 0,
      payloadHash: 'e'.repeat(64),
      rows: parsed.rows,
      resolvedMapping: parsed.resolvedMapping,
    });
    expect(result.rows[0]).toMatchObject({
      outcome: 'REJECTED',
      code: 'ambiguous_existing_duplicate',
    });
    expect(
      await database.contact.findMany({ where: { organizationId, id: { in: legacyIds } } }),
    ).toHaveLength(2);
    expect(
      await database.contact.count({ where: { organizationId, phoneE164: destination } }),
    ).toBe(0);
  });

  it('deletes contacts within the tenant and retains suppressed or campaign-referenced records', async () => {
    const deletable = await store.createContact({
      organizationId,
      actorUserId,
      id: randomUUID(),
      phoneE164: '+256772000061',
      name: 'Synthetic disposable contact',
      email: null,
      groupNames: [],
    });
    await expect(store.deleteContact({ organizationId, actorUserId, contactId: deletable.id })).resolves.toBe('DELETED');
    await expect(
      database.contact.findUnique({ where: { organizationId_id: { organizationId, id: deletable.id } } }),
    ).resolves.toBeNull();
    await expect(
      database.securityAuditEvent.findFirst({
        where: { organizationId, actorUserId, action: 'contact.deleted', targetId: deletable.id },
      }),
    ).resolves.not.toBeNull();

    const foreign = await store.createContact({
      organizationId: otherOrganizationId,
      actorUserId,
      id: randomUUID(),
      phoneE164: '+256772000062',
      name: 'Synthetic foreign-tenant contact',
      email: null,
      groupNames: [],
    });
    await expect(store.deleteContact({ organizationId, actorUserId, contactId: foreign.id })).resolves.toBe('NOT_FOUND');
    await expect(
      database.contact.findUnique({ where: { organizationId_id: { organizationId: otherOrganizationId, id: foreign.id } } }),
    ).resolves.not.toBeNull();

    const suppressed = await store.createContact({
      organizationId,
      actorUserId,
      id: randomUUID(),
      phoneE164: '+256772000063',
      name: 'Synthetic opted-out contact',
      email: null,
      groupNames: [],
    });
    await store.suppressContact({ organizationId, actorUserId, contactId: suppressed.id, reason: 'user_opt_out' });
    await expect(store.deleteContact({ organizationId, actorUserId, contactId: suppressed.id })).resolves.toBe('SUPPRESSED');

    const referenced = await store.createContact({
      organizationId,
      actorUserId,
      id: randomUUID(),
      phoneE164: '+256772000064',
      name: 'Synthetic campaign-history contact',
      email: null,
      groupNames: [],
    });
    const campaignId = randomUUID();
    await database.campaign.create({
      data: { organizationId, id: campaignId, name: `Delete guard ${run}`, status: 'DRAFT', createdById: actorUserId },
    });
    await database.campaignRecipient.create({
      data: { organizationId, id: randomUUID(), campaignId, contactId: referenced.id, destination: referenced.phoneE164 },
    });
    await expect(store.deleteContact({ organizationId, actorUserId, contactId: referenced.id })).resolves.toBe('HAS_RECIPIENTS');
    await expect(
      database.contact.findUnique({ where: { organizationId_id: { organizationId, id: referenced.id } } }),
    ).resolves.not.toBeNull();
  });
});
