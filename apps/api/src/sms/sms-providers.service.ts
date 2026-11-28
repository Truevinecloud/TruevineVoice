/**
 * SMS provider configuration service.
 *
 * Mirrors VoiceProvidersService: manages SMS provider credentials, environment
 * and readiness checks. SMS is disabled by default; activation requires an
 * explicit environment configuration and a readiness check.
 */

import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import type { PrismaClient } from '@truevine/database';

import { DATABASE_CLIENT } from '../tokens.js';
import { SmsPort, type SmsProviderStatus } from './sms-port.js';
import { SyntheticSmsAdapter } from './synthetic-sms-adapter.js';

export const SMS_KEY = Symbol('SMS_KEY');

export const SMS_ENVIRONMENTS = ['SANDBOX', 'PRODUCTION'] as const;
export type SmsEnvironmentConfig = typeof SMS_ENVIRONMENTS[number];

export function smsEnvironmentOf(value: string): SmsEnvironmentConfig {
  if (value === 'SANDBOX' || value === 'PRODUCTION') return value;
  throw new BadRequestException('Invalid SMS provider environment.');
}

export function smsKey(value: string | undefined): Buffer | undefined {
  if (!value) return undefined;
  if (!/^[A-Za-z0-9+/]{43}=$/.test(value)) {
    throw new Error('SMS_CREDENTIAL_ENCRYPTION_KEY must be a base64-encoded 32-byte key.');
  }
  return Buffer.from(value, 'base64');
}

interface SmsProviderConfigRow {
  environment: string;
  username: string;
  senderId: string;
  ciphertext: string;
  enabled: boolean;
  checkedAt: Date | null;
  checkResult: string | null;
  version: number;
}

export interface SmsProviderView {
  readonly environment: SmsEnvironmentConfig;
  readonly username: string;
  readonly senderId: string;
  readonly keyPresent: boolean;
  readonly enabled: boolean;
  readonly checkedAt: Date | null;
  readonly checkResult: string | null;
  readonly smsReady: boolean;
}

@Injectable()
export class SmsProvidersService {
  private readonly adapters = new Map<string, SmsPort>();

  constructor(
    @Inject(DATABASE_CLIENT) private readonly db: Pick<PrismaClient, '$queryRaw'>,
    @Inject(SMS_KEY) private readonly key: Buffer | null,
  ) {
    // Always register the synthetic adapter for local testing.
    const synthetic = new SyntheticSmsAdapter({
      environment: 'SANDBOX',
      senderId: 'SYNTHETIC',
      results: new Map(),
    });
    this.adapters.set('SYNTHETIC', synthetic);
  }

  async list(): Promise<SmsProviderView[]> {
    const rows = await this.db.$queryRaw<SmsProviderConfigRow[]>`
      SELECT environment, username, sender_id AS "senderId", ciphertext, enabled,
             checked_at AS "checkedAt", check_result AS "checkResult", version
      FROM sms_provider_configurations
    `;
    return rows.map((row) => this.view(row.environment as SmsEnvironmentConfig, row));
  }

  async get(environment: SmsEnvironmentConfig): Promise<SmsProviderView | null> {
    const rows = await this.db.$queryRaw<SmsProviderConfigRow[]>`
      SELECT environment, username, sender_id AS "senderId", ciphertext, enabled,
             checked_at AS "checkedAt", check_result AS "checkResult", version
      FROM sms_provider_configurations
      WHERE environment = ${environment}
    `;
    if (rows.length === 0) return null;
    const row = rows[0];
    if (!row) return null;
    return this.view(row.environment as SmsEnvironmentConfig, row);
  }

  async isReady(environment: SmsEnvironmentConfig): Promise<SmsProviderStatus> {
    if (environment === 'SANDBOX') {
      const synthetic = this.adapters.get('SYNTHETIC');
      if (synthetic) return synthetic.isReady();
    }
    return {
      provider: environment === 'SANDBOX' ? 'SYNTHETIC' : 'AFRICAS_TALKING',
      environment,
      configured: false,
      enabled: false,
      ready: false,
      checkedAt: null,
      checkResult: 'unavailable',
    };
  }

  private view(environment: SmsEnvironmentConfig, row: SmsProviderConfigRow): SmsProviderView {
    return {
      environment,
      username: row.username,
      senderId: row.senderId,
      keyPresent: Boolean(row),
      enabled: row.enabled,
      checkedAt: row.checkedAt,
      checkResult: row.checkResult,
      smsReady: row.enabled && row.checkResult === 'verified',
    };
  }
}
