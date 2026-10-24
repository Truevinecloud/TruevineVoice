export {
  AUDIO_FORMATS,
  MAX_AUDIO_BYTES,
  MAX_AUDIO_DURATION_MS,
  MAX_TTS_CHARACTERS,
  PLAYBACK_URL_TTL_SECONDS,
  AudioValidationError,
  validateAudioBytes,
  validateTtsRequest,
  inspectAudio,
  type AudioAssetSource,
  type AudioMimeType,
  type AudioObjectStore,
  type TextToSpeechProvider,
} from './audio.port.js';
export { S3AudioStorage, type S3AudioStorageConfig } from './adapters/s3/s3-audio.storage.js';
export { PollyTextToSpeechProvider } from './adapters/aws-polly/polly-tts.provider.js';
