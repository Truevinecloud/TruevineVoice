/**
 * Password hashing (Argon2id) and the password policy.
 *
 * Exposed as the `@truevine/auth/passwords` subpath rather than from the index
 * because `@node-rs/argon2` is a native Node module: it must never be pulled
 * into a browser bundle. The index entry point stays free of it, which is what
 * lets the frontends import the permission registry safely.
 */

import { hash as argonHash, verify as argonVerify } from '@node-rs/argon2';

/**
 * Argon2 variant identifier for Argon2id, from the reference implementation:
 * Argon2d = 0, Argon2i = 1, Argon2id = 2.
 *
 * `@node-rs/argon2` also exports an `Algorithm` const enum, but a const enum
 * cannot be referenced at all under `isolatedModules`, which this repository
 * enables. The numeric value is therefore stated here and proven by the test
 * suite rather than by the compiler: every hash this module produces is checked
 * for an `$argon2id$` prefix before it is stored, and `verifyPassword` denies
 * anything that is not an Argon2id hash. A wrong constant therefore fails a test
 * instead of silently downgrading to Argon2i or Argon2d.
 */
const ARGON2ID = 2;

/**
 * OWASP's current Argon2id recommendation: 19 MiB of memory, 2 iterations,
 * one lane.
 *
 * Memory cost is what makes Argon2 expensive to attack in parallel, so the
 * memory parameter is the one that matters and it is deliberately not reduced
 * for speed.
 */
export const ARGON2_OPTIONS = Object.freeze({
  algorithm: ARGON2ID,
  /** KiB. 19456 KiB = 19 MiB. */
  memoryCost: 19_456,
  /** Passes over memory. */
  timeCost: 2,
  /** Lanes. 1 keeps the memory bound honest. */
  parallelism: 1,
  /** Derived key length in bytes. */
  outputLen: 32,
});

/** Hashes a plaintext password for storage. */
export async function hashPassword(plaintext: string): Promise<string> {
  return argonHash(plaintext, ARGON2_OPTIONS);
}

/**
 * Verifies a candidate password against a stored hash.
 *
 * The algorithm prefix is checked before any work is done, so a row that somehow
 * holds a bcrypt or scrypt hash denies access instead of being accepted under a
 * weaker scheme. Returns false rather than throwing on an unrecognised hash, so
 * a corrupt row cannot crash the request.
 */
export async function verifyPassword(storedHash: string, candidate: string): Promise<boolean> {
  if (!isArgon2idHash(storedHash)) return false;

  try {
    return await argonVerify(storedHash, candidate);
  } catch {
    return false;
  }
}

/** Whether a stored hash was produced by Argon2id. */
export function isArgon2idHash(storedHash: string): boolean {
  return storedHash.startsWith('$argon2id$');
}

/** Minimum accepted password length. */
export const MIN_PASSWORD_LENGTH = 12;

/** Maximum accepted password length, to bound hashing cost. */
export const MAX_PASSWORD_LENGTH = 200;

/** Why a password was rejected. */
export type PasswordProblem = 'too_short' | 'too_long' | 'not_a_string' | 'blank';

/**
 * Checks a candidate password against the policy.
 *
 * Composition rules (upper, lower, digit, symbol) are deliberately absent: they
 * push users toward predictable substitutions and do not measurably improve
 * strength against guessing. Length is what matters.
 */
export function checkPassword(candidate: unknown): PasswordProblem | undefined {
  if (typeof candidate !== 'string') return 'not_a_string';
  if (candidate.length > MAX_PASSWORD_LENGTH) return 'too_long';
  if (candidate.trim().length === 0) return 'blank';
  return candidate.length >= MIN_PASSWORD_LENGTH ? undefined : 'too_short';
}

/** Whether the candidate meets the password policy. */
export function isAcceptablePassword(candidate: unknown): boolean {
  return checkPassword(candidate) === undefined;
}
