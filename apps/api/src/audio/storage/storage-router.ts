import { Injectable, Inject } from '@nestjs/common';
import { AudioObjectStore, AudioMimeType } from '@truevine/audio';
import { PostgresqlAudioStorage } from './postgresql-audio.storage.js';
import { S3AudioStorage } from '@truevine/audio';
import { DATABASE_CLIENT } from '../../tokens.js';
import type { PrismaClient } from '@truevine/database';

export interface PutObjectInput {
  readonly key: string;
  readonly body: Uint8Array;
  readonly contentType: AudioMimeType;
}

@Injectable()
export class StorageRouter implements AudioObjectStore {
  private readonly activeBackend: 'POSTGRESQL' | 'S3' | null;

  constructor(
    @Inject(PostgresqlAudioStorage) private readonly postgresql: PostgresqlAudioStorage,
    @Inject(S3AudioStorage) private readonly s3: S3AudioStorage | null,
    @Inject(DATABASE_CLIENT) private readonly prisma: PrismaClient,
  ) {
    const requested = process.env.AUDIO_STORAGE_BACKEND?.trim().toUpperCase();
    if (!requested) {
      this.activeBackend = 'POSTGRESQL';
      return;
    }
    if (requested === 'POSTGRESQL') {
      this.activeBackend = 'POSTGRESQL';
      return;
    }
    if (requested === 'S3') {
      this.activeBackend = 'S3';
      return;
    }
    this.activeBackend = null;
  }

  isAvailable(): boolean {
    return this.activeBackend !== null;
  }

  async putObject(input: { key: string; body: Uint8Array; contentType: AudioMimeType }): Promise<void> {
    if (this.activeBackend === 'POSTGRESQL') {
      return this.postgresql.putObject(input);
    }
    if (this.activeBackend === 'S3') {
      if (!this.s3) throw new Error('S3 storage not configured');
      return this.s3.putObject(input);
    }
    throw new Error('Audio storage is not configured');
  }

  async getObject(key: string): Promise<{ body: Uint8Array; contentType: AudioMimeType }> {
    // READS → route by ASSET'S stored backend
    const { organizationId, assetId } = this.parseKey(key);
    
    const asset = await this.prisma.audioAsset.findUnique({
      where: { organizationId_id: { organizationId, id: assetId } },
      select: { storageBackend: true },
    });
    
    if (!asset) throw new Error('Asset not found');
    
    if (asset.storageBackend === 'POSTGRESQL') {
      return this.postgresql.getObject(key);
    }
    if (!this.s3) throw new Error('S3 storage not configured');
    return this.s3.getObject(key);
  }

  async deleteObject(key: string): Promise<void> {
    const { organizationId, assetId } = this.parseKey(key);
    const asset = await this.prisma.audioAsset.findUnique({
      where: { organizationId_id: { organizationId, id: assetId } },
      select: { storageBackend: true },
    });
    if (!asset) throw new Error('Asset not found');
    
    if (asset.storageBackend === 'POSTGRESQL') {
      return this.postgresql.deleteObject(key);
    }
    if (!this.s3) throw new Error('S3 storage not configured');
    return this.s3.deleteObject(key);
  }

  async createPlaybackUrl(key: string): Promise<string> {
    const { organizationId, assetId } = this.parseKey(key);
    const asset = await this.prisma.audioAsset.findUnique({
      where: { organizationId_id: { organizationId, id: assetId } },
      select: { storageBackend: true },
    });
    
    if (!asset) throw new Error('Asset not found');
    
    if (asset.storageBackend === 'POSTGRESQL') {
      return this.postgresql.createPlaybackUrl(key);
    }
    if (!this.s3) throw new Error('S3 storage not configured');
    return this.s3.createPlaybackUrl(key);
  }

  private parseKey(key: string): { organizationId: string; assetId: string } {
    const parts = key.split('/');
    const organizationId = parts[0]!;
    // Keys are `organizationId/audio/<assetId>.<ext>`; the asset id is the final
    // path segment, not everything after the organization prefix.
    const fileName = parts[parts.length - 1]!;
    const assetId = fileName.replace(/\.[^.]+$/, '');
    return { organizationId, assetId };
  }
}