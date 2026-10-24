/** Narrow, tenant-explicit persistence contract for contacts and imports. */

export const CONTACT_STORE = Symbol('CONTACT_STORE');
export class ContactAlreadyConsentedError extends Error {}

export interface ContactGroupRecord {
  readonly organizationId: string;
  readonly id: string;
  readonly name: string;
  readonly normalizedName: string;
  readonly createdAt: Date;
}

export interface ContactRecord {
  readonly organizationId: string;
  readonly id: string;
  readonly phoneE164: string;
  readonly name: string | null;
  readonly email: string | null;
  readonly voiceConsentAt: Date | null;
  readonly suppressedAt: Date | null;
  readonly suppressionReason: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly groups: readonly ContactGroupRecord[];
}

export interface ContactImportRecord {
  readonly organizationId: string;
  readonly id: string;
  readonly createdById: string;
  readonly mapping: Readonly<Record<string, string>>;
  readonly status: 'OPEN' | 'COMPLETED';
  readonly nextBatchNumber: number;
  readonly rowsProcessed: number;
  readonly createdCount: number;
  readonly updatedCount: number;
  readonly unchangedCount: number;
  readonly rejectedCount: number;
  readonly warningCount: number;
  readonly createdAt: Date;
  readonly completedAt: Date | null;
}

export type ContactRowOutcome = 'CREATED' | 'UPDATED' | 'UNCHANGED' | 'REJECTED';

export interface ContactRowReport {
  readonly rowNumber: number;
  readonly outcome: ContactRowOutcome;
  readonly code?: string;
  readonly warningCodes: readonly string[];
}

export interface ContactImportSummary {
  readonly importId: string;
  readonly status: 'OPEN' | 'COMPLETED';
  readonly nextBatchNumber: number;
  readonly rowsProcessed: number;
  readonly created: number;
  readonly updated: number;
  readonly unchanged: number;
  readonly rejected: number;
  readonly warnings: number;
  readonly createdAt: string;
  readonly completedAt: string | null;
  readonly batches: readonly {
    readonly batchNumber: number;
    readonly rows: readonly ContactRowReport[];
  }[];
}

export interface ContactMutationAudit {
  readonly organizationId: string;
  readonly actorUserId: string;
  readonly action:
    | 'contact.created'
    | 'contact.updated'
    | 'contact.deleted'
    | 'contact.suppressed'
    | 'contact_group.created'
    | 'contact_import.started'
    | 'contact_import.batch_processed'
    | 'contact_import.completed';
  readonly targetType: string;
  readonly targetId: string;
  readonly metadata: Readonly<Record<string, unknown>>;
}

export interface ParsedContactRow {
  readonly rowNumber: number;
  readonly phoneE164?: string;
  readonly name?: string;
  readonly email?: string;
  readonly groups: readonly { readonly name: string; readonly normalizedName: string }[];
  readonly applySuppression: boolean;
  readonly warningCodes: readonly string[];
  readonly rejectionCode?: string;
}

export interface ProcessImportBatchInput {
  readonly organizationId: string;
  readonly actorUserId: string;
  readonly importId: string;
  readonly batchNumber: number;
  readonly payloadHash: string;
  readonly rows: readonly ParsedContactRow[];
  readonly resolvedMapping: Readonly<Record<string, string>>;
}

/** Every method carrying tenant data requires its organization scope. */
export interface ContactStore {
  createGroup(input: {
    readonly organizationId: string;
    readonly actorUserId: string;
    readonly id: string;
    readonly name: string;
    readonly normalizedName: string;
  }): Promise<ContactGroupRecord>;
  listGroups(organizationId: string): Promise<readonly ContactGroupRecord[]>;
  createContact(input: {
    readonly organizationId: string;
    readonly actorUserId: string;
    readonly id: string;
    readonly phoneE164: string;
    readonly name: string | null;
    readonly email: string | null;
    readonly groupNames: readonly { readonly name: string; readonly normalizedName: string }[];
  }): Promise<ContactRecord>;
  recordVoiceConsent(input: {
    readonly organizationId: string;
    readonly actorUserId: string;
    readonly contactId: string;
    readonly consentedAt: Date;
    readonly source: string;
    readonly purpose: 'voice_calling';
    readonly evidenceReference: string;
  }): Promise<ContactRecord | undefined>;
  listContacts(input: {
    readonly organizationId: string;
    readonly groupId?: string;
    readonly limit: number;
    readonly cursor?: string;
  }): Promise<readonly ContactRecord[]>;
  updateContact(input: {
    readonly organizationId: string;
    readonly actorUserId: string;
    readonly contactId: string;
    readonly name?: string | null;
    readonly email?: string | null;
  }): Promise<ContactRecord | undefined>;
  deleteContact(input: {
    readonly organizationId: string;
    readonly actorUserId: string;
    readonly contactId: string;
  }): Promise<'DELETED' | 'NOT_FOUND' | 'SUPPRESSED' | 'HAS_RECIPIENTS'>;
  suppressContact(input: {
    readonly organizationId: string;
    readonly actorUserId: string;
    readonly contactId: string;
    readonly reason: string;
  }): Promise<ContactRecord | undefined>;
  createImport(input: {
    readonly organizationId: string;
    readonly actorUserId: string;
    readonly importId: string;
    readonly mapping: Readonly<Record<string, string>>;
  }): Promise<ContactImportRecord>;
  processImportBatch(input: ProcessImportBatchInput): Promise<{
    readonly rows: readonly ContactRowReport[];
    readonly summary: ContactImportSummary;
  }>;
  getImportRecord(
    organizationId: string,
    importId: string,
  ): Promise<ContactImportRecord | undefined>;
  completeImport(input: {
    readonly organizationId: string;
    readonly actorUserId: string;
    readonly importId: string;
  }): Promise<ContactImportSummary | undefined>;
  getImportSummary(
    organizationId: string,
    importId: string,
  ): Promise<ContactImportSummary | undefined>;
  /** For trusted execution services; returns only explicitly consented, unsuppressed recipients. */
  listEligibleForExecution(input: {
    readonly organizationId: string;
    readonly groupIds: readonly string[];
    readonly limit: number;
  }): Promise<readonly { readonly id: string; readonly phoneE164: string }[]>;
}
