import type { AudioAssetSource, AudioMimeType } from '@truevine/audio';

export type AudioUsageAction =
  'RECORDING_CREATED' | 'TTS_GENERATED' | 'CAMPAIGN_SELECTED' | 'PLAYBACK_LINK_ISSUED';

export interface AudioAssetRecord {
  readonly id: string;
  readonly name: string;
  readonly source: AudioAssetSource;
  readonly mimeType: AudioMimeType;
  readonly storageKey: string;
  readonly checksumSha256: string;
  readonly byteSize: bigint;
  readonly durationMs: number | null;
  readonly ttsProvider: string | null;
  readonly ttsVoice: string | null;
  readonly ttsCharacterCount: number | null;
  readonly createdAt: Date;
  readonly campaignCount: number;
}

export interface NewAudioAsset {
  readonly organizationId: string;
  readonly id: string;
  readonly actorUserId: string;
  readonly name: string;
  readonly source: AudioAssetSource;
  readonly mimeType: AudioMimeType;
  readonly storageKey: string;
  readonly checksumSha256: string;
  readonly byteSize: number;
  readonly durationMs: number | null;
  readonly ttsProvider: string | null;
  readonly ttsVoice: string | null;
  readonly ttsCharacterCount: number | null;
  readonly idempotencyKey: string;
  readonly requestFingerprint: string;
}

export type BeginAudioOperationResult =
  | { readonly state: 'STARTED' }
  | { readonly state: 'COMPLETED'; readonly asset: AudioAssetRecord }
  | { readonly state: 'PENDING' | 'FAILED' | 'CONFLICT' };

export interface AudioStore {
  beginOperation(input: {
    readonly organizationId: string;
    readonly actorUserId: string;
    readonly source: AudioAssetSource;
    readonly idempotencyKey: string;
    readonly requestFingerprint: string;
  }): Promise<BeginAudioOperationResult>;
  completeOperation(asset: NewAudioAsset): Promise<AudioAssetRecord>;
  failOperation(input: {
    readonly organizationId: string;
    readonly actorUserId: string;
    readonly idempotencyKey: string;
  }): Promise<void>;
  listAssets(organizationId: string): Promise<readonly AudioAssetRecord[]>;
  findPlaybackTarget(
    organizationId: string,
    assetId: string,
  ): Promise<AudioAssetRecord | undefined>;
  recordPlaybackLink(input: {
    readonly organizationId: string;
    readonly actorUserId: string;
    readonly assetId: string;
  }): Promise<void>;
}
