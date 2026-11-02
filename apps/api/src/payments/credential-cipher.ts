/**
 * AES-256-GCM encryption for payment-provider credentials.
 *
 * There is no default key and no key derivation from a passphrase. The key is
 * supplied as a base64-encoded 32-byte value through
 * `PAYMENT_CREDENTIAL_ENCRYPTION_KEY`, is validated at boot, and is never
 * written to the database, an audit row or a log line.
 *
 * The additional authenticated data binds an envelope to its provider and
 * environment. Copying a ciphertext row to another provider or environment
 * therefore fails authentication instead of silently decrypting the wrong
 * credential set.
 */

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

import type { PaymentProvider, PaymentProviderEnvironment } from './payment-provider.contracts.js';

export interface CredentialCipher {
  /** False when no key was configured; writes must fail rather than fall back. */
  readonly available: boolean;
  encrypt(
    provider: PaymentProvider,
    environment: PaymentProviderEnvironment,
    values: Readonly<Record<string, string>>,
  ): string;
  decrypt(
    provider: PaymentProvider,
    environment: PaymentProviderEnvironment,
    envelope: string,
  ): Readonly<Record<string, string>>;
}

/** The deployment has no encryption key, so credentials cannot be stored. */
export class PaymentCredentialCipherUnavailableError extends Error {
  constructor() {
    super('Payment-provider credential encryption is not configured.');
    this.name = 'PaymentCredentialCipherUnavailableError';
  }
}

/**
 * Stored ciphertext could not be opened.
 *
 * Deliberately has no `cause`: a crypto error can include details about the
 * operation, and this message is the only thing a caller may ever surface.
 */
export class PaymentCredentialDecryptionError extends Error {
  constructor() {
    super('Stored payment-provider credentials cannot be decrypted with the configured key.');
    this.name = 'PaymentCredentialDecryptionError';
  }
}

const ENVELOPE_VERSION = 'v1';
const IV_BYTES = 12;
const TAG_BYTES = 16;
const KEY_BYTES = 32;

function additionalData(
  provider: PaymentProvider,
  environment: PaymentProviderEnvironment,
): Buffer {
  return Buffer.from(`${ENVELOPE_VERSION}|${provider}|${environment}`, 'utf8');
}

export class AesPaymentCredentialCipher implements CredentialCipher {
  readonly #key: Buffer | null;

  constructor(base64Key: string | null | undefined) {
    if (base64Key === null || base64Key === undefined || base64Key.trim().length === 0) {
      this.#key = null;
      return;
    }

    const key = Buffer.from(base64Key, 'base64');
    if (key.length !== KEY_BYTES) {
      // The message must not echo the value: it is key material.
      throw new Error('Payment credential encryption key must decode to exactly 32 bytes.');
    }
    this.#key = key;
  }

  get available(): boolean {
    return this.#key !== null;
  }

  encrypt(
    provider: PaymentProvider,
    environment: PaymentProviderEnvironment,
    values: Readonly<Record<string, string>>,
  ): string {
    const key = this.#key;
    if (!key) throw new PaymentCredentialCipherUnavailableError();

    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv('aes-256-gcm', key, iv, { authTagLength: TAG_BYTES });
    cipher.setAAD(additionalData(provider, environment));

    const plaintext = Buffer.from(JSON.stringify(values), 'utf8');
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const tag = cipher.getAuthTag();

    return [
      ENVELOPE_VERSION,
      iv.toString('base64url'),
      tag.toString('base64url'),
      ciphertext.toString('base64url'),
    ].join('.');
  }

  decrypt(
    provider: PaymentProvider,
    environment: PaymentProviderEnvironment,
    envelope: string,
  ): Readonly<Record<string, string>> {
    const key = this.#key;
    if (!key) throw new PaymentCredentialCipherUnavailableError();

    try {
      const parts = envelope.split('.');
      if (parts.length !== 4 || parts[0] !== ENVELOPE_VERSION) {
        throw new PaymentCredentialDecryptionError();
      }

      const iv = Buffer.from(parts[1] ?? '', 'base64url');
      const tag = Buffer.from(parts[2] ?? '', 'base64url');
      const ciphertext = Buffer.from(parts[3] ?? '', 'base64url');
      if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) {
        throw new PaymentCredentialDecryptionError();
      }

      const decipher = createDecipheriv('aes-256-gcm', key, iv, { authTagLength: TAG_BYTES });
      decipher.setAAD(additionalData(provider, environment));
      decipher.setAuthTag(tag);
      const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
      const parsed: unknown = JSON.parse(plaintext.toString('utf8'));

      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new PaymentCredentialDecryptionError();
      }

      const result: Record<string, string> = {};
      for (const [name, value] of Object.entries(parsed)) {
        if (typeof value !== 'string') throw new PaymentCredentialDecryptionError();
        result[name] = value;
      }
      return result;
    } catch (error) {
      if (error instanceof PaymentCredentialDecryptionError) throw error;
      throw new PaymentCredentialDecryptionError();
    }
  }
}
