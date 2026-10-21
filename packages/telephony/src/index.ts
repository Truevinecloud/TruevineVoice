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
