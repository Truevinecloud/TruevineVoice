import { randomUUID, createHash } from 'node:crypto';

import { Injectable, Inject } from '@nestjs/common';

import { AudioQuotaGuard } from '../quota/quota-guard.js';
import { DATABASE_CLIENT } from '../../tokens.js';
import type { PrismaClient } from '@truevine/database';
import type { AudioObjectStore, AudioMimeType } from '@truevine/audio';
import { TenantWriteSql } from '../../auth/tenant-write.js';

type QuotaTx = Pick<
  PrismaClient,
  'audioBlob' | 'organizationAudioQuota'
> &
  TenantWriteSql;

export interface PutObjectInput {
  readonly key: string;
  readonly body: Uint8Array;
  readonly contentType: AudioMimeType;
}

@Injectable()
export class PostgresqlAudioStorage implements AudioObjectStore {
  constructor(
    @Inject(DATABASE_CLIENT) private readonly prisma: PrismaClient,
    @Inject(AudioQuotaGuard) private readonly quota: AudioQuotaGuard,
  ) {}

  async putObject({ key, body, contentType }: PutObjectInput): Promise<void> {
    const { organizationId, assetId } = this.parseKey(key);
    const newFileBytes = body.byteLength;

    await this.prisma.$transaction(async (tx) => {
      // 1. ADVISORY LOCK — serialized per organization
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(${this.quotaLockKey(organizationId)})`;

      // 2. FETCH QUOTA (with defaults)
      const quota = await this.getQuota(tx, organizationId);

      // 3. FETCH EXISTING BLOB (for delta calculation)
      const existingBlob = await tx.audioBlob.findUnique({
        where: { audio_blobs_org_asset_key: { organizationId, assetId } },
        select: { byteSize: true },
      });

      // 4. FETCH CURRENT USAGE
      const usage = await tx.audioBlob.aggregate({
        where: { organizationId },
        _sum: { byteSize: true },
        _count: { id: true },
      });

      const currentTotalBytes = Number(usage._sum.byteSize ?? 0);
      const currentFileCount = usage._count.id ?? 0;

      // 5. QUOTA VALIDATION
      // Per-file: NEW FILE'S FULL SIZE vs limit
      if (body.byteLength > Number(quota.maxSingleFileBytes)) {
        throw new AudioQuotaExceededError(
          `File size ${body.byteLength} exceeds per-file limit ${Number(quota.maxSingleFileBytes)}`,
        );
      }

      // Total org: delta against total limit
      const deltaBytes = existingBlob
        ? newFileBytes - Number(existingBlob.byteSize)
        : newFileBytes;

      if (currentTotalBytes + deltaBytes > Number(quota.maxTotalBytes)) {
        throw new AudioQuotaExceededError(
          `Total storage ${currentTotalBytes + deltaBytes} exceeds quota ${Number(quota.maxTotalBytes)}`,
        );
      }

      // File count
      const finalFileCount = existingBlob ? currentFileCount : currentFileCount + 1;
      if (finalFileCount > quota.maxFiles) {
        throw new AudioQuotaExceededError(
          `File count ${finalFileCount} exceeds quota ${quota.maxFiles}`,
        );
      }

      // 6. UPSERT BLOB
      await tx.audioBlob.upsert({
        where: { audio_blobs_org_asset_key: { organizationId, assetId } },
        create: {
          organizationId,
          id: randomUUID(),
          assetId,
          content: body as Uint8Array<ArrayBuffer>,
          contentType,
          byteSize: newFileBytes,
          checksumSha256: createHash('sha256').update(body).digest('hex'),
        },
        update: {
          content: body as Uint8Array<ArrayBuffer>,
          contentType,
          byteSize: newFileBytes,
          checksumSha256: createHash('sha256').update(body).digest('hex'),
        },
      });

      // 7. LINK TO ASSET — handled by completeOperation which creates the asset record.
      // The blob's assetId foreign key references the asset created there.

      // 8. AUDIT (same transaction)
      // Note: audit is handled by the caller (AudioService) via writeMutationAudit
    });
  }

  async getObject(key: string): Promise<{ body: Uint8Array; contentType: AudioMimeType }> {
    const { organizationId, assetId } = this.parseKey(key);

    const blob = await this.prisma.audioBlob.findUnique({
      where: { audio_blobs_org_asset_key: { organizationId, assetId } },
    });

    if (!blob) throw new Error('Object not found');
    return { body: blob.content, contentType: blob.contentType as AudioMimeType };
  }

  async deleteObject(key: string): Promise<void> {
    const { organizationId, assetId } = this.parseKey(key);

    await this.prisma.$transaction(async (tx) => {
      // 1. ADVISORY LOCK (quota serialization)
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(${this.quotaLockKey(organizationId)})`;

      // 2. FETCH EXISTING BLOB (for quota delta)
      const existingBlob = await tx.audioBlob.findUnique({
        where: { audio_blobs_org_asset_key: { organizationId, assetId } },
        select: { byteSize: true },
      });

      if (!existingBlob) return; // Idempotent: already deleted

      // 2. DELETE BLOB
      await tx.audioBlob.delete({
        where: { audio_blobs_org_asset_key: { organizationId, assetId } },
      });

      // 3. UNLINK FROM ASSET — NEVER mark as S3 if no S3 object
      await tx.audioAsset.update({
        where: { organizationId_id: { organizationId, id: assetId } },
        data: {
          storageBackend: 'POSTGRESQL', // Stays POSTGRESQL; blob is gone but metadata preserved
        },
      });
    });
  }

  async createPlaybackUrl(key: string): Promise<string> {
    return `/api/audio/${key}/content`;
  }

  async close(): Promise<void> {
    // No persistent connections to close for PostgreSQL
  }

  private parseKey(key: string): { organizationId: string; assetId: string } {
    const parts = key.split('/');
    const organizationId = parts[0]!;
    // Keys are `organizationId/audio/<assetId>.<ext>`; only the final segment
    // identifies the blob, the `audio` segment is a directory.
    const fileName = parts[parts.length - 1]!;
    const assetId = fileName.replace(/\.[^.]+$/, '');
    return { organizationId, assetId };
  }

  private getQuota(tx: QuotaTx, organizationId: string) {
    return tx.organizationAudioQuota.findUnique({
      where: { organizationId },
    }).then((q) => q ?? {
      maxTotalBytes: 52428800n,    // 50 MB
      maxSingleFileBytes: 5242880n, // 5 MB
      maxFiles: 100,
    });
  }

  private quotaLockKey(organizationId: string): number {
    // Deterministic hash of org UUID to 32-bit int for pg_advisory_xact_lock
    return createHash('md5').update(organizationId).digest().readInt32BE(0);
  }
}

class AudioQuotaExceededError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AudioQuotaExceededError';
  }
}