import {
  PollyClient,
  SynthesizeSpeechCommand,
  type PollyClientConfig,
} from '@aws-sdk/client-polly';

import type { TextToSpeechProvider } from '../../audio.port.js';

const VOICES = [
  { id: 'Joanna', label: 'Joanna (US English)', language: 'en-US' },
  { id: 'Amy', label: 'Amy (British English)', language: 'en-GB' },
] as const;

/** Amazon Polly adapter. Provider limits are validated before requests are made. */
export class PollyTextToSpeechProvider implements TextToSpeechProvider {
  readonly providerId = 'aws-polly';
  private readonly client: PollyClient;

  constructor(region: string, clientConfig: PollyClientConfig = {}) {
    this.client = new PollyClient({ region, ...clientConfig });
  }

  listVoices(): readonly (typeof VOICES)[number][] {
    return VOICES;
  }

  async synthesize(input: { readonly text: string; readonly voice: string }) {
    const voice = VOICES.find((candidate) => candidate.id === input.voice);
    if (!voice) throw new Error('Unsupported TTS voice.');

    const response = await this.client.send(
      new SynthesizeSpeechCommand({
        Engine: 'standard',
        Text: input.text,
        TextType: 'text',
        VoiceId: voice.id,
        OutputFormat: 'mp3',
      }),
    );
    if (!response.AudioStream) throw new Error('TTS provider returned no audio.');
    const body = await response.AudioStream.transformToByteArray();
    if (body.byteLength === 0) throw new Error('TTS provider returned empty audio.');
    return { body, contentType: 'audio/mpeg' as const, voice: voice.id };
  }

  close(): void {
    this.client.destroy();
  }
}
