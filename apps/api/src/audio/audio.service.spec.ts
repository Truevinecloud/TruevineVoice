import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { AudioObjectStore, TextToSpeechProvider } from '@truevine/audio';

import type { AudioStore } from './audio.store.js';
import { AudioService } from './audio.service.js';

const store: AudioStore = {
  beginOperation: vi.fn(),
  completeOperation: vi.fn(),
  failOperation: vi.fn(),
  listAssets: vi.fn(),
  findPlaybackTarget: vi.fn(),
  recordPlaybackLink: vi.fn(),
};
const objects: AudioObjectStore = {
  putObject: vi.fn(),
  deleteObject: vi.fn(),
  createPlaybackUrl: vi.fn(),
};
const tts: TextToSpeechProvider = {
  providerId: 'test',
  listVoices: () => [{ id: 'Joanna', label: 'Joanna', language: 'en-US' }],
  synthesize: vi.fn(),
};

beforeEach(() => vi.clearAllMocks());

describe('AudioService', () => {
  it('rejects MIME spoofing before storage or database writes', async () => {
    const service = new AudioService(store, objects, tts);
    await expect(
      service.record({
        organizationId: 'org',
        actorUserId: 'user',
        idempotencyKey: 'record-0001',
        name: 'test',
        declaredMimeType: 'audio/mpeg',
        bytes: Uint8Array.from([0x1a, 0x45, 0xdf, 0xa3]),
      }),
    ).rejects.toMatchObject({ code: 'invalid_audio' });
    expect(store.beginOperation).not.toHaveBeenCalled();
    expect(objects.putObject).not.toHaveBeenCalled();
  });

  it('rejects blank TTS input before calling the provider', async () => {
    const service = new AudioService(store, objects, tts);
    await expect(
      service.synthesize({
        organizationId: 'org',
        actorUserId: 'user',
        idempotencyKey: 'tts-0000001',
        name: 'script',
        text: ' ',
        voice: 'Joanna',
      }),
    ).rejects.toMatchObject({ code: 'invalid_audio' });
    expect(tts.synthesize).not.toHaveBeenCalled();
    expect(store.beginOperation).not.toHaveBeenCalled();
  });

  it('reports provider availability without exposing configuration details', () => {
    expect(new AudioService(store, null, null).voices()).toEqual({
      available: false,
      storageAvailable: false,
      voices: [],
    });
  });
});
