/**
 * Africa's Talking Voice adapter implementing the `VoicePort`.
 *
 * Official contract (verified against the Node SDK and the Voice "Calling Out"
 * documentation):
 *   POST https://voice[.sandbox].africastalking.com/call
 *   apikey: <application key>
 *   Basic call: application/x-www-form-urlencoded with username, from, to,
 *     clientRequestId.
 *   Prerecorded audio: application/json with username, from, to[], clientRequestId
 *     and callActions: [{ actionType: 'Play', url: <https audio URL> }]. This
 *     variant plays the message without a public VoiceXML callback URL.
 *   success: HTTP 200/201 with `entries[]` (status, sessionId, phoneNumber)
 *
 * Credentials are supplied by the caller through constructor options; this
 * adapter never reads environment variables or secret files itself. Provider
 * field names never leak through the port — every request and result shape is
 * mapped explicitly onto our neutral types.
 *
 * Modes are explicit and selected by the caller:
 *   - `SANDBOX`: provider sandbox host (no operational voice calling today)
 *   - `PRODUCTION`: live provider host (requires a live app, voice number and
 *     explicit owner approval before dispatch is enabled)
 *   - simulation: `FakeVoiceAdapter` is used instead of this adapter; it makes
 *     no network call and is the default in the worker.
 */

import { isPhoneNumber } from '@truevine/domain';

import {
  assertVoicePort,
  TelephonyError,
  type CallStatusResult,
  type HangUpRequest,
  type InitiateCallRequest,
  type InitiateCallResult,
  type ProviderCallState,
  type VoicePort,
} from '../../voice.port.js';

export interface AfricaTalkingVoiceAdapterOptions {
  /** Africa's Talking username (sandbox or live application). */
  readonly username: string;
  /** Decrypted Africa's Talking API key. Never logged or returned. */
  readonly apiKey: string;
  /** Outbound caller ID, a provider-issued voice number in E.164 format. */
  readonly voiceNumber: string;
  /** Explicit mode; selects the provider host. */
  readonly environment: 'SANDBOX' | 'PRODUCTION';
  /** Fetch implementation for HTTP calls. */
  readonly fetch: typeof fetch;
  /** Request timeout in milliseconds. Defaults to 30 seconds. */
  readonly timeoutMs?: number;
}

interface AfricaTalkingCallResponse {
  entries?: Array<{
    status?: string;
    phoneNumber?: string;
    sessionId?: string;
    errorMessage?: string;
  }>;
  errorMessage?: string;
}

const VOICE_HOSTS = {
  SANDBOX: 'https://voice.sandbox.africastalking.com',
  PRODUCTION: 'https://voice.africastalking.com',
} as const;

/** Provider statuses that mean no call was queued. These are hard failures. */
const NON_QUEUED_STATUSES = new Set([
  'INVALIDPHONENUMBER',
  'DESTINATIONNOTSUPPORTED',
  'INSUFFICIENTCREDIT',
  'FAILED',
]);

/** Maps Africa's Talking raw status strings to our neutral call states. */
export function mapAfricaTalkingStatus(raw: string | undefined): ProviderCallState {
  if (!raw) return 'DIALING';
  const upper = String(raw).toUpperCase();
  switch (upper) {
    case 'RINGING':
    case 'CALLSESSIONSTATE=RINGING':
      return 'RINGING';
    case 'ANSWERED':
      return 'ANSWERED';
    case 'COMPLETED':
      return 'COMPLETED';
    case 'FAILED':
      return 'FAILED';
    case 'BUSY':
      return 'BUSY';
    case 'NO_ANSWER':
    case 'NOT_ANSWERED':
      return 'NO_ANSWER';
    case 'CANCELLED':
      return 'CANCELLED';
    case 'QUEUED':
      return 'QUEUED';
    default:
      // Unknown provider words never become an authoritative call state.
      return 'DIALING';
  }
}

export class AfricaTalkingVoiceAdapter implements VoicePort {
  private readonly host: string;
  private readonly timeoutMs: number;

  constructor(private readonly options: AfricaTalkingVoiceAdapterOptions) {
    if (!options.username) throw new TelephonyError('invalid_request', 'An Africa\u2019s Talking username is required.');
    if (!options.apiKey) throw new TelephonyError('invalid_request', 'An Africa\u2019s Talking API key is required.');
    if (!isPhoneNumber(options.voiceNumber))
      throw new TelephonyError('invalid_request', 'The calling number must be a valid E.164 voice number.');
    if (options.environment !== 'SANDBOX' && options.environment !== 'PRODUCTION')
      throw new TelephonyError('invalid_request', 'Environment must be SANDBOX or PRODUCTION.');
    this.host = VOICE_HOSTS[options.environment];
    this.timeoutMs = options.timeoutMs ?? 30_000;
    assertVoicePort(this);
  }

