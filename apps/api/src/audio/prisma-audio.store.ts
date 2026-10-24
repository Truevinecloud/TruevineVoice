import { createHash } from 'node:crypto';

import { Inject, Injectable } from '@nestjs/common';
import { audioOperationConflict, audioAssetNotFound } from '@truevine/auth';
import type { PrismaClient } from '@truevine/database';

import { mutationRefused, writeMutationAudit } from '../auth/sensitive-audit.js';
import { authorizeTenantWrite, type TenantWriteSql } from '../auth/tenant-write.js';
import { DATABASE_CLIENT } from '../tokens.js';

import type {
  AudioAssetRecord,
  AudioStore,
  BeginAudioOperationResult,
  NewAudioAsset,
} from './audio.store.js';

type AudioTx = Pick<
  PrismaClient,
  'audioAsset' | 'audioAssetOperation' | 'audioAssetUsage' | 'securityAuditEvent'
> &
  TenantWriteSql;
type AudioDatabase = AudioTx & {
  $transaction<T>(work: (tx: AudioTx) => Promise<T>): Promise<T>;
};

@Injectable()
export class PrismaAudioStore implements AudioStore {
  constructor(@Inject(DATABASE_CLIENT) private readonly prisma: AudioDatabase) {}

  async beginOperation(input: {
    organizationId: string;
    actorUserId: string;
    source: 'RECORDING' | 'TTS';
    idempotencyKey: string;
    requestFingerprint: string;
  }): Promise<BeginAudioOperationResult> {
    try {
      return await this.prisma.$transaction(async (tx) => {
        await authorizeTenantWrite(tx, input.organizationId, input.actorUserId, 'audio:create');
        const existing = await tx.audioAssetOperation.findUnique({
          where: {
            organizationId_idempotencyKey: {
              organizationId: input.organizationId,
              idempotencyKey: input.idempotencyKey,
            },
          },
          include: { asset: true },
        });
        if (existing) {
          if (
            existing.source !== input.source ||
            existing.requestFingerprint !== input.requestFingerprint
          ) {
            return { state: 'CONFLICT' };
          }
          if (existing.state === 'COMPLETED' && existing.asset) {
            return { state: 'COMPLETED', asset: this.toRecord(existing.asset, 0) };
          }
          return { state: existing.state as 'PENDING' | 'FAILED' };
        }

        const operation = await tx.audioAssetOperation.create({
          data: {
            organizationId: input.organizationId,
            idempotencyKey: input.idempotencyKey,
            createdById: input.actorUserId,
            source: input.source,
            requestFingerprint: input.requestFingerprint,
          },
        });
        await writeMutationAudit(tx, {
          organizationId: input.organizationId,
          actorUserId: input.actorUserId,
          action: 'audio.operation.started',
          targetType: 'audio_asset_operation',
          targetId: operation.id,
          before: null,
          change: { source: input.source },
          after: { source: input.source, state: 'PENDING' },
          reasonCode: 'audio_operation_started',
        });
        return { state: 'STARTED' };
      });
    } catch (error) {
      return mutationRefused(
        this.prisma,
        {
          organizationId: input.organizationId,
          actorUserId: input.actorUserId,
          action: 'audio.operation.started',
          targetType: 'audio_asset_operation',
          targetId: createHash('sha256').update(input.idempotencyKey).digest('hex'),
        },
        error,
      );
    }
  }

  async completeOperation(input: NewAudioAsset): Promise<AudioAssetRecord> {
    try {
      return await this.prisma.$transaction(async (tx) => {
        await authorizeTenantWrite(tx, input.organizationId, input.actorUserId, 'audio:create');
        const operation = await tx.audioAssetOperation.findUnique({
          where: {
            organizationId_idempotencyKey: {
              organizationId: input.organizationId,
              idempotencyKey: input.idempotencyKey,
            },
          },
        });
        if (
          !operation ||
          operation.state !== 'PENDING' ||
          operation.createdById !== input.actorUserId ||
          operation.requestFingerprint !== input.requestFingerprint ||
          operation.source !== input.source
        ) {
          throw audioOperationConflict();
        }

        const asset = await tx.audioAsset.create({
          data: {
            organizationId: input.organizationId,
            id: input.id,
            createdById: input.actorUserId,
            name: input.name,
            source: input.source,
            mimeType: input.mimeType,
            storageKey: input.storageKey,
            checksumSha256: input.checksumSha256,
            byteSize: BigInt(input.byteSize),
            durationMs: input.durationMs,
            ttsProvider: input.ttsProvider,
            ttsVoice: input.ttsVoice,
            ttsCharacterCount: input.ttsCharacterCount,
          },
        });
        await tx.audioAssetUsage.create({
          data: {
            organizationId: input.organizationId,
            assetId: input.id,
            actorUserId: input.actorUserId,
            action: input.source === 'TTS' ? 'TTS_GENERATED' : 'RECORDING_CREATED',
            byteSize: BigInt(input.byteSize),
            durationMs: input.durationMs,
            ttsCharacterCount: input.ttsCharacterCount,
          },
        });
        await tx.audioAssetOperation.update({
          where: {
            organizationId_idempotencyKey: {
              organizationId: input.organizationId,
              idempotencyKey: input.idempotencyKey,
            },
          },
          data: {
            state: 'COMPLETED',
            assetOrganizationId: input.organizationId,
            assetId: input.id,
            completedAt: new Date(),
          },
        });
        await writeMutationAudit(tx, {
          organizationId: input.organizationId,
          actorUserId: input.actorUserId,
          action: 'audio.asset.created',
          targetType: 'audio_asset',
          targetId: input.id,
          before: null,
          change: {
            source: input.source,
            mimeType: input.mimeType,
            byteSize: input.byteSize,
            durationMs: input.durationMs,
            ttsCharacterCount: input.ttsCharacterCount,
          },
          after: {
            source: input.source,
            mimeType: input.mimeType,
            byteSize: input.byteSize,
            durationMs: input.durationMs,
            ttsProvider: input.ttsProvider,
            ttsVoice: input.ttsVoice,
            ttsCharacterCount: input.ttsCharacterCount,
          },
          reasonCode: 'audio_asset_created',
        });
        if (input.source === 'TTS') {
          await writeMutationAudit(tx, {
            organizationId: input.organizationId,
            actorUserId: input.actorUserId,
            action: 'audio.tts.synthesized',
            targetType: 'audio_asset',
            targetId: input.id,
            before: null,
            change: {
              provider: input.ttsProvider,
              voice: input.ttsVoice,
              characterCount: input.ttsCharacterCount,
            },
            after: {
              source: 'TTS',
              mimeType: input.mimeType,
              byteSize: input.byteSize,
              durationMs: input.durationMs,
            },
            reasonCode: 'audio_tts_synthesized',
          });
        }
        return this.toRecord(asset, 0);
      });
    } catch (error) {
      return mutationRefused(
        this.prisma,
        {
          organizationId: input.organizationId,
          actorUserId: input.actorUserId,
          action: 'audio.asset.created',
          targetType: 'audio_asset',
          targetId: input.id,
        },
        error,
      );
    }
  }

