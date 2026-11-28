import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

import { BadRequestException, ConflictException, Inject, Injectable, ServiceUnavailableException } from '@nestjs/common';
import type { PrismaClient } from '@truevine/database';

import { DATABASE_CLIENT } from '../tokens.js';

export const VOICE_KEY = Symbol('VOICE_KEY');
export const VOICE_FETCH = Symbol('VOICE_FETCH');
export const ENVIRONMENTS = ['SANDBOX', 'PRODUCTION'] as const;
export type Environment = typeof ENVIRONMENTS[number];
type Check = 'verified' | 'rejected' | 'unavailable';
interface Configuration {
  environment: Environment;
  username: string;
  voiceNumber: string;
  ciphertext: string;
  enabled: boolean;
  checkedAt: Date | null;
  checkResult: Check | null;
  version: number;
}
type Database = Pick<PrismaClient, '$queryRaw' | '$transaction'>;
type Action = 'configured' | 'connection_tested' | 'activated' | 'deactivated';

export function voiceKey(value: string | undefined): Buffer | undefined {
  if (!value) return undefined;
  if (!/^[A-Za-z0-9+/]{43}=$/.test(value)) {
    throw new Error('VOICE_CREDENTIAL_ENCRYPTION_KEY must be a base64-encoded 32-byte key.');
  }
  return Buffer.from(value, 'base64');
}

/**
 * Optional provider key resolution for start-up. A missing or malformed key
 * must leave voice configuration unavailable, not abort an otherwise healthy
 * API boot where no provider is enabled.
 */
export function voiceKeyFromEnv(value: string | undefined): Buffer | null {
  try {
    return voiceKey(value) ?? null;
  } catch {
    return null;
  }
}

export function encryptKey(key: Buffer, environment: Environment, value: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(`africas-talking:voice:v1:${environment}`));
  const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return ['v1', iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), encrypted.toString('base64url')].join('.');
}

export function decryptKey(key: Buffer, environment: Environment, value: string): string {
  const [version, iv, tag, encrypted] = value.split('.');
  if (version !== 'v1' || !iv || !tag || !encrypted) throw new Error('Invalid voice credential envelope.');
  const cipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'), { authTagLength: 16 });
  cipher.setAAD(Buffer.from(`africas-talking:voice:v1:${environment}`));
  cipher.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([cipher.update(Buffer.from(encrypted, 'base64url')), cipher.final()]).toString('utf8');
}

export function environmentOf(value: string): Environment {
  if (value === 'SANDBOX' || value === 'PRODUCTION') return value;
  throw new BadRequestException('Invalid voice provider environment.');
}

function view(environment: Environment, row?: Configuration) {
  return {
    environment,
    username: row?.username ?? '',
    voiceNumber: row?.voiceNumber ?? '',
    keyPresent: Boolean(row),
    enabled: row?.enabled ?? false,
    checkedAt: row?.checkedAt ?? null,
    checkResult: row?.checkResult ?? null,
    voiceReady: false,
  };
}

@Injectable()
export class VoiceProvidersService {
  constructor(
    @Inject(DATABASE_CLIENT) private readonly db: Database,
    @Inject(VOICE_KEY) private readonly key: Buffer | null,
    @Inject(VOICE_FETCH) private readonly request: typeof fetch,
  ) {}

  async list() {
    const rows = await this.db.$queryRaw<Configuration[]>`
      SELECT environment, username, voice_number AS "voiceNumber", ciphertext, enabled,
             checked_at AS "checkedAt", check_result AS "checkResult", version
      FROM voice_provider_configurations
    `;
    return ENVIRONMENTS.map((environment) => view(environment, rows.find((row) => row.environment === environment)));
  }

  async diagnostics() {
    try {
      return (await this.list()).map(({ environment, keyPresent, enabled, checkedAt, checkResult, voiceReady }) =>
        ({ environment, configured: keyPresent, enabled, checkedAt, checkResult, voiceReady }));
    } catch {
      return null;
    }
  }

  async save(actorUserId: string, environment: Environment, input: unknown) {
    const body = input as Record<string, unknown> | null;
    const username = body?.['username'];
    const voiceNumber = body?.['voiceNumber'];
    const apiKey = body?.['apiKey'];
    const validVoiceNumber =
      typeof voiceNumber === 'string' &&
      (voiceNumber === '' || /^\+[1-9][0-9]{7,14}$/.test(voiceNumber));
    if (typeof username !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(username) ||
        (environment === 'SANDBOX') !== (username.toLowerCase() === 'sandbox') ||
        !validVoiceNumber ||
        (environment === 'PRODUCTION' && voiceNumber === '') ||
        (apiKey !== undefined && (typeof apiKey !== 'string' || !/^[\x21-\x7e]{1,512}$/.test(apiKey)))) {
      throw new BadRequestException(
        environment === 'PRODUCTION'
          ? 'Enter a valid application username, provider-issued voice number and API key.'
          : 'Enter a valid sandbox application username, API key and optional voice number.',
      );
    }
    const current = await this.load(environment);
    if (apiKey === undefined && (!current || current.username !== username)) {
      throw new BadRequestException('An API key is required for this application username.');
    }
    const ciphertext = typeof apiKey === 'string'
      ? encryptKey(this.requireKey(), environment, apiKey)
      : current!.ciphertext;
    return this.write(actorUserId, current, {
      environment, username, voiceNumber, ciphertext,
      enabled: false, checkedAt: null, checkResult: null, version: 0,
    }, 'configured');
  }

