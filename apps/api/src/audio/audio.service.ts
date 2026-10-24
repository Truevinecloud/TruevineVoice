import { createHash, randomUUID } from 'node:crypto';

import {
  AudioValidationError,
  inspectAudio,
  validateAudioBytes,
  validateTtsRequest,
  type AudioAssetSource,
  type AudioMimeType,
  type AudioObjectStore,
  type TextToSpeechProvider,
} from '@truevine/audio';
import {
  audioAssetNotFound,
  audioNotConfigured,
  audioOperationConflict,
  audioProviderUnavailable,
  invalidAudio,
} from '@truevine/auth';
import { Inject, Injectable } from '@nestjs/common';

import { AUDIO_OBJECT_STORE, AUDIO_STORE, AUDIO_TTS_PROVIDER } from './audio.tokens.js';
import type { AudioAssetRecord, AudioStore, NewAudioAsset } from './audio.store.js';

export interface AudioAssetView {
  readonly id: string;
  readonly name: string;
  readonly source: AudioAssetSource;
  readonly mimeType: AudioMimeType;
  readonly byteSize: string;
  readonly durationMs: number | null;
  readonly ttsProvider: string | null;
  readonly ttsVoice: string | null;
  readonly ttsCharacterCount: number | null;
  readonly createdAt: string;
  readonly campaignCount: number;
}

@Injectable()
export class AudioService {
  constructor(
    @Inject(AUDIO_STORE) private readonly store: AudioStore,
    @Inject(AUDIO_OBJECT_STORE) private readonly objects: AudioObjectStore | null,
    @Inject(AUDIO_TTS_PROVIDER) private readonly tts: TextToSpeechProvider | null,
  ) {}

  async list(organizationId: string): Promise<readonly AudioAssetView[]> {
    return (await this.store.listAssets(organizationId)).map((asset) => this.toView(asset));
  }

  voices(): {
    readonly available: boolean;
    readonly storageAvailable: boolean;
    readonly voices: ReturnType<NonNullable<TextToSpeechProvider>['listVoices']>;
  } {
    return {
      available: this.tts !== null,
      storageAvailable: this.objects !== null,
      voices: this.tts?.listVoices() ?? [],
    };
  }

  async record(input: {
    readonly organizationId: string;
    readonly actorUserId: string;
    readonly idempotencyKey: string | undefined;
    readonly name: unknown;
    readonly declaredMimeType: string;
    readonly bytes: Uint8Array;
  }): Promise<AudioAssetView> {
    const name = this.validateName(input.name);
    const idempotencyKey = this.validateIdempotencyKey(input.idempotencyKey);
    let mimeType: AudioMimeType;
    let durationMs: number | null;
    try {
      mimeType = validateAudioBytes(
        input.bytes,
        input.declaredMimeType.split(';', 1)[0]!.trim().toLowerCase(),
      );
      durationMs = (await inspectAudio(input.bytes, mimeType)).durationMs;
    } catch (error) {
      if (error instanceof AudioValidationError) throw invalidAudio(error.message);
      throw error;
    }

    return this.saveAsset({
      organizationId: input.organizationId,
      actorUserId: input.actorUserId,
      idempotencyKey,
      source: 'RECORDING',
      requestFingerprint: this.fingerprint({
        source: 'RECORDING',
        name,
        sha256: this.sha256(input.bytes),
      }),
      name,
      bytes: input.bytes,
      mimeType,
      durationMs,
      ttsProvider: null,
      ttsVoice: null,
      ttsCharacterCount: null,
    });
  }

