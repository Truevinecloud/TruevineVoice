/**
 * Synthetic SMS adapter for local testing only.
 *
 * Simulates provider behavior deterministically without contacting any external
 * SMS provider. Every result is generated server-side; no real SMS is ever sent.
 *
 * Never activated in production: the module constructor throws if NODE_ENV is
 * production, and the module registration is disabled by default.
 */

import { createHash } from 'node:crypto';
import { Logger } from '@nestjs/common';

import { SmsPort, type SmsSendRequest, type SmsSendResult, type SmsProviderStatus } from './sms-port.js';

export type SyntheticSmsResult = 'accepted' | 'rejected' | 'temporary_failure' | 'permanent_failure' | 'timeout' | 'uncertain';

export interface SyntheticSmsAdapterConfig {
  readonly environment: 'SANDBOX';
  readonly senderId: string;
  readonly results: Map<string, SyntheticSmsResult>;
}

export class SyntheticSmsAdapter implements SmsPort {
  readonly provider = 'SYNTHETIC';
  readonly environment = 'SANDBOX';
  private readonly logger = new Logger(SyntheticSmsAdapter.name);
  private readonly results: Map<string, SyntheticSmsResult>;

  constructor(config: SyntheticSmsAdapterConfig) {
    if (process.env['NODE_ENV'] === 'production') {
      throw new Error('Synthetic SMS adapter is disabled in production.');
    }
    this.results = config.results ?? new Map();
    this.results.set(config.senderId, 'accepted');
  }

  async isReady(): Promise<SmsProviderStatus> {
    return {
      provider: 'SYNTHETIC',
      environment: 'SANDBOX',
      configured: true,
      enabled: true,
      ready: true,
      checkedAt: new Date(),
      checkResult: 'verified',
    };
  }

  async send(request: SmsSendRequest): Promise<SmsSendResult> {
    this.logger.log(
      `Synthetic SMS dispatch: org=${request.organizationId} campaign=${request.campaignId} recipient=${request.recipientId} idempotencyKey=${request.idempotencyKey}`,
    );

    // Sanitize: never log message body or recipient phone number in detail.
    const result = this.results.get(request.idempotencyKey) ?? 'accepted';

    switch (result) {
      case 'accepted':
        return {
          providerReference: `synthetic:${request.idempotencyKey}`,
          accepted: true,
          rejected: false,
          uncertain: false,
        };
      case 'rejected':
        return {
          providerReference: `synthetic:${request.idempotencyKey}`,
          accepted: false,
          rejected: true,
          uncertain: false,
        };
      case 'temporary_failure':
        throw new Error('sms_provider_temporary_failure');
      case 'permanent_failure':
        return {
          providerReference: `synthetic:${request.idempotencyKey}`,
          accepted: false,
          rejected: true,
          uncertain: false,
        };
      case 'timeout':
        throw new Error('sms_provider_timeout');
      case 'uncertain': {
        // Provider acceptance is uncertain: do not claim delivery.
        return {
          providerReference: `synthetic:${request.idempotencyKey}`,
          accepted: false,
          rejected: false,
          uncertain: true,
        };
      }
      default:
        throw new Error('sms_provider_unknown_result');
    }
  }
}

/**
 * Deterministic synthetic SMS result keyed by idempotency key.
 *
 * Tests can pre-populate this map to simulate specific provider outcomes per
 * idempotency key. Unknown keys default to 'accepted'.
 */
export function syntheticResultFor(idempotencyKey: string): SyntheticSmsResult {
  const digest = createHash('sha256').update(idempotencyKey).digest('hex');
  const firstByte = parseInt(digest.slice(0, 2), 16);
  const bucket = firstByte % 10;
  if (bucket < 7) return 'accepted';
  if (bucket === 7) return 'rejected';
  if (bucket === 8) return 'timeout';
  return 'uncertain';
}
