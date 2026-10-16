import { describe, expect, it } from 'vitest';

import {
  ARGON2_OPTIONS,
  checkPassword,
  hashPassword,
  isAcceptablePassword,
  isArgon2idHash,
  MAX_PASSWORD_LENGTH,
  MIN_PASSWORD_LENGTH,
  verifyPassword,
} from './passwords.js';

describe('Argon2id hashing', () => {
  it('produces an Argon2id hash, never Argon2i or Argon2d', () => {
    return hashPassword('a-long-enough-password').then((hash) => {
      expect(isArgon2idHash(hash)).toBe(true);
      expect(hash.startsWith('$argon2id$')).toBe(true);
    });
  });

  it('uses the OWASP-recommended parameters', () => {
    // Memory cost is the parameter that makes parallel guessing expensive.
    expect(ARGON2_OPTIONS.memoryCost).toBe(19_456);
    expect(ARGON2_OPTIONS.timeCost).toBe(2);
    expect(ARGON2_OPTIONS.parallelism).toBe(1);
  });

  it('salts each hash, so two identical passwords differ on disk', async () => {
    const first = await hashPassword('a-long-enough-password');
    const second = await hashPassword('a-long-enough-password');

    expect(first).not.toBe(second);
  });

  it('never returns the plaintext', async () => {
    const hash = await hashPassword('a-long-enough-password');

    expect(hash).not.toContain('a-long-enough-password');
  });
});

describe('password verification', () => {
  it('accepts the correct password', async () => {
    const hash = await hashPassword('correct horse battery');

    await expect(verifyPassword(hash, 'correct horse battery')).resolves.toBe(true);
  });

  it('rejects an incorrect password', async () => {
    const hash = await hashPassword('correct horse battery');

    await expect(verifyPassword(hash, 'Correct horse battery')).resolves.toBe(false);
    await expect(verifyPassword(hash, '')).resolves.toBe(false);
  });

  it('denies rather than throwing on an unrecognised hash', async () => {
    // A corrupt or foreign-hash row must not crash the request; it must deny.
    await expect(verifyPassword('not-a-hash', 'anything')).resolves.toBe(false);
    await expect(verifyPassword('', 'anything')).resolves.toBe(false);
  });

  it('denies a hash that is not Argon2id', async () => {
    // Proves the `ARGON2ID = 2` constant is real: if the module were silently
    // hashing with Argon2i or Argon2d, this hash would verify and the guard
    // below would be vacuous.
    const hash = await hashPassword('a-long-enough-password');
    expect(isArgon2idHash(hash)).toBe(true);

    const downgraded = hash.replace('$argon2id$', '$argon2i$');
    expect(isArgon2idHash(downgraded)).toBe(false);
    await expect(verifyPassword(downgraded, 'a-long-enough-password')).resolves.toBe(false);
  });
});

describe('password policy', () => {
  it('requires a minimum length', () => {
    expect(MIN_PASSWORD_LENGTH).toBe(12);
    expect(isAcceptablePassword('a'.repeat(MIN_PASSWORD_LENGTH))).toBe(true);
    expect(checkPassword('a'.repeat(MIN_PASSWORD_LENGTH - 1))).toBe('too_short');
  });

  it('rejects a password that is only whitespace at policy length', () => {
    // Guards the "not a string" edge of a length-only rule: 200 spaces is long
    // enough but carries no secret.
    expect(checkPassword(' '.repeat(MIN_PASSWORD_LENGTH))).toBe('blank');
  });

  it('rejects a password longer than the cap, to bound hashing cost', () => {
    expect(checkPassword('a'.repeat(MAX_PASSWORD_LENGTH + 1))).toBe('too_long');
  });

  it('rejects a non-string', () => {
    expect(checkPassword(undefined)).toBe('not_a_string');
    expect(checkPassword(12345678901234)).toBe('not_a_string');
  });

  it('does not demand composition rules', () => {
    // A long passphrase with no digits or symbols is accepted: composition
    // rules push users toward predictable substitutions.
    const passphrase = 'my-long-passphrase-entirely';

    expect(passphrase).not.toMatch(/[0-9]/);
    expect(isAcceptablePassword(passphrase)).toBe(true);
  });
});
