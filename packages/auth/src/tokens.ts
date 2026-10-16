/**
 * Opaque session, invitation and password-reset tokens.
 *
 * Tokens are 256 bits of CSPRNG output. The raw value goes to the client in a
 * cookie or an emailed link; only its SHA-256 digest is stored. A database
 * disclosure therefore yields no usable credential, which is the whole reason
 * for opaque tokens over self-describing ones.
 */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/** Number of random bytes in a token. 32 bytes = 256 bits. */
export const TOKEN_BYTES = 32;

/** Default lifetime of a sign-in session. */
export const SESSION_TTL_MS = 12 * 60 * 60 * 1_000;

/** Default lifetime of an invitation link. */
export const INVITATION_TTL_MS = 7 * 24 * 60 * 60 * 1_000;

/** Default lifetime of a password-reset token. */
export const PASSWORD_RESET_TTL_MS = 60 * 60 * 1_000;

/** Creates a fresh token. Never deterministic, never derived from user data. */
export function generateToken(bytes: number = TOKEN_BYTES): string {
  return randomBytes(bytes).toString('base64url');
}

/**
 * Hashes a token for storage.
 *
 * SHA-256, not a password hash: the input is already 256 bits of entropy, so
 * there is nothing to brute-force and no reason to spend Argon2 time. The
 * stored value is a lookup key, not a secret.
 */
export function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/**
 * Constant-time comparison for equal-length digests.
 *
 * Used where a mismatch must not leak *how much* of a digest matched through
 * timing. Returns false rather than throwing on a length mismatch, so callers
 * never have to special-case it.
 */
export function digestsMatch(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  return timingSafeEqual(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'));
}