  async synthesize(input: {
    readonly organizationId: string;
    readonly actorUserId: string;
    readonly idempotencyKey: string | undefined;
    readonly name: unknown;
    readonly text: unknown;
    readonly voice: unknown;
  }): Promise<AudioAssetView> {
    const name = this.validateName(input.name);
    const idempotencyKey = this.validateIdempotencyKey(input.idempotencyKey);
    if (!this.tts || !this.objects) throw audioNotConfigured();

    let speech: { text: string; voice: string };
    try {
      speech = validateTtsRequest(input.text, input.voice);
    } catch (error) {
      if (error instanceof AudioValidationError) throw invalidAudio(error.message);
      throw error;
    }
    if (!this.tts.listVoices().some((voice) => voice.id === speech.voice)) {
      throw invalidAudio('Choose a supported voice.');
    }

    const requestFingerprint = this.fingerprint({
      source: 'TTS',
      name,
      text: speech.text,
      voice: speech.voice,
      provider: this.tts.providerId,
    });
    const operation = await this.store.beginOperation({
      organizationId: input.organizationId,
      actorUserId: input.actorUserId,
      source: 'TTS',
      idempotencyKey,
      requestFingerprint,
    });
    if (operation.state === 'COMPLETED') return this.toView(operation.asset);
    if (operation.state !== 'STARTED') throw this.operationError(operation.state);

    let result: Awaited<ReturnType<TextToSpeechProvider['synthesize']>>;
    try {
      result = await this.tts.synthesize(speech);
    } catch {
      await this.markFailed(input.organizationId, input.actorUserId, idempotencyKey);
      throw audioProviderUnavailable();
    }
    let generatedMimeType: AudioMimeType;
    let generatedDuration: number | null;
    try {
      generatedMimeType = validateAudioBytes(result.body, result.contentType);
      generatedDuration = (await inspectAudio(result.body, generatedMimeType)).durationMs;
    } catch {
      await this.markFailed(input.organizationId, input.actorUserId, idempotencyKey);
      throw audioProviderUnavailable();
    }
    return this.saveStartedAsset({
      organizationId: input.organizationId,
      actorUserId: input.actorUserId,
      idempotencyKey,
      source: 'TTS',
      requestFingerprint,
      name,
      bytes: result.body,
      mimeType: generatedMimeType,
      durationMs: generatedDuration,
      ttsProvider: this.tts.providerId,
      ttsVoice: result.voice,
      ttsCharacterCount: speech.text.length,
    });
  }

  async playbackLink(
    organizationId: string,
    actorUserId: string,
    assetId: string,
  ): Promise<{ readonly url: string }> {
    if (!this.objects) throw audioNotConfigured();
    const target = await this.store.findPlaybackTarget(organizationId, assetId);
    if (!target) throw audioAssetNotFound();
    let url: string;
    try {
      url = await this.objects.createPlaybackUrl(target.storageKey);
    } catch {
      throw audioProviderUnavailable();
    }
    await this.store.recordPlaybackLink({ organizationId, actorUserId, assetId });
    return { url };
  }

  private async saveAsset(input: {
    readonly organizationId: string;
    readonly actorUserId: string;
    readonly idempotencyKey: string;
    readonly source: AudioAssetSource;
    readonly requestFingerprint: string;
    readonly name: string;
    readonly bytes: Uint8Array;
    readonly mimeType: AudioMimeType;
    readonly durationMs: number | null;
    readonly ttsProvider: string | null;
    readonly ttsVoice: string | null;
    readonly ttsCharacterCount: number | null;
  }): Promise<AudioAssetView> {
    if (!this.objects) throw audioNotConfigured();
    const operation = await this.store.beginOperation({
      organizationId: input.organizationId,
      actorUserId: input.actorUserId,
      source: input.source,
      idempotencyKey: input.idempotencyKey,
      requestFingerprint: input.requestFingerprint,
    });
    if (operation.state === 'COMPLETED') return this.toView(operation.asset);
    if (operation.state !== 'STARTED') throw this.operationError(operation.state);
    return this.saveStartedAsset(input);
  }

