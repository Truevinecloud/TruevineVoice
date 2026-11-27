/**
 * @truevine/telephony — provider-neutral Voice abstraction.
 *
 * This package holds the Voice port and its adapters. It never imports from
 * `apps/*`, and provider SDK code lives only inside an adapter directory under
 * `src/adapters/<provider>/` (AGENTS.md 2, 8).
 */

export {
  TelephonyError,
  assertVoicePort,
  type VoicePort,
  type InitiateCallRequest,
  type InitiateCallResult,
  type HangUpRequest,
  type CallStatusResult,
  type CallEvent,
  type ProviderCallState,
  type TelephonyErrorKind,
} from './voice.port.js';

export {
  FakeVoiceAdapter,
  createFakeVoiceAdapter,
  type FakeVoiceAdapterOptions,
} from './adapters/fake/fake-voice.adapter.js';

export {
  AfricaTalkingVoiceAdapter,
  createAfricaTalkingVoiceAdapter,
  type AfricaTalkingVoiceAdapterOptions,
} from './adapters/africas-talking/africa-talking-voice.adapter.js';

export * from './call-contract.js';
export * from './call-event-persistence.js';
export * from './callback-sources.js';
export * from './callback-receipts.js';
export * from './provider-error-classification.js';
export {
  AFRICA_TALKING_CALLBACK_FIELDS,
  CallbackNormalizationError,
  normalizeAfricaTalkingCallback,
  type AfricaTalkingCallbackEvidence,
  type CallbackNormalizationErrorCode,
  type NormalizedAfricaTalkingCallback,
} from './adapters/africas-talking/africa-talking-callback.js';
