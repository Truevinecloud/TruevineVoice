import { parseBuffer } from 'music-metadata';

/** Audio formats the upload endpoint accepts after byte-signature verification. */
export const AUDIO_FORMATS = {
  'audio/webm': { extension: 'webm', signature: 'webm' },
  'audio/ogg': { extension: 'ogg', signature: 'ogg' },
  'audio/mp4': { extension: 'm4a', signature: 'mp4' },
  'audio/mpeg': { extension: 'mp3', signature: 'mp3' },
  'audio/wav': { extension: 'wav', signature: 'wav' },
} as const;

export type AudioMimeType = keyof typeof AUDIO_FORMATS;
export type AudioAssetSource = 'RECORDING' | 'TTS';

export const MAX_AUDIO_BYTES = 10 * 1024 * 1024;
export const MAX_AUDIO_DURATION_MS = 5 * 60 * 1000;
export const MAX_TTS_CHARACTERS = 3000;
export const PLAYBACK_URL_TTL_SECONDS = 120;

export interface AudioObjectStore {
  putObject(input: {
    readonly key: string;
    readonly body: Uint8Array;
    readonly contentType: AudioMimeType;
  }): Promise<void>;
  deleteObject(key: string): Promise<void>;
  createPlaybackUrl(key: string): Promise<string>;
  close?(): Promise<void> | void;
}

export interface TextToSpeechProvider {
  readonly providerId: string;
  synthesize(input: { readonly text: string; readonly voice: string }): Promise<{
    readonly body: Uint8Array;
    readonly contentType: AudioMimeType;
    readonly voice: string;
  }>;
  listVoices(): readonly {
    readonly id: string;
    readonly label: string;
    readonly language: string;
  }[];
  close?(): Promise<void> | void;
}

export class AudioValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AudioValidationError';
  }
}

/** Checks both declared MIME and container signature before storing an upload. */
export function validateAudioBytes(body: Uint8Array, declaredMimeType: string): AudioMimeType {
  if (body.byteLength === 0 || body.byteLength > MAX_AUDIO_BYTES) {
    throw new AudioValidationError(`Audio must be between 1 byte and ${MAX_AUDIO_BYTES} bytes.`);
  }
  if (!(declaredMimeType in AUDIO_FORMATS)) {
    throw new AudioValidationError('Choose a supported audio format.');
  }
  const mimeType = declaredMimeType as AudioMimeType;
  const is = (...bytes: number[]): boolean => bytes.every((byte, index) => body[index] === byte);
  const signatureValid = {
    'audio/webm': is(0x1a, 0x45, 0xdf, 0xa3),
    'audio/ogg': is(0x4f, 0x67, 0x67, 0x53),
    'audio/mp4': body.length >= 8 && String.fromCharCode(...body.slice(4, 8)) === 'ftyp',
    'audio/mpeg': is(0x49, 0x44, 0x33) || (body[0] === 0xff && (body[1]! & 0xe0) === 0xe0),
    'audio/wav': is(0x52, 0x49, 0x46, 0x46) && String.fromCharCode(...body.slice(8, 12)) === 'WAVE',
  }[mimeType];
  if (!signatureValid)
    throw new AudioValidationError('The audio file format does not match its content.');
  return mimeType;
}

export function validateTtsRequest(text: unknown, voice: unknown): { text: string; voice: string } {
  if (typeof text !== 'string' || text.trim().length === 0) {
    throw new AudioValidationError('Enter text to synthesize.');
  }
  if (text.length > MAX_TTS_CHARACTERS) {
    throw new AudioValidationError(`Text must be ${MAX_TTS_CHARACTERS} characters or fewer.`);
  }
  if (typeof voice !== 'string' || voice.length > 60) {
    throw new AudioValidationError('Choose a supported voice.');
  }
  return { text: text.trim(), voice };
}
/** Parses container metadata from bytes, never from client supplied duration fields. */
export async function inspectAudio(
  body: Uint8Array,
  contentType: AudioMimeType,
): Promise<{ readonly durationMs: number | null }> {
  try {
    const metadata = await parseBuffer(body, { mimeType: contentType });
    const duration = metadata.format.duration;
    if (duration === undefined || !Number.isFinite(duration) || duration <= 0) {
      return { durationMs: null };
    }
    const durationMs = Math.round(duration * 1000);
    if (durationMs > MAX_AUDIO_DURATION_MS) {
      throw new AudioValidationError('Audio must be five minutes or shorter.');
    }
    return { durationMs };
  } catch (error) {
    if (error instanceof AudioValidationError) throw error;
    throw new AudioValidationError('The audio container could not be read.');
  }
}
