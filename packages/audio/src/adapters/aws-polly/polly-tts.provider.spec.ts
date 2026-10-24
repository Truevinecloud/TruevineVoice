import { beforeEach, describe, expect, it, vi } from 'vitest';

const polly = vi.hoisted(() => ({ send: vi.fn(), destroy: vi.fn() }));

vi.mock('@aws-sdk/client-polly', () => ({
  PollyClient: class {
    send = polly.send;
    destroy = polly.destroy;
    constructor() {}
  },
  SynthesizeSpeechCommand: class {
    constructor(readonly input: unknown) {}
  },
}));

import { PollyTextToSpeechProvider } from './polly-tts.provider.js';

describe('Polly Standard provider', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    polly.send.mockResolvedValue({
      AudioStream: { transformToByteArray: async () => Uint8Array.of(1, 2, 3) },
    });
  });

  it('offers only voices that support the Standard engine', () => {
    const provider = new PollyTextToSpeechProvider('us-east-1');

    expect(provider.listVoices().map((voice) => voice.id)).toEqual(['Joanna', 'Amy']);
    expect(provider.listVoices().some((voice) => ['Matthew', 'Ayanda'].includes(voice.id))).toBe(
      false,
    );
    provider.close();
  });

  it('sends an explicit Standard engine request', async () => {
    const provider = new PollyTextToSpeechProvider('us-east-1');

    await provider.synthesize({ text: 'Hello', voice: 'Joanna' });

    expect(polly.send).toHaveBeenCalledWith(
      expect.objectContaining({
        input: expect.objectContaining({ Engine: 'standard', VoiceId: 'Joanna' }),
      }),
    );
    provider.close();
  });

  it.each(['Matthew', 'Ayanda'])('rejects %s before making a provider request', async (voice) => {
    const provider = new PollyTextToSpeechProvider('us-east-1');

    await expect(provider.synthesize({ text: 'Hello', voice })).rejects.toThrow(
      'Unsupported TTS voice.',
    );
    expect(polly.send).not.toHaveBeenCalled();
    provider.close();
  });
});
