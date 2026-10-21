/**
 * A deterministic in-memory Voice adapter for tests.
 *
 * It makes no network calls and places no real calls, so it is safe to use in
 * unit tests and everywhere a provider must be faked. It honours the port's
 * idempotency contract: initiating twice with the same key returns the original
 * result flagged `replayed: true`, and places only one call.
 *
 * The adapter is the only place the port's idempotency key is *retained*; real
 * durable duplicate prevention lives in persistence (a later task). Here the
 * store is in memory and exists purely to prove the contract.
 */

import type { IdempotencyKey, ProviderUsage } from '@truevine/domain';

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

interface FakeCall {
  callId: string;
  organizationId: string;
  state: ProviderCallState;
  providerCallId: string;
  usage?: ProviderUsage;
}

/** Options controlling the fake's behaviour. */
export interface FakeVoiceAdapterOptions {
  /** State a freshly initiated call reports. Defaults to `DIALING`. */
  readonly initialState?: ProviderCallState;
  /** A pre-seeded status for `fetchCallStatus` on an unknown call id. */
  readonly seed?: ReadonlyMap<string, CallStatusResult>;
}

/**
 * The deterministic fake. Each `initiateCall` with a new key creates one call;
 * reusing a key replays the first result and creates nothing.
 */
export class FakeVoiceAdapter implements VoicePort {
  private readonly initialCallState: ProviderCallState;
  private readonly callsByCallId = new Map<string, FakeCall>();
  private readonly callIdByKey = new Map<string, string>();
  private readonly seeded: ReadonlyMap<string, CallStatusResult>;
  private sequence = 0;

  constructor(options: FakeVoiceAdapterOptions = {}) {
    this.initialCallState = options.initialState ?? 'DIALING';
    this.seeded = options.seed ?? new Map();
  }

  async initiateCall(request: InitiateCallRequest): Promise<InitiateCallResult> {
    if (!request.to || !request.callId || !request.organizationId) {
      throw new TelephonyError('invalid_request', 'to, callId and organizationId are required.');
    }
    if (!request.idempotencyKey) {
      throw new TelephonyError('invalid_request', 'An idempotency key is required.');
    }

    const existingCallId = this.callIdByKey.get(request.idempotencyKey);
    if (existingCallId !== undefined) {
      const existing = this.callsByCallId.get(existingCallId);
      if (existing) {
        return {
          callId: existing.callId,
          state: existing.state,
          providerCallId: existing.providerCallId,
          replayed: true,
        };
      }
    }

    this.sequence += 1;
    const providerCallId = `fake-${this.sequence}`;
    const call: FakeCall = {
      callId: request.callId,
      organizationId: request.organizationId,
      state: this.initialCallState,
      providerCallId,
    };
    this.callsByCallId.set(call.callId, call);
    this.callIdByKey.set(request.idempotencyKey, call.callId);

    return {
      callId: call.callId,
      state: call.state,
      providerCallId: call.providerCallId,
      replayed: false,
    };
  }

  async hangUp(request: HangUpRequest): Promise<CallStatusResult> {
    const call = this.callsByCallId.get(request.callId);
    if (!call) {
      throw new TelephonyError('not_found', `Unknown call ${request.callId}.`);
    }
    call.state = 'COMPLETED';
    return {
      callId: call.callId,
      state: call.state,
      providerCallId: call.providerCallId,
      usage: call.usage,
    };
  }

  async fetchCallStatus(callId: string): Promise<CallStatusResult> {
    const call = this.callsByCallId.get(callId);
    if (call) {
      return {
        callId: call.callId,
        state: call.state,
        providerCallId: call.providerCallId,
        usage: call.usage,
      };
    }
    const seeded = this.seeded.get(callId);
    if (seeded) {
      return seeded;
    }
    throw new TelephonyError('not_found', `Unknown call ${callId}.`);
  }

  /** Test helper: force a call into a state and attach usage. */
  setState(callId: string, state: ProviderCallState, usage?: ProviderUsage): void {
    const call = this.callsByCallId.get(callId);
    if (!call) {
      throw new TelephonyError('not_found', `Unknown call ${callId}.`);
    }
    call.state = state;
    if (usage) {
      call.usage = usage;
    }
  }

  /** Test helper: how many distinct calls were actually placed. */
  placedCallCount(): number {
    return this.callsByCallId.size;
  }

  /** Test helper: whether a key has already been used. */
  hasKey(key: IdempotencyKey): boolean {
    return this.callIdByKey.has(key);
  }
}

/** Factory mirroring the style used by other packages. */
export function createFakeVoiceAdapter(options?: FakeVoiceAdapterOptions): FakeVoiceAdapter {
  const adapter = new FakeVoiceAdapter(options);
  assertVoicePort(adapter);
  return adapter;
}