  private async saveStartedAsset(input: {
    readonly organizationId: string;
    readonly actorUserId: string;
    readonly idempotencyKey: string;
    readonly source: AudioAssetSource;
    readonly requestFingerprint: string;
    readonly name: string;
    readonly bytes: Uint8Array;
    readonly mimeType: AudioMimeType;
    readonly durationMs: number | null;
    readonly ttsProvider: string | null;
    readonly ttsVoice: string | null;
    readonly ttsCharacterCount: number | null;
  }): Promise<AudioAssetView> {
    if (!this.objects) throw audioNotConfigured();
    if (input.bytes.byteLength > 10 * 1024 * 1024 || input.bytes.byteLength === 0) {
      await this.markFailed(input.organizationId, input.actorUserId, input.idempotencyKey);
      throw invalidAudio('Generated audio exceeded the allowed file size.');
    }
    const id = randomUUID();
    const extension = input.mimeType === 'audio/mpeg' ? 'mp3' : input.mimeType.slice(6);
    const storageKey = `${input.organizationId}/audio/${id}.${extension}`;
    try {
      await this.objects.putObject({
        key: storageKey,
        body: input.bytes,
        contentType: input.mimeType,
      });
    } catch {
      await this.markFailed(input.organizationId, input.actorUserId, input.idempotencyKey);
      throw audioProviderUnavailable();
    }

    const asset: NewAudioAsset = {
      organizationId: input.organizationId,
      id,
      actorUserId: input.actorUserId,
      name: input.name,
      source: input.source,
      mimeType: input.mimeType,
      storageKey,
      checksumSha256: this.sha256(input.bytes),
      byteSize: input.bytes.byteLength,
      durationMs: input.durationMs,
      ttsProvider: input.ttsProvider,
      ttsVoice: input.ttsVoice,
      ttsCharacterCount: input.ttsCharacterCount,
      idempotencyKey: input.idempotencyKey,
      requestFingerprint: input.requestFingerprint,
    };

    try {
      return this.toView(await this.store.completeOperation(asset));
    } catch (error) {
      await this.objects.deleteObject(storageKey).catch(() => undefined);
      await this.markFailed(input.organizationId, input.actorUserId, input.idempotencyKey);
      throw error;
    }
  }

  private async markFailed(
    organizationId: string,
    actorUserId: string,
    idempotencyKey: string,
  ): Promise<void> {
    await this.store
      .failOperation({ organizationId, actorUserId, idempotencyKey })
      .catch(() => undefined);
  }

  private operationError(state: 'PENDING' | 'FAILED' | 'CONFLICT'): Error {
    if (state === 'CONFLICT') {
      return audioOperationConflict(
        'This idempotency key was already used for different audio input.',
      );
    }
    if (state === 'PENDING') {
      return audioOperationConflict(
        'This audio operation is still in progress. Check its result before retrying.',
      );
    }
    return audioOperationConflict(
      'This audio operation failed; use a new request key to try again.',
    );
  }

  private validateName(value: unknown): string {
    if (typeof value !== 'string') throw invalidAudio('Audio name must be text.');
    const name = value.trim();
    if (name.length < 1 || name.length > 120 || [...name].some((char) => char.charCodeAt(0) < 32)) {
      throw invalidAudio('Audio name must be 1 to 120 printable characters.');
    }
    return name;
  }

  private validateIdempotencyKey(value: string | undefined): string {
    if (!value || value.length < 8 || value.length > 200 || !/^[A-Za-z0-9._:-]+$/.test(value)) {
      throw invalidAudio('A valid Idempotency-Key header is required.');
    }
    return value;
  }

  private fingerprint(value: unknown): string {
    return this.sha256(new TextEncoder().encode(JSON.stringify(value)));
  }

  private sha256(value: Uint8Array): string {
    return createHash('sha256').update(value).digest('hex');
  }

  private toView(asset: AudioAssetRecord): AudioAssetView {
    return {
      id: asset.id,
      name: asset.name,
      source: asset.source,
      mimeType: asset.mimeType,
      byteSize: asset.byteSize.toString(),
      durationMs: asset.durationMs,
      ttsProvider: asset.ttsProvider,
      ttsVoice: asset.ttsVoice,
      ttsCharacterCount: asset.ttsCharacterCount,
      createdAt: asset.createdAt.toISOString(),
      campaignCount: asset.campaignCount,
    };
  }
}
