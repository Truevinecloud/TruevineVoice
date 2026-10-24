import { randomUUID } from 'node:crypto';

import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';

import {
  IMPORT_FIELDS,
  importPayloadHash,
  MAX_IMPORT_BATCH_ROWS,
  parseContactImportBatch,
  type ColumnMapping,
} from './contact-import.csv.js';
import {
  CONTACT_STORE,
  ContactAlreadyConsentedError,
  type ContactRecord,
  type ContactStore,
  type ContactGroupRecord,
  type ContactImportSummary,
} from './contact.store.js';
import { normalizePhoneE164 } from './contact-import.csv.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SUPPRESSION_REASONS = [
  'user_opt_out',
  'operator_request',
  'invalid_number',
  'other',
] as const;

function invalid(message: string): never {
  throw new BadRequestException({ error: { code: 'invalid_contact', message } });
}

export class ContactConflictError extends Error {}
export class ContactImportNotFoundError extends Error {}
export class ContactImportConflictError extends Error {}

@Injectable()
export class ContactsService {
  constructor(@Inject(CONTACT_STORE) private readonly store: ContactStore) {}

  async recordVoiceConsent(organizationId: string, actorUserId: string, contactIdValue: unknown, input: unknown) {
    const contactId = this.uuid(contactIdValue, 'Contact id');
    const body = this.body(input, 'Consent evidence is required.');
    const allowed = ['consentedAt', 'source', 'purpose', 'evidenceReference', 'sourceVerified'];
    if (Object.keys(body).length !== allowed.length || Object.keys(body).some((key) => !allowed.includes(key))) {
      invalid('Consent requires a verified source, timestamp, voice_calling purpose and evidence reference.');
    }
    if (body.purpose !== 'voice_calling') invalid('Purpose must be voice_calling.');
    if (body.sourceVerified !== true) invalid('The operator must confirm the source was verified.');
    const consentedAt = this.consentTimestamp(body.consentedAt);
    const source = this.optionalText(body.source, 80, 'Source');
    if (typeof source !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{2,79}$/.test(source)) {
      invalid('Source must be a verified, non-sensitive source identifier.');
    }
    const evidenceReference = body.evidenceReference;
    if (typeof evidenceReference !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/.test(evidenceReference)) {
      invalid('Evidence reference must be an opaque reference (3–128 safe characters), not a URL or document content.');
    }
    try {
      const contact = await this.store.recordVoiceConsent({
        organizationId, actorUserId, contactId, consentedAt, source,
        purpose: 'voice_calling', evidenceReference,
      });
      if (!contact) throw this.notFound();
      return this.contactView(contact);
    } catch (error) {
      if (error instanceof ContactAlreadyConsentedError) {
        throw new ConflictException({ error: { code: 'contact_consent_already_recorded', message: 'Consent evidence is immutable once recorded.' } });
      }
      throw error;
    }
  }

