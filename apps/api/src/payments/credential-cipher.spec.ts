import { describe, expect, it } from 'vitest';

import {
  AesPaymentCredentialCipher,
  PaymentCredentialCipherUnavailableError,
  PaymentCredentialDecryptionError,
} from './credential-cipher.js';

const KEY = Buffer.alloc(32, 7).toString('base64');
const OTHER_KEY = Buffer.alloc(32, 9).toString('base64');

const credentials = {
  subscriptionKey: 'subscription-value',
  apiUser: 'user-value',
  apiKey: 'secret-value',
};

describe('AesPaymentCredentialCipher', () => {
  it('round-trips a credential set without storing plaintext', () => {
    const cipher = new AesPaymentCredentialCipher(KEY);
    const envelope = cipher.encrypt('MTN_MOMO', 'SANDBOX', credentials);

    expect(envelope.startsWith('v1.')).toBe(true);
    expect(envelope).not.toContain('subscription-value');
    expect(envelope).not.toContain('secret-value');
    expect(cipher.decrypt('MTN_MOMO', 'SANDBOX', envelope)).toEqual(credentials);
  });

  it('uses a fresh nonce so equal inputs produce different ciphertext', () => {
    const cipher = new AesPaymentCredentialCipher(KEY);
    expect(cipher.encrypt('MTN_MOMO', 'SANDBOX', credentials)).not.toBe(
      cipher.encrypt('MTN_MOMO', 'SANDBOX', credentials),
    );
  });

  it('refuses to open an envelope moved to another provider or environment', () => {
    const cipher = new AesPaymentCredentialCipher(KEY);
    const envelope = cipher.encrypt('MTN_MOMO', 'SANDBOX', credentials);

    expect(() => cipher.decrypt('MTN_MOMO', 'PRODUCTION', envelope)).toThrow(
      PaymentCredentialDecryptionError,
    );
    expect(() => cipher.decrypt('AIRTEL_MONEY', 'SANDBOX', envelope)).toThrow(
      PaymentCredentialDecryptionError,
    );
  });

  it('rejects a tampered envelope rather than returning partial plaintext', () => {
    const cipher = new AesPaymentCredentialCipher(KEY);
    const envelope = cipher.encrypt('AIRTEL_MONEY', 'PRODUCTION', {
      clientId: 'client',
      clientSecret: 'secret',
    });
    const parts = envelope.split('.');
    const original = parts[3] ?? '';
    parts[3] = `${original.slice(0, -1)}${original.endsWith('A') ? 'B' : 'A'}`;

    expect(() => cipher.decrypt('AIRTEL_MONEY', 'PRODUCTION', parts.join('.'))).toThrow(
      PaymentCredentialDecryptionError,
    );
  });

  it('reports an unavailable cipher instead of falling back to a key', () => {
    const cipher = new AesPaymentCredentialCipher(null);

    expect(cipher.available).toBe(false);
    expect(() => cipher.encrypt('MTN_MOMO', 'SANDBOX', credentials)).toThrow(
      PaymentCredentialCipherUnavailableError,
    );
    expect(() => cipher.decrypt('MTN_MOMO', 'SANDBOX', 'v1.a.b.c')).toThrow(
      PaymentCredentialCipherUnavailableError,
    );
  });

  it('refuses a key that is not exactly 32 bytes', () => {
    expect(() => new AesPaymentCredentialCipher(Buffer.alloc(16).toString('base64'))).toThrow(
      /32 bytes/,
    );
  });

  it('cannot decrypt with a different key', () => {
    const envelope = new AesPaymentCredentialCipher(KEY).encrypt(
      'MTN_MOMO',
      'SANDBOX',
      credentials,
    );
    expect(() =>
      new AesPaymentCredentialCipher(OTHER_KEY).decrypt('MTN_MOMO', 'SANDBOX', envelope),
    ).toThrow(PaymentCredentialDecryptionError);
  });
});
