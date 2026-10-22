import { randomUUID } from 'node:crypto';

import { createDatabaseClient, type PrismaClient } from '@truevine/database';
import { loadEnvFiles, requireEnv } from '@truevine/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  assertConnectedToDisposableDatabase,
  assertDisposableDatabase,
} from './disposable-database.js';
import { CallPersistence } from '../src/calls/call-persistence.js';
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
    await database.organization.createMany({
      data: [
        { id: organizationId, slug: `contacts-${run}`, name: 'W2-02 disposable test' },
        {
          id: otherOrganizationId,
          slug: `contacts-other-${run}`,
          name: 'W2-02 tenant boundary test',
        },
      ],
    });
    await database.membership.createMany({
      data: [organizationId, otherOrganizationId].map((tenantId) => ({
        organizationId: tenantId,
        userId: actorUserId,
        role: 'OWNER' as const,
      })),
    });
  });

  afterAll(async () => {
    await database?.$disconnect();
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
    })).rejects.toThrow('ContactAlreadyConsentedError');
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
      'phone,name,groups,consent,suppressed\n07720000002,Sam,Imported,yes,false\n07720000003,Jo,Imported,,true\n07720000002,Duplicate,Imported,,false';
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
      'phone,name,groups,suppressed\n07720000003,Jo Updated,,false\n07720000002,,NewSegment,false',
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
    const parsed = parseContactImportBatch('phone,name\n07720000021,Updated label', {});
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
    const parsed = parseContactImportBatch('phone,name\n07720000031,Should not merge', {});
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
});
