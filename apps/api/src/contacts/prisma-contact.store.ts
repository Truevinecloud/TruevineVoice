import { Inject, Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { PrismaClient } from '@truevine/database';

import { DATABASE_CLIENT } from '../tokens.js';
import {
  ContactAlreadyConsentedError,
  ContactPhoneRestrictedError,
  ContactPhoneConflictError,
  ContactUpdateConflictError,
} from './contact.store.js';
import { authorizeTenantWrite } from '../auth/tenant-write.js';
import type {
  ContactGroupRecord,
  ContactImportRecord,
  ContactRecord,
  ContactStore,
  ProcessImportBatchInput,
} from './contact.store.js';

type Client = PrismaClient;
type Row = {
  organizationId: string;
  id: string;
  phoneE164: string | null;
  destination: string;
  label: string;
  email: string | null;
  voiceConsentAt: Date | null;
  suppressedAt: Date | null;
  suppressionReason: string | null;
  createdAt: Date;
  updatedAt: Date;
  groupLinks: { group: ContactGroupRecord }[];
};
const view = (row: Row): ContactRecord => ({
  organizationId: row.organizationId,
  id: row.id,
  phoneE164: row.phoneE164 ?? row.destination,
  name: row.label || null,
  email: row.email,
  voiceConsentAt: row.voiceConsentAt,
  suppressedAt: row.suppressedAt,
  suppressionReason: row.suppressionReason,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
  groups: row.groupLinks.map((link) => link.group),
});
const importView = (row: {
  organizationId: string;
  id: string;
  createdById: string;
  mapping: unknown;
  status: 'OPEN' | 'COMPLETED';
  nextBatchNumber: number;
  rowsProcessed: number;
  createdCount: number;
  updatedCount: number;
  unchangedCount: number;
  rejectedCount: number;
  warningCount: number;
  createdAt: Date;
  completedAt: Date | null;
}): ContactImportRecord => ({
  organizationId: row.organizationId,
  id: row.id,
  createdById: row.createdById,
  mapping: row.mapping as Readonly<Record<string, string>>,
  status: row.status,
  nextBatchNumber: row.nextBatchNumber,
  rowsProcessed: row.rowsProcessed,
  createdCount: row.createdCount,
  updatedCount: row.updatedCount,
  unchangedCount: row.unchangedCount,
  rejectedCount: row.rejectedCount,
  warningCount: row.warningCount,
  createdAt: row.createdAt,
  completedAt: row.completedAt,
});

@Injectable()
export class PrismaContactStore implements ContactStore {
  constructor(@Inject(DATABASE_CLIENT) private readonly prisma: Client) {}

  private audit(
    tx: Pick<Client, 'securityAuditEvent'>,
    organizationId: string,
    actorUserId: string,
    action: string,
    targetType: string,
    targetId: string,
    metadata: object = {},
  ) {
    return tx.securityAuditEvent.create({
      data: {
        organizationId,
        actorUserId,
        action,
        scope: 'ORGANIZATION',
        outcome: 'SUCCESS',
        targetType,
        targetId,
        metadata: metadata as never,
      },
    });
  }

  async createGroup(i: {
    organizationId: string;
    actorUserId: string;
    id: string;
    name: string;
    normalizedName: string;
  }): Promise<ContactGroupRecord> {
    try {
      return await this.prisma.$transaction(async (tx) => {
        const row = await tx.contactGroup.create({
          data: {
            organizationId: i.organizationId,
            id: i.id,
            name: i.name,
            normalizedName: i.normalizedName,
            createdById: i.actorUserId,
          },
        });
        await this.audit(
          tx,
          i.organizationId,
          i.actorUserId,
          'contact_group.created',
          'contact_group',
          i.id,
        );
        return row;
      });
    } catch (e) {
      if ((e as { code?: string }).code === 'P2002')
        throw new Error('contact_group_conflict', { cause: e });
      throw e;
    }
  }
  async listGroups(organizationId: string): Promise<readonly ContactGroupRecord[]> {
    return this.prisma.contactGroup.findMany({
      where: { organizationId },
      orderBy: { name: 'asc' },
    });
  }

  async createContact(i: {
    organizationId: string;
    actorUserId: string;
    id: string;
    phoneE164: string;
    name: string | null;
    email: string | null;
    groupNames: readonly { name: string; normalizedName: string }[];
  }): Promise<ContactRecord> {
    try {
      return await this.prisma.$transaction(async (tx) => {
        const existing = await tx.contact.findUnique({
          where: {
            organizationId_phoneE164: {
              organizationId: i.organizationId,
              phoneE164: i.phoneE164,
            },
          },
        });
        const legacy = existing
          ? []
          : await tx.contact.findMany({
              where: {
                organizationId: i.organizationId,
                destination: i.phoneE164,
                phoneE164: null,
              },
              take: 2,
            });
        if (existing || legacy.length) throw new Error('contact_conflict');
        const groupIds: string[] = [];
        for (const g of i.groupNames) {
          const group = await tx.contactGroup.upsert({
            where: {
              organizationId_normalizedName: {
                organizationId: i.organizationId,
                normalizedName: g.normalizedName,
              },
            },
            create: {
              organizationId: i.organizationId,
              id: randomUUID(),
              name: g.name,
              normalizedName: g.normalizedName,
              createdById: i.actorUserId,
            },
            update: {},
          });
          groupIds.push(group.id);
        }
        await tx.contact.create({
          data: {
            organizationId: i.organizationId,
            id: i.id,
            destination: i.phoneE164,
            phoneE164: i.phoneE164,
            label: i.name ?? '',
            email: i.email,
            createdById: i.actorUserId,
          },
        });
        for (const groupId of groupIds) {
          await tx.contactGroupMember.create({
            data: { organizationId: i.organizationId, groupId, contactId: i.id },
          });
        }
        const row = await tx.contact.findUniqueOrThrow({
          where: { organizationId_id: { organizationId: i.organizationId, id: i.id } },
          include: { groupLinks: { include: { group: true } } },
        });
        await this.audit(tx, i.organizationId, i.actorUserId, 'contact.created', 'contact', i.id);
        return view(row as Row);
      });
    } catch (e) {
      if ((e as { code?: string }).code === 'P2002')
        throw new Error('contact_conflict', { cause: e });
      throw e;
    }
  }
  async listContacts(i: {
    organizationId: string;
    groupId?: string;
    limit: number;
    cursor?: string;
  }): Promise<readonly ContactRecord[]> {
    const rows = await this.prisma.contact.findMany({
      where: {
        organizationId: i.organizationId,
        ...(i.groupId
          ? { groupLinks: { some: { organizationId: i.organizationId, groupId: i.groupId } } }
          : {}),
      },
      orderBy: { id: 'asc' },
      take: i.limit,
      ...(i.cursor
        ? {
            skip: 1,
            cursor: { organizationId_id: { organizationId: i.organizationId, id: i.cursor } },
          }
        : {}),
      include: { groupLinks: { include: { group: true } } },
    });
    return rows.map((r) => view(r as Row));
  }

  async deleteContact(i: {
    organizationId: string;
    actorUserId: string;
    contactId: string;
  }): Promise<'DELETED' | 'NOT_FOUND' | 'SUPPRESSED' | 'HAS_RECIPIENTS'> {
    try {
      return await this.prisma.$transaction(async (tx) => {
        const contact = await tx.contact.findUnique({
          where: { organizationId_id: { organizationId: i.organizationId, id: i.contactId } },
          select: { id: true, suppressedAt: true },
        });
        if (!contact) return 'NOT_FOUND';
        if (contact.suppressedAt) return 'SUPPRESSED';

        const deleted = await tx.contact.deleteMany({
          where: { organizationId: i.organizationId, id: i.contactId, suppressedAt: null },
        });
        if (!deleted.count) return 'SUPPRESSED';
        await this.audit(
          tx,
          i.organizationId,
          i.actorUserId,
          'contact.deleted',
          'contact',
          i.contactId,
        );
        return 'DELETED';
      });
    } catch (error) {
      if (['P2003', 'P2014'].includes((error as { code?: string }).code ?? '')) {
        return 'HAS_RECIPIENTS';
      }
      throw error;
    }
  }

  async recordVoiceConsent(i: {
    organizationId: string; actorUserId: string; contactId: string; consentedAt: Date;
    source: string; purpose: 'voice_calling'; evidenceReference: string;
  }): Promise<ContactRecord | undefined> {
    return this.prisma.$transaction(async (tx) => {
      const changed = await tx.contact.updateMany({
        where: { organizationId: i.organizationId, id: i.contactId, voiceConsentAt: null },
        data: { voiceConsentAt: i.consentedAt, voiceConsentSource: i.source,
          voiceConsentPurpose: i.purpose, voiceConsentEvidenceReference: i.evidenceReference,
          voiceConsentVerifiedById: i.actorUserId },
      });
      if (!changed.count) {
        const existing = await tx.contact.findUnique({
          where: { organizationId_id: { organizationId: i.organizationId, id: i.contactId } },
          include: { groupLinks: { include: { group: true } } },
        });
        if (!existing) return undefined;
        throw new ContactAlreadyConsentedError();
      }
      const row = await tx.contact.findUnique({
        where: { organizationId_id: { organizationId: i.organizationId, id: i.contactId } },
        include: { groupLinks: { include: { group: true } } },
      });
      await this.audit(tx, i.organizationId, i.actorUserId, 'contact.voice_consent_recorded', 'contact', i.contactId,
        { consentedAt: i.consentedAt.toISOString(), source: i.source, purpose: i.purpose, evidenceReference: i.evidenceReference });
      return row ? view(row as Row) : undefined;
    });
  }
  async updateContact(i: {
    organizationId: string;
    actorUserId: string;
    contactId: string;
    name?: string | null;
    email?: string | null;
    phoneE164?: string;
  }): Promise<ContactRecord | undefined> {
    try {
      return await this.prisma.$transaction(async (tx) => {
        await authorizeTenantWrite(tx, i.organizationId, i.actorUserId, 'contact:update');
        // Re-read evidence after concurrent writers release this row lock.
        const locked = await tx.$queryRaw<{ id: string }[]>`
        SELECT id FROM contacts
        WHERE organization_id=${i.organizationId}::uuid AND id=${i.contactId}::uuid FOR UPDATE`;
        if (!locked.length) return undefined;
        const current = await tx.contact.findUniqueOrThrow({
          where: { organizationId_id: { organizationId: i.organizationId, id: i.contactId } },
        });
        const phoneChanged =
          i.phoneE164 !== undefined &&
          (i.phoneE164 !== (current.phoneE164 ?? current.destination) ||
            i.phoneE164 !== current.destination);
        if (phoneChanged) {
          const referenced = await tx.campaignRecipient.findFirst({
            where: { organizationId: i.organizationId, contactId: i.contactId },
            select: { id: true },
          });
          if (
            current.voiceConsentAt !== null ||
            current.voiceConsentSource !== null ||
            current.voiceConsentPurpose !== null ||
            current.voiceConsentEvidenceReference !== null ||
            current.voiceConsentVerifiedById !== null ||
            current.suppressedAt !== null ||
            current.suppressionReason !== null ||
            referenced
          )
            throw new ContactPhoneRestrictedError();
          const duplicate = await tx.contact.findFirst({
            where: {
              organizationId: i.organizationId,
              id: { not: i.contactId },
              OR: [{ phoneE164: i.phoneE164 }, { destination: i.phoneE164 }],
            },
            select: { id: true },
          });
          if (duplicate) throw new ContactPhoneConflictError();
        }
        const result = await tx.contact.updateMany({
          where: { organizationId: i.organizationId, id: i.contactId },
          data: {
            ...(i.name !== undefined ? { label: i.name ?? '' } : {}),
            ...(i.email !== undefined ? { email: i.email } : {}),
            ...(phoneChanged ? { phoneE164: i.phoneE164, destination: i.phoneE164 } : {}),
          },
        });
        if (!result.count) return undefined;
        const row = await tx.contact.findUnique({
          where: { organizationId_id: { organizationId: i.organizationId, id: i.contactId } },
          include: { groupLinks: { include: { group: true } } },
        });
        await this.audit(
          tx,
          i.organizationId,
          i.actorUserId,
          'contact.updated',
          'contact',
          i.contactId,
          {
            fields: [
              ...Object.keys(i).filter((k) => k === 'name' || k === 'email'),
              ...(phoneChanged ? ['phone'] : []),
            ],
          },
        );
        return row ? view(row as Row) : undefined;
      });
    } catch (error) {
      if ((error as { code?: string }).code === 'P2002') throw new ContactPhoneConflictError();
      if ((error as { code?: string }).code === 'P2034') throw new ContactUpdateConflictError();
      throw error;
    }
  }
  async suppressContact(i: {
    organizationId: string;
    actorUserId: string;
    contactId: string;
    reason: string;
  }): Promise<ContactRecord | undefined> {
    return this.prisma.$transaction(async (tx) => {
      const result = await tx.contact.updateMany({
        where: { organizationId: i.organizationId, id: i.contactId, suppressedAt: null },
        data: { suppressedAt: new Date(), suppressionReason: i.reason },
      });
      const row = await tx.contact.findUnique({
        where: { organizationId_id: { organizationId: i.organizationId, id: i.contactId } },
        include: { groupLinks: { include: { group: true } } },
      });
      if (!row) return undefined;
      if (result.count)
        await this.audit(
          tx,
          i.organizationId,
          i.actorUserId,
          'contact.suppressed',
          'contact',
          i.contactId,
          { reason: i.reason },
        );
      return view(row as Row);
    });
  }
  async createImport(i: {
    organizationId: string;
    actorUserId: string;
    importId: string;
    mapping: Readonly<Record<string, string>>;
  }) {
    const row = await this.prisma.$transaction(async (tx) => {
      const rec = await tx.contactImport.create({
        data: {
          organizationId: i.organizationId,
          id: i.importId,
          createdById: i.actorUserId,
          mapping: i.mapping,
        },
      });
      await this.audit(
        tx,
        i.organizationId,
        i.actorUserId,
        'contact_import.started',
        'contact_import',
        i.importId,
      );
      return rec;
    });
    return importView(row);
  }
  async getImportRecord(organizationId: string, importId: string) {
    const row = await this.prisma.contactImport.findUnique({
      where: { organizationId_id: { organizationId, id: importId } },
    });
    return row ? importView(row) : undefined;
  }
  async processImportBatch(i: ProcessImportBatchInput) {
    return this.prisma.$transaction(
      async (tx) => {
        const imp = await tx.contactImport.findUnique({
          where: { organizationId_id: { organizationId: i.organizationId, id: i.importId } },
          include: { batches: true },
        });
        if (!imp) throw new Error('import_not_found');
        const prior = imp.batches.find((b) => b.batchNumber === i.batchNumber);
        if (prior) {
          if (prior.payloadHash !== i.payloadHash) throw new Error('import_batch_conflict');
          return {
            rows: prior.report as never,
            summary: await this.summary(tx, i.organizationId, i.importId),
          };
        }
        if (imp.status !== 'OPEN' || imp.nextBatchNumber !== i.batchNumber)
          throw new Error('import_batch_sequence');
        const reports = [];
        let created = 0,
          updated = 0,
          unchanged = 0,
          rejected = 0,
          warnings = 0;
        for (const parsed of i.rows) {
          let outcome: 'CREATED' | 'UPDATED' | 'UNCHANGED' | 'REJECTED' = parsed.rejectionCode
            ? 'REJECTED'
            : 'UNCHANGED';
          let code = parsed.rejectionCode;
          if (!parsed.rejectionCode && parsed.phoneE164) {
            let old = await tx.contact.findUnique({
              where: {
                organizationId_phoneE164: {
                  organizationId: i.organizationId,
                  phoneE164: parsed.phoneE164,
                },
              },
              include: { groupLinks: true },
            });
            if (!old) {
              const legacy = await tx.contact.findMany({
                where: {
                  organizationId: i.organizationId,
                  destination: parsed.phoneE164,
                  phoneE164: null,
                },
                include: { groupLinks: true },
                take: 2,
              });
              if (legacy.length > 1) {
                outcome = 'REJECTED';
                code = 'ambiguous_existing_duplicate';
                rejected++;
                warnings += parsed.warningCodes.length;
                reports.push({
                  rowNumber: parsed.rowNumber,
                  outcome,
                  code,
                  warningCodes: parsed.warningCodes,
                });
                continue;
              }
              old = legacy[0] ?? null;
            }
            if (!old) {
              await tx.contact.create({
                data: {
                  organizationId: i.organizationId,
                  id: randomUUID(),
                  destination: parsed.phoneE164,
                  phoneE164: parsed.phoneE164,
                  label: parsed.name ?? '',
                  email: parsed.email ?? null,
                  createdById: i.actorUserId,
                  suppressedAt: parsed.applySuppression ? new Date() : null,
                  suppressionReason: parsed.applySuppression ? 'user_opt_out' : null,
                },
              });
              outcome = 'CREATED';
              created++;
            } else {
              let contactFieldsChanged = false;
              const data = {
                ...(old.phoneE164 === null ? { phoneE164: parsed.phoneE164 } : {}),
                ...(parsed.name !== undefined ? { label: parsed.name ?? '' } : {}),
                ...(parsed.email !== undefined ? { email: parsed.email } : {}),
                ...(parsed.applySuppression && !old.suppressedAt
                  ? { suppressedAt: new Date(), suppressionReason: 'user_opt_out' }
                  : {}),
              };
              const changed = Object.keys(data).length > 0;
              if (changed) {
                await tx.contact.update({
                  where: { organizationId_id: { organizationId: i.organizationId, id: old.id } },
                  data,
                });
                outcome = 'UPDATED';
                updated++;
                contactFieldsChanged = true;
              } else {
                outcome = 'UNCHANGED';
                unchanged++;
              }
              let groupMembershipAdded = false;
              for (const g of parsed.groups) {
                const group = await tx.contactGroup.upsert({
                  where: {
                    organizationId_normalizedName: {
                      organizationId: i.organizationId,
                      normalizedName: g.normalizedName,
                    },
                  },
                  create: {
                    organizationId: i.organizationId,
                    id: randomUUID(),
                    name: g.name,
                    normalizedName: g.normalizedName,
                    createdById: i.actorUserId,
                  },
                  update: {},
                });
                const link = await tx.contactGroupMember.findUnique({
                  where: {
                    organizationId_groupId_contactId: {
                      organizationId: i.organizationId,
                      groupId: group.id,
                      contactId: old.id,
                    },
                  },
                });
                if (!link) {
                  await tx.contactGroupMember.create({
                    data: {
                      organizationId: i.organizationId,
                      groupId: group.id,
                      contactId: old.id,
                    },
                  });
                  groupMembershipAdded = true;
                }
              }
              if (groupMembershipAdded && !contactFieldsChanged) {
                unchanged--;
                updated++;
                outcome = 'UPDATED';
              }
              // This row has already handled its group links.
              warnings += parsed.warningCodes.length;
              reports.push({
                rowNumber: parsed.rowNumber,
                outcome,
                ...(code ? { code } : {}),
                warningCodes: parsed.warningCodes,
              });
              continue;
            }
            for (const g of parsed.groups) {
              const group = await tx.contactGroup.upsert({
                where: {
                  organizationId_normalizedName: {
                    organizationId: i.organizationId,
                    normalizedName: g.normalizedName,
                  },
                },
                create: {
                  organizationId: i.organizationId,
                  id: randomUUID(),
                  name: g.name,
                  normalizedName: g.normalizedName,
                  createdById: i.actorUserId,
                },
                update: {},
              });
              const contactId = (
                await tx.contact.findUniqueOrThrow({
                  where: {
                    organizationId_phoneE164: {
                      organizationId: i.organizationId,
                      phoneE164: parsed.phoneE164,
                    },
                  },
                })
              ).id;
              await tx.contactGroupMember.upsert({
                where: {
                  organizationId_groupId_contactId: {
                    organizationId: i.organizationId,
                    groupId: group.id,
                    contactId,
                  },
                },
                create: { organizationId: i.organizationId, groupId: group.id, contactId },
                update: {},
              });
            }
          } else rejected++;
          warnings += parsed.warningCodes.length;
          reports.push({
            rowNumber: parsed.rowNumber,
            outcome,
            ...(code ? { code } : {}),
            warningCodes: parsed.warningCodes,
          });
        }
        await tx.contactImportBatch.create({
          data: {
            organizationId: i.organizationId,
            importId: i.importId,
            batchNumber: i.batchNumber,
            payloadHash: i.payloadHash,
            report: reports,
            rowCount: i.rows.length,
            createdCount: created,
            updatedCount: updated,
            unchangedCount: unchanged,
            rejectedCount: rejected,
            warningCount: warnings,
          },
        });
        await tx.contactImport.update({
          where: { organizationId_id: { organizationId: i.organizationId, id: i.importId } },
          data: {
            nextBatchNumber: { increment: 1 },
            rowsProcessed: { increment: i.rows.length },
            createdCount: { increment: created },
            updatedCount: { increment: updated },
            unchangedCount: { increment: unchanged },
            rejectedCount: { increment: rejected },
            warningCount: { increment: warnings },
          },
        });
        await this.audit(
          tx,
          i.organizationId,
          i.actorUserId,
          'contact_import.batch_processed',
          'contact_import',
          i.importId,
          { batchNumber: i.batchNumber, rows: i.rows.length, created, updated, rejected, warnings },
        );
        return { rows: reports, summary: await this.summary(tx, i.organizationId, i.importId) };
      },
      { isolationLevel: 'Serializable' },
    );
  }
  async completeImport(i: { organizationId: string; actorUserId: string; importId: string }) {
    return this.prisma.$transaction(async (tx) => {
      const n = await tx.contactImport.updateMany({
        where: { organizationId: i.organizationId, id: i.importId, status: 'OPEN' },
        data: { status: 'COMPLETED', completedAt: new Date() },
      });
      if (!n.count) {
        const existing = await tx.contactImport.findUnique({
          where: { organizationId_id: { organizationId: i.organizationId, id: i.importId } },
        });
        return existing ? this.summary(tx, i.organizationId, i.importId) : undefined;
      }
      await this.audit(
        tx,
        i.organizationId,
        i.actorUserId,
        'contact_import.completed',
        'contact_import',
        i.importId,
      );
      return this.summary(tx, i.organizationId, i.importId);
    });
  }
  async getImportSummary(organizationId: string, importId: string) {
    if (!(await this.getImportRecord(organizationId, importId))) return undefined;
    return this.summary(this.prisma, organizationId, importId);
  }
  private async summary(
    client: Pick<Client, 'contactImport'>,
    organizationId: string,
    importId: string,
  ) {
    const r = await client.contactImport.findUnique({
      where: { organizationId_id: { organizationId, id: importId } },
      include: { batches: { orderBy: { batchNumber: 'asc' } } },
    });
    if (!r) throw new Error('contact_import_disappeared');
    return {
      importId: r.id,
      status: r.status,
      nextBatchNumber: r.nextBatchNumber,
      rowsProcessed: r.rowsProcessed,
      created: r.createdCount,
      updated: r.updatedCount,
      unchanged: r.unchangedCount,
      rejected: r.rejectedCount,
      warnings: r.warningCount,
      createdAt: r.createdAt.toISOString(),
      completedAt: r.completedAt?.toISOString() ?? null,
      batches: r.batches.map((b) => ({ batchNumber: b.batchNumber, rows: b.report as never })),
    };
  }
  async listEligibleForExecution(i: {
    organizationId: string;
    groupIds: readonly string[];
    limit: number;
  }) {
    const rows = await this.prisma.contact.findMany({
      where: {
        organizationId: i.organizationId,
        voiceConsentAt: { not: null },
        suppressedAt: null,
        groupLinks: {
          some: { organizationId: i.organizationId, groupId: { in: [...i.groupIds] } },
        },
      },
      select: { id: true, phoneE164: true, destination: true },
      orderBy: { id: 'asc' },
      take: i.limit,
    });
    return rows.map((row) => ({ id: row.id, phoneE164: row.phoneE164 ?? row.destination }));
  }
}