  async testConnection(actorUserId: string, environment: Environment) {
    const current = await this.requiredConfiguration(environment);
    const key = this.requireKey();
    let result: Check = 'unavailable';
    try {
      const host = environment === 'SANDBOX' ? 'api.sandbox.africastalking.com' : 'api.africastalking.com';
      const target = new URL(`https://${host}/version1/user`);
      target.searchParams.set('username', current.username);
      const response = await this.request(target, {
        method: 'GET',
        headers: { accept: 'application/json', apikey: decryptKey(key, environment, current.ciphertext) },
        redirect: 'error',
        signal: AbortSignal.timeout(5_000),
      });
      if (response.status === 401 || response.status === 403) result = 'rejected';
      if (response.status === 200) {
        const data = (await response.json()) as { UserData?: { balance?: unknown } };
        if (typeof data?.UserData?.balance === 'string') result = 'verified';
      } else {
        await response.body?.cancel();
      }
    } catch {
      // Provider and decryption errors can carry credential or account data.
    }
    return this.write(actorUserId, current, {
      ...current, checkedAt: new Date(), checkResult: result,
      enabled: current.enabled && result === 'verified',
    }, 'connection_tested');
  }

  async activate(actorUserId: string, environment: Environment, input: unknown) {
    const enabled = (input as { enabled?: unknown } | null)?.enabled;
    if (typeof enabled !== 'boolean') throw new BadRequestException('Specify whether to enable the provider.');
    const current = await this.requiredConfiguration(environment);
    if (enabled) {
      if (current.checkResult !== 'verified') {
        throw new ConflictException('Verify application credentials before enabling configuration.');
      }
      const key = this.requireKey();
      try {
        decryptKey(key, environment, current.ciphertext);
      } catch {
        throw new ConflictException('Replace the stored credential and verify it before enabling configuration.');
      }
    }
    return this.write(actorUserId, current, { ...current, enabled }, enabled ? 'activated' : 'deactivated');
  }

  private requireKey(): Buffer {
    if (!this.key) throw new ServiceUnavailableException('Voice credential encryption is unavailable.');
    return this.key;
  }

  private async load(environment: Environment) {
    const [row] = await this.db.$queryRaw<Configuration[]>`
      SELECT environment, username, voice_number AS "voiceNumber", ciphertext, enabled,
             checked_at AS "checkedAt", check_result AS "checkResult", version
      FROM voice_provider_configurations WHERE environment = ${environment}
    `;
    return row;
  }

  private async requiredConfiguration(environment: Environment) {
    const row = await this.load(environment);
    if (!row) throw new ConflictException('Save the provider configuration first.');
    return row;
  }

  private async write(actorUserId: string, previous: Configuration | undefined, next: Configuration, action: Action) {
    await this.db.$transaction(async (tx) => {
      const { environment, username, voiceNumber, ciphertext, enabled, checkedAt, checkResult } = next;
      const affected = previous
        ? await tx.$executeRaw`
            UPDATE voice_provider_configurations SET username = ${username}, voice_number = ${voiceNumber},
              ciphertext = ${ciphertext}, enabled = ${enabled}, checked_at = ${checkedAt},
              check_result = ${checkResult}, version = version + 1
            WHERE environment = ${environment} AND version = ${previous.version}
          `
        : await tx.$executeRaw`
            INSERT INTO voice_provider_configurations (environment, username, voice_number, ciphertext)
            VALUES (${environment}, ${username}, ${voiceNumber}, ${ciphertext})
            ON CONFLICT (environment) DO NOTHING
          `;
      if (affected !== 1) throw new ConflictException('Configuration changed. Reload and retry.');
      await tx.identityAuditEvent.create({ data: {
        actorUserId,
        action: `platform.voice_provider.${action}`,
        outcome: 'SUCCESS',
        metadata: {
          environment,
          before: previous ? { enabled: previous.enabled, verification: previous.checkResult } : null,
          after: { enabled, verification: checkResult },
          credentialsReplaced: !previous || previous.ciphertext !== ciphertext,
        },
      } });
    });
    return view(next.environment, next);
  }
}