  async initiateCall(request: InitiateCallRequest): Promise<InitiateCallResult> {
    if (!request.to || !isPhoneNumber(request.to))
      throw new TelephonyError('invalid_request', 'The destination must be a valid E.164 phone number.');
    if (!request.callId || !request.organizationId)
      throw new TelephonyError('invalid_request', 'callId and organizationId are required.');
    if (!request.idempotencyKey)
      throw new TelephonyError('invalid_request', 'An idempotency key is required.');

    // An audio reference is an HTTPS URL to a prerecorded file. The provider's
    // `callActions` variant plays it from the initiation request itself, so no
    // public VoiceXML callback endpoint is needed for this test.
    const audioUrl = request.audioRef;
    if (audioUrl !== undefined && !/^https:\/\/[^\s]+$/i.test(audioUrl))
      throw new TelephonyError('invalid_request', 'A prerecorded audio reference must be an HTTPS URL.');

    // `clientRequestId` is echoed by the provider and is also our durable
    // duplicate-call guard: the same key must never create a second call.
    const contentType = audioUrl ? 'application/json' : 'application/x-www-form-urlencoded';
    const body = audioUrl
      ? JSON.stringify({
          username: this.options.username,
          from: this.options.voiceNumber,
          to: [request.to],
          clientRequestId: request.idempotencyKey,
          callActions: [{ actionType: 'Play', url: audioUrl }],
        })
      : new URLSearchParams({
          username: this.options.username,
          from: this.options.voiceNumber,
          to: request.to,
          clientRequestId: request.idempotencyKey,
        }).toString();

    let response: Response;
    try {
      response = await this.options.fetch(`${this.host}/call`, {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          apikey: this.options.apiKey,
          'Content-Type': contentType,
        },
        body,
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      const timedOut = error instanceof Error && error.name === 'TimeoutError';
      throw new TelephonyError(
        'provider_unavailable',
        timedOut
          ? 'Africa\u2019s Talking call initiation timed out; the outcome is unknown.'
          : 'Africa\u2019s Talking call initiation could not be reached; the outcome is unknown.',
        { retryable: true },
      );
    }

    // The SDK accepts 200 and 201 only. Other 2xx codes are not success.
    if (response.status !== 200 && response.status !== 201) {
      const errorText = await response.text().catch(() => '');
      const kind =
        response.status === 401 || response.status === 403
          ? 'unauthorized'
          : response.status === 429
            ? 'rate_limited'
            : response.status >= 500
              ? 'provider_unavailable'
              : 'invalid_request';
      throw new TelephonyError(kind, `Africa\u2019s Talking call initiation failed (${response.status})`, {
        providerMessage: errorText,
        retryable: response.status === 429 || response.status >= 500,
      });
    }

    let payload: AfricaTalkingCallResponse;
    try {
      payload = (await response.json()) as AfricaTalkingCallResponse;
    } catch {
      throw new TelephonyError('unknown', 'Africa\u2019s Talking returned an unreadable initiation response.', {
        retryable: false,
      });
    }

    if (payload.errorMessage && payload.errorMessage !== 'None') {
      throw new TelephonyError(
        'provider_unavailable',
        'Africa\u2019s Talking rejected the whole call request.',
        { retryable: true, providerMessage: payload.errorMessage },
      );
    }

    const entry = payload.entries?.[0];
    if (!entry) {
      throw new TelephonyError('unknown', 'Africa\u2019s Talking call initiation returned no result entry.', {
        retryable: false,
      });
    }

    const rawStatus = (entry.status ?? '').toUpperCase();
    if (NON_QUEUED_STATUSES.has(rawStatus) || entry.errorMessage) {
      throw new TelephonyError(
        'invalid_request',
        `Africa\u2019s Talking did not queue the call (${entry.status ?? 'unknown status'}).`,
        { retryable: false, providerMessage: entry.errorMessage },
      );
    }

    // The official field is `sessionId` (not `requestId`). It is the value
    // carried by callback events and is required for callback correlation and
    // durable duplicate-call prevention. `None` means the provider gave none.
    const sessionId = entry.sessionId && entry.sessionId !== 'None' ? entry.sessionId : undefined;
    if (!sessionId) {
      throw new TelephonyError('unknown', 'Africa\u2019s Talking queued the call without a session id.', {
        retryable: false,
      });
    }

    return {
      callId: request.callId,
      state: mapAfricaTalkingStatus(entry.status),
      providerCallId: sessionId,
      replayed: false,
    };
  }

  async hangUp(request: HangUpRequest): Promise<CallStatusResult> {
    // The Voice REST API used here has no programmatic hang-up endpoint.
    // A system-initiated hang-up is represented as COMPLETED when the current
    // state is ANSWERED; reconciliation remains callback-driven.
    const status = await this.fetchCallStatus(request.callId);
    if (status.state === 'ANSWERED') return { ...status, state: 'COMPLETED' };
    return status;
  }

  async fetchCallStatus(callId: string): Promise<CallStatusResult> {
    throw new TelephonyError(
      'not_found',
      `Africa\u2019s Talking does not support call status polling for call ${callId}; status arrives through callback events.`,
      { retryable: false },
    );
  }
}

/** Factory mirroring the style used by other packages. */
export function createAfricaTalkingVoiceAdapter(
  options: AfricaTalkingVoiceAdapterOptions,
): AfricaTalkingVoiceAdapter {
  return new AfricaTalkingVoiceAdapter(options);
}
