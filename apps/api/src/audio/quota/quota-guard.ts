import { createHash } from 'node:crypto';

import { Injectable, Inject } from '@nestjs/common';
import { DATABASE_CLIENT } from '../../tokens.js';
import type { PrismaClient } from '@truevine/database';
import { TenantWriteSql } from '../../auth/tenant-write.js';

export interface QuotaState {
  currentTotalBytes: number;
  currentFileCount: number;
  maxTotalBytes: number;
  maxSingleFileBytes: number;
  maxFiles: number;
}

export class AudioQuotaExceededError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AudioQuotaExceededError';
  }
}

type QuotaTx = Pick<
  PrismaClient,
  'audioBlob' | 'organizationAudioQuota'
> &
  TenantWriteSql;

@Injectable()
export class AudioQuotaGuard {
  constructor(@Inject(DATABASE_CLIENT) private readonly prisma: PrismaClient) {}

  async assertQuota(
    organizationId: string,
    newFileBytes: number,
    assetId: string,
  ): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      // 1. ADVISORY LOCK — serialized per organization
      const lockKey = this.quotaLockKey(organizationId);
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(${lockKey})`;

      // 2. FETCH QUOTA (with defaults)
      const quota = await this.getQuota(tx, organizationId);

      // 3. FETCH EXISTING BLOB (for delta calculation)
      const existingBlob = await tx.audioBlob.findUnique({
        where: { audio_blobs_org_asset_key: { organizationId, assetId } },
        select: { byteSize: true },
      });

      const existingBlobBytes = existingBlob ? Number(existingBlob.byteSize) : 0;
      const deltaBytes = existingBlob
        ? newFileBytes - existingBlobBytes
        : newFileBytes;

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
      if (newFileBytes > Number(quota.maxSingleFileBytes)) {
        throw new AudioQuotaExceededError(
          `File size ${newFileBytes} exceeds per-file limit ${Number(quota.maxSingleFileBytes)}`,
        );
      }

      // Total org: delta against total limit
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
    });
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