  private consentTimestamp(value: unknown): Date {
    if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?(?:Z|[+-]\d\d:\d\d)$/.test(value)) {
      invalid('Consent timestamp must be an ISO-8601 timestamp with timezone.');
    }
    const parsed = new Date(value);
    if (!Number.isFinite(parsed.getTime()) || parsed.getTime() > Date.now()) invalid('Consent timestamp must be valid and not in the future.');
    return parsed;
  }

  async createGroup(organizationId: string, actorUserId: string, input: unknown) {
    const body = this.body(input, 'Group details are required.');
    const group = this.groupName(body.name);
    try {
      return this.groupView(
        await this.store.createGroup({
          organizationId,
          actorUserId,
          id: randomUUID(),
          ...group,
        }),
      );
    } catch (error) {
      if (
        error instanceof ContactConflictError ||
        (error instanceof Error && error.message === 'contact_group_conflict')
      ) {
        throw new ConflictException({
          error: {
            code: 'contact_group_exists',
            message: 'A group with this name already exists.',
          },
        });
      }
      throw error;
    }
  }

  async listGroups(organizationId: string): Promise<readonly unknown[]> {
    return (await this.store.listGroups(organizationId)).map((group) => this.groupView(group));
  }

  async updateGroup(organizationId: string, actorUserId: string, groupIdValue: unknown, input: unknown) {
    const groupId = this.uuid(groupIdValue, 'Group id');
    const body = this.body(input, 'Group details are required.');
    if (Object.keys(body).length !== 1 || !Object.hasOwn(body, 'name')) {
      invalid('Only the group name can be updated.');
    }
    const group = this.groupName(body.name);
    try {
      const updated = await this.store.updateGroup({ organizationId, actorUserId, groupId, ...group });
      if (!updated) throw new NotFoundException({ error: { code: 'contact_group_not_found', message: 'Group not found.' } });
      return this.groupView(updated);
    } catch (error) {
      if (error instanceof Error && error.message === 'contact_group_conflict') {
        throw new ConflictException({ error: { code: 'contact_group_exists', message: 'A group with this name already exists.' } });
      }
      throw error;
    }
  }

  async deleteGroup(organizationId: string, actorUserId: string, groupIdValue: unknown) {
    const groupId = this.uuid(groupIdValue, 'Group id');
    if (!(await this.store.deleteGroup({ organizationId, actorUserId, groupId }))) {
      throw new NotFoundException({ error: { code: 'contact_group_not_found', message: 'Group not found.' } });
    }
    return { deleted: true };
  }

  async addContactToGroup(organizationId: string, actorUserId: string, groupIdValue: unknown, contactIdValue: unknown) {
    const groupId = this.uuid(groupIdValue, 'Group id');
    const contactId = this.uuid(contactIdValue, 'Contact id');
    if (!(await this.store.addContactToGroup({ organizationId, actorUserId, groupId, contactId }))) {
      throw new NotFoundException({ error: { code: 'contact_or_group_not_found', message: 'Contact or group not found.' } });
    }
    return { groupId, contactId, member: true };
  }

  async removeContactFromGroup(organizationId: string, actorUserId: string, groupIdValue: unknown, contactIdValue: unknown) {
    const groupId = this.uuid(groupIdValue, 'Group id');
    const contactId = this.uuid(contactIdValue, 'Contact id');
    if (!(await this.store.removeContactFromGroup({ organizationId, actorUserId, groupId, contactId }))) {
      throw new NotFoundException({ error: { code: 'contact_or_group_not_found', message: 'Contact or group not found.' } });
    }
    return { groupId, contactId, member: false };
  }

  async createContact(organizationId: string, actorUserId: string, input: unknown) {
    const body = this.body(input, 'Contact details are required.');
    const phoneE164 = this.phone(body.phone);
    const name = this.optionalText(body.name, 200, 'Name');
    const email = this.optionalEmail(body.email);
    const groupNames = this.groupNames(body.groups);
    try {
      const contact = await this.store.createContact({
        organizationId,
        actorUserId,
        id: randomUUID(),
        phoneE164,
        name: name ?? null,
        email: email ?? null,
        groupNames,
      });
      return this.contactView(contact);
    } catch (error) {
      if (
        error instanceof ContactConflictError ||
        (error instanceof Error && error.message === 'contact_conflict')
      ) {
        throw new ConflictException({
          error: {
            code: 'contact_exists',
            message: 'A contact with this phone number already exists in the organization.',
          },
        });
      }
      throw error;
    }
  }

  async listContacts(
    organizationId: string,
    query: { readonly groupId?: unknown; readonly limit?: unknown; readonly cursor?: unknown; readonly q?: unknown },
  ) {
    const groupId = query.groupId === undefined ? undefined : this.uuid(query.groupId, 'Group id');
    const limit = query.limit === undefined ? 50 : Number(query.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100)
      invalid('Limit must be between 1 and 100.');
    const cursor = query.cursor === undefined ? undefined : this.uuid(query.cursor, 'Cursor');
    const search = this.optionalText(query.q, 100, 'Search');
    if (search !== undefined && search !== null && search.length < 2) {
      invalid('Search must contain at least 2 characters.');
    }
    const items = await this.store.listContacts({
      organizationId,
      groupId,
      ...(search ? { search } : {}),
      limit,
      cursor,
    });
    return {
      items: items.map((contact) => this.contactView(contact)),
      nextCursor: items.length === limit ? (items.at(-1)?.id ?? null) : null,
    };
  }

  async deleteContact(organizationId: string, actorUserId: string, contactIdValue: unknown) {
    const contactId = this.uuid(contactIdValue, 'Contact id');
    const result = await this.store.deleteContact({ organizationId, actorUserId, contactId });
    if (result === 'NOT_FOUND') throw this.notFound();
    if (result === 'SUPPRESSED') {
      throw new ConflictException({ error: { code: 'suppressed_contact_retained', message: 'Suppressed contacts are retained to preserve the opt-out.' } });
    }
    if (result === 'HAS_RECIPIENTS') {
      throw new ConflictException({ error: { code: 'contact_has_campaign_history', message: 'Contacts referenced by campaign history cannot be deleted.' } });
    }
    return { deleted: true };
  }

  async updateContact(
    organizationId: string,
    actorUserId: string,
    contactIdValue: unknown,
    input: unknown,
  ) {
    const contactId = this.uuid(contactIdValue, 'Contact id');
    const body = this.body(input, 'Contact changes are required.');
    const keys = Object.keys(body);
    if (keys.length === 0 || keys.some((key) => !['name', 'email'].includes(key))) {
      invalid(
        'Only name and email can be updated. Consent and suppression cannot be changed through this route.',
      );
    }
    const changes: { name?: string | null; email?: string | null } = {};
    if (Object.hasOwn(body, 'name')) {
      const name = this.optionalText(body.name, 200, 'Name', true);
      if (name === undefined) invalid('Name cannot be omitted from an update.');
      changes.name = name;
    }
    if (Object.hasOwn(body, 'email')) {
      const email = this.optionalEmail(body.email, true);
      if (email === undefined) invalid('Email cannot be omitted from an update.');
      changes.email = email;
    }
    const contact = await this.store.updateContact({
      organizationId,
      actorUserId,
      contactId,
      ...changes,
    });
    if (!contact) throw this.notFound();
    return this.contactView(contact);
  }

  async suppressContact(
    organizationId: string,
    actorUserId: string,
    contactIdValue: unknown,
    input: unknown,
  ) {
    const contactId = this.uuid(contactIdValue, 'Contact id');
    const body = this.body(input, 'Suppression reason is required.');
    const reason = body.reason;
    if (
      typeof reason !== 'string' ||
      !(SUPPRESSION_REASONS as readonly string[]).includes(reason)
    ) {
      invalid('Choose a supported suppression reason.');
    }
    const contact = await this.store.suppressContact({
      organizationId,
      actorUserId,
      contactId,
      reason,
    });
    if (!contact) throw this.notFound();
    return this.contactView(contact);
  }

  async startImport(organizationId: string, actorUserId: string, input: unknown) {
    const body = this.body(input, 'Import details are required.');
    const importId = this.uuid(body.importId, 'Import id');
    const mapping = this.validateMapping(body.columnMapping);
    const record = await this.store.createImport({
      organizationId,
      actorUserId,
      importId,
      mapping,
    });
    return {
      id: record.id,
      status: record.status,
      nextBatchNumber: record.nextBatchNumber,
      createdAt: record.createdAt.toISOString(),
      batchLimit: MAX_IMPORT_BATCH_ROWS,
    };
  }

  async previewImport(organizationId: string, input: unknown) {
    const body = this.body(input, 'Import preview details are required.');
    if (Object.keys(body).some((key) => !['csv', 'columnMapping'].includes(key))) {
      invalid('Import preview accepts only CSV content and column mapping.');
    }
    if (typeof body.csv !== 'string') invalid('CSV content is required.');
    const mapping = this.validateMapping(body.columnMapping);
    const parsed = parseContactImportBatch(body.csv, mapping);
    return this.store.previewImport({ organizationId, rows: parsed.rows });
  }

  async processImportBatch(
    organizationId: string,
    actorUserId: string,
    importIdValue: unknown,
    input: unknown,
  ) {
    const importId = this.uuid(importIdValue, 'Import id');
    const body = this.body(input, 'Import batch is required.');
    if (!Number.isInteger(body.batchNumber) || (body.batchNumber as number) < 0) {
      invalid('Batch number must be a non-negative integer, starting at zero.');
    }
    if (typeof body.csv !== 'string') invalid('CSV batch content is required.');

    const existing = await this.store.getImportRecord(organizationId, importId);
    if (!existing)
      throw new NotFoundException({
        error: { code: 'contact_import_not_found', message: 'Import not found.' },
      });
    const parsed = parseContactImportBatch(body.csv, existing.mapping as ColumnMapping);
    try {
      const result = await this.store.processImportBatch({
        organizationId,
        actorUserId,
        importId,
        batchNumber: body.batchNumber as number,
        payloadHash: importPayloadHash(body.csv),
        rows: parsed.rows,
        resolvedMapping: parsed.resolvedMapping,
      });
      return { rows: result.rows, summary: result.summary };
    } catch (error) {
      if (error instanceof Error && error.message === 'import_not_found') {
        throw new NotFoundException({
          error: { code: 'contact_import_not_found', message: 'Import not found.' },
        });
      }
      if (
        error instanceof Error &&
        ['import_batch_conflict', 'import_batch_sequence'].includes(error.message)
      ) {
        throw new ConflictException({
          error: {
            code: error.message,
            message: 'Import batch conflicts with the current import state.',
          },
        });
      }
      throw error;
    }
  }

  async completeImport(organizationId: string, actorUserId: string, importIdValue: unknown) {
    const importId = this.uuid(importIdValue, 'Import id');
    const summary = await this.store.completeImport({ organizationId, actorUserId, importId });
    if (!summary)
      throw new NotFoundException({
        error: { code: 'contact_import_not_found', message: 'Import not found.' },
      });
    return summary;
  }

  async importSummary(
    organizationId: string,
    importIdValue: unknown,
  ): Promise<ContactImportSummary> {
    const importId = this.uuid(importIdValue, 'Import id');
    const summary = await this.store.getImportSummary(organizationId, importId);
    if (!summary)
      throw new NotFoundException({
        error: { code: 'contact_import_not_found', message: 'Import not found.' },
      });
    return summary;
  }

  /** This query must be called by execution at dispatch time; eligibility is never cached. */
  async recipientsForExecution(organizationId: string, groupIds: readonly unknown[]) {
    if (!Array.isArray(groupIds) || groupIds.length === 0 || groupIds.length > 20) {
      invalid('Campaign execution requires between 1 and 20 tenant group ids.');
    }
    return this.store.listEligibleForExecution({
      organizationId,
      groupIds: groupIds.map((id) => this.uuid(id, 'Group id')),
      limit: 10_000,
    });
  }

  private validateMapping(value: unknown): ColumnMapping {
    if (value === undefined) return {};
    if (!value || typeof value !== 'object' || Array.isArray(value))
      invalid('Column mapping must be an object.');
    const input = value as Record<string, unknown>;
    if (Object.keys(input).some((key) => !(IMPORT_FIELDS as readonly string[]).includes(key))) {
      invalid('Column mapping contains an unsupported field.');
    }
    const mapping: ColumnMapping = {};
    for (const field of IMPORT_FIELDS) {
      const header = input[field];
      if (header === undefined) continue;
      if (typeof header !== 'string' || !header.trim() || header.length > 80)
        invalid(`Invalid CSV header mapping for ${field}.`);
      mapping[field] = header.trim();
    }
    return mapping;
  }

  private body(value: unknown, message: string): Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) invalid(message);
    return value as Record<string, unknown>;
  }

  private uuid(value: unknown, label: string): string {
    if (typeof value !== 'string' || !UUID.test(value))
      invalid(`${label} must be a valid identifier.`);
    return value;
  }

  private phone(value: unknown): string {
    if (typeof value !== 'string') invalid('Phone number is required.');
    const normalized = normalizePhoneE164(value);
    if (!normalized) invalid('Enter a valid international number or Uganda-local phone number.');
    return normalized;
  }

  private groupName(value: unknown): { name: string; normalizedName: string } {
    if (typeof value !== 'string') invalid('Group name is required.');
    const name = value.trim().replace(/\s+/g, ' ');
    if (!name || name.length > 120) invalid('Group name must be 1 to 120 characters.');
    return { name, normalizedName: name.toLocaleLowerCase('en-US') };
  }

  private groupNames(value: unknown): readonly { name: string; normalizedName: string }[] {
    if (value === undefined) return [];
    if (!Array.isArray(value) || value.length > 20)
      invalid('Groups must contain at most 20 names.');
    return [
      ...new Map(
        value.map((name) => {
          const normalized = this.groupName(name);
          return [normalized.normalizedName, normalized] as const;
        }),
      ).values(),
    ];
  }

  private optionalText(
    value: unknown,
    maximum: number,
    label: string,
    allowNull = false,
  ): string | null | undefined {
    if (value === undefined) return undefined;
    if (allowNull && value === null) return null;
    if (typeof value !== 'string') invalid(`${label} must be text.`);
    const text = value.trim();
    if (text.length > maximum) invalid(`${label} must be at most ${maximum} characters.`);
    return text || null;
  }

  private optionalEmail(value: unknown, allowNull = false): string | null | undefined {
    const email = this.optionalText(value, 254, 'Email address', allowNull);
    if (email === undefined || email === null) return email;
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) invalid('Enter a valid email address.');
    return email.toLocaleLowerCase('en-US');
  }

  private contactView(contact: ContactRecord) {
    return {
      id: contact.id,
      phone: contact.phoneE164,
      name: contact.name,
      email: contact.email,
      voiceConsent: contact.voiceConsentAt ? 'RECORDED' : 'NOT_RECORDED',
      voiceConsentAt: contact.voiceConsentAt?.toISOString() ?? null,
      suppressed: contact.suppressedAt !== null,
      suppressedAt: contact.suppressedAt?.toISOString() ?? null,
      groups: contact.groups.map((group) => this.groupView(group)),
      createdAt: contact.createdAt.toISOString(),
      updatedAt: contact.updatedAt.toISOString(),
    };
  }

  private groupView(group: ContactGroupRecord) {
    return { id: group.id, name: group.name, createdAt: group.createdAt.toISOString() };
  }

  private notFound() {
    return new NotFoundException({
      error: { code: 'contact_not_found', message: 'Contact not found.' },
    });
  }
}