  async failOperation(input: {
    organizationId: string;
    actorUserId: string;
    idempotencyKey: string;
  }): Promise<void> {
    try {
      await this.prisma.$transaction(async (tx) => {
        await authorizeTenantWrite(tx, input.organizationId, input.actorUserId, 'audio:create');
        const operation = await tx.audioAssetOperation.findUnique({
          where: {
            organizationId_idempotencyKey: {
              organizationId: input.organizationId,
              idempotencyKey: input.idempotencyKey,
            },
          },
        });
        if (
          !operation ||
          operation.state !== 'PENDING' ||
          operation.createdById !== input.actorUserId
        ) {
          return;
        }
        await tx.audioAssetOperation.update({
          where: {
            organizationId_idempotencyKey: {
              organizationId: input.organizationId,
              idempotencyKey: input.idempotencyKey,
            },
          },
          data: { state: 'FAILED', completedAt: new Date() },
        });
        await writeMutationAudit(tx, {
          organizationId: input.organizationId,
          actorUserId: input.actorUserId,
          action: 'audio.operation.failed',
          targetType: 'audio_asset_operation',
          targetId: operation.id,
          before: { state: 'PENDING' },
          change: { failed: true },
          after: { state: 'FAILED' },
          reasonCode: 'audio_operation_failed',
        });
      });
    } catch {
      process.stderr.write('[audio] Failed operation audit or status update unavailable.\n');
    }
  }

  async listAssets(organizationId: string): Promise<readonly AudioAssetRecord[]> {
    const rows = await this.prisma.audioAsset.findMany({
      where: { organizationId },
      include: { _count: { select: { campaigns: true } } },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    });
    return rows.map((row) => this.toRecord(row, row._count.campaigns));
  }

  async findPlaybackTarget(
    organizationId: string,
    assetId: string,
  ): Promise<AudioAssetRecord | undefined> {
    const row = await this.prisma.audioAsset.findUnique({
      where: { organizationId_id: { organizationId, id: assetId } },
    });
    return row ? this.toRecord(row, 0) : undefined;
  }

  async recordPlaybackLink(input: {
    organizationId: string;
    actorUserId: string;
    assetId: string;
  }): Promise<void> {
    try {
      await this.prisma.$transaction(async (tx) => {
        await authorizeTenantWrite(tx, input.organizationId, input.actorUserId, 'audio:read');
        const asset = await tx.audioAsset.findUnique({
          where: { organizationId_id: { organizationId: input.organizationId, id: input.assetId } },
        });
        if (!asset) throw audioAssetNotFound();
        await tx.audioAssetUsage.create({
          data: {
            organizationId: input.organizationId,
            assetId: asset.id,
            actorUserId: input.actorUserId,
            action: 'PLAYBACK_LINK_ISSUED',
            byteSize: asset.byteSize,
            durationMs: asset.durationMs,
            ttsCharacterCount: asset.ttsCharacterCount,
          },
        });
        await writeMutationAudit(tx, {
          organizationId: input.organizationId,
          actorUserId: input.actorUserId,
          action: 'audio.asset.playback_link_issued',
          targetType: 'audio_asset',
          targetId: asset.id,
          before: null,
          change: { access: 'playback_link' },
          after: { byteSize: Number(asset.byteSize), durationMs: asset.durationMs },
          reasonCode: 'audio_playback_link_issued',
        });
      });
    } catch (error) {
      return mutationRefused(
        this.prisma,
        {
          organizationId: input.organizationId,
          actorUserId: input.actorUserId,
          action: 'audio.asset.playback_link_issued',
          targetType: 'audio_asset',
          targetId: input.assetId,
        },
        error,
      );
    }
  }

  private toRecord(
    row: {
      id: string;
      name: string;
      source: 'RECORDING' | 'TTS';
      mimeType: string;
      storageKey: string;
      checksumSha256: string;
      byteSize: bigint;
      durationMs: number | null;
      ttsProvider: string | null;
      ttsVoice: string | null;
      ttsCharacterCount: number | null;
      createdAt: Date;
    },
    campaignCount: number,
  ): AudioAssetRecord {
    return {
      ...row,
      source: row.source,
      mimeType: row.mimeType as AudioAssetRecord['mimeType'],
      campaignCount,
    };
  }
}
