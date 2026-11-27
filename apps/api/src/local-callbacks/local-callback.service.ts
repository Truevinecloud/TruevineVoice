import { createHash, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Inject, Injectable } from '@nestjs/common';
import { CALL_TRANSITIONS, type CallState } from '@truevine/domain';
import { CallbackReceipts, CallPersistenceError } from '@truevine/telephony';

import { APP_CONFIG } from '../config/app-config.module.js';
import type { ApiConfig } from '../config/api.config.js';
import { LOCAL_CALLBACK_KEY_HEADER, isLoopbackAddress } from './local-callback.shared.js';

/** Injectable receipt boundary; the controller never touches the database. */
export const LOCAL_CALLBACK_RECEIPTS = Symbol('LOCAL_CALLBACK_RECEIPTS');

export interface LocalSyntheticEvent {
  readonly sessionId: string;
  readonly state: CallState;
  readonly occurredAt: Date;
}

type ParsedBody =
  | { readonly ok: true; readonly event: LocalSyntheticEvent }
  | { readonly ok: false; readonly status: 400 | 413 };

export interface LocalCallbackAccepted {
  readonly status: 202;
  readonly body: { readonly status: 'accepted'; readonly outcome: 'queued' | 'stale' };
}

type LocalCallbackFailure =
  | { readonly ok: false; readonly status: 400 | 413 | 500 }
  | { readonly ok: true; readonly response: LocalCallbackAccepted };

function sha256(value: string | Buffer): Buffer {
  return createHash('sha256').update(value).digest();
}

/**
 * Verifies the loopback test credential and performs bounded validation before
 * handing a normalized event to the existing durable receipt service.
 */
@Injectable()
export class LocalCallbackService {
  private readonly credentialDigest: Buffer | null;

  constructor(
    @Inject(APP_CONFIG) private readonly config: ApiConfig,
    @Inject(LOCAL_CALLBACK_RECEIPTS) private readonly receipts: CallbackReceipts,
  ) {
    const settings = config.localSyntheticCallback;
    if (!settings) {
      this.credentialDigest = null;
      return;
    }

    // The value is read once, kept only as a digest, and never logged or returned.
    const stored = readFileSync(settings.keyFile, 'utf8').trim();
    if (!/^[A-Za-z0-9_-]{43}$/.test(stored) || Buffer.from(stored, 'base64url').length !== 32)
      throw new Error('Local synthetic callback credential file is missing or invalid.');
    this.credentialDigest = sha256(stored);
  }

  isEnabled(): boolean {
    return this.credentialDigest !== null;
  }

  isLoopback(remoteAddress: unknown): boolean {
    return isLoopbackAddress(remoteAddress);
  }

  verifyCredential(header: unknown): boolean {
    if (!this.credentialDigest || typeof header !== 'string' || header.length === 0) return false;
    return timingSafeEqual(this.credentialDigest, sha256(header));
  }

  headerName(): string {
    return LOCAL_CALLBACK_KEY_HEADER;
  }

  parseBody(raw: unknown): ParsedBody {
    const limit = this.config.localSyntheticCallback?.bodyLimitBytes ?? 0;
    if (!Buffer.isBuffer(raw)) return { ok: false, status: 400 };
    if (raw.length === 0 || raw.length > limit) return { ok: false, status: 413 };

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw.toString('utf8'));
    } catch {
      return { ok: false, status: 400 };
    }

    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed))
      return { ok: false, status: 400 };
    const record = parsed as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    if (
      keys.length !== 3 ||
      keys[0] !== 'occurredAt' ||
      keys[1] !== 'sessionId' ||
      keys[2] !== 'state'
    )
      return { ok: false, status: 400 };

    const sessionId = record['sessionId'];
    if (typeof sessionId !== 'string' || !/^[A-Za-z0-9_-]{1,160}$/.test(sessionId))
      return { ok: false, status: 400 };

    const state = record['state'];
    if (typeof state !== 'string' || !Object.hasOwn(CALL_TRANSITIONS, state))
      return { ok: false, status: 400 };

    const occurredAtValue = record['occurredAt'];
    if (
      typeof occurredAtValue !== 'string' ||
      occurredAtValue.length > 30 ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(occurredAtValue)
    )
      return { ok: false, status: 400 };
    const occurredAt = new Date(occurredAtValue);
    if (!Number.isFinite(occurredAt.getTime())) return { ok: false, status: 400 };

    return {
      ok: true,
      event: { sessionId, state: state as CallState, occurredAt },
    };
  }

  async ingest(event: LocalSyntheticEvent): Promise<LocalCallbackFailure> {
    try {
      const result = await this.receipts.receiveSynthetic(event, { enforceChronology: true });
      return {
        ok: true,
        response: {
          status: 202,
          body: { status: 'accepted', outcome: result.reason },
        },
      };
    } catch (error) {
      if (error instanceof CallPersistenceError) return { ok: false, status: 400 };
      return { ok: false, status: 500 };
    }
  }
}
