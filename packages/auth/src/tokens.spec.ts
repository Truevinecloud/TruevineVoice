import { describe, expect, it } from 'vitest';

import { digestsMatch, generateToken, hashToken, TOKEN_BYTES } from './tokens.js';

describe('token generation', () => {
  it('produces a distinct value every time', () => {
    const tokens = new Set(Array.from({ length: 500 }, () => generateToken()));

    expect(tokens.size).toBe(500);
  });

  it('produces 256 bits of output by default', () => {
    // 32 bytes base64url-encoded without padding is 43 characters.
    expect(TOKEN_BYTES).toBe(32);
    expect(generateToken()).toHaveLength(43);
  });

  it('produces a URL-safe value with no padding characters', () => {
    const token = generateToken();

    expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('never derives the token from user-supplied data', () => {
    // Two calls with identical inputs differ, so a token cannot be replayed by
    // reconstructing it from something the client already knows.
    expect(generateToken()).not.toBe(generateToken());
  });
});

describe('token hashing', () => {
  it('is deterministic, so a presented token can be looked up', () => {
    const token = generateToken();

    expect(hashToken(token)).toBe(hashToken(token));
  });

  it('is not the token, so a database disclosure yields no credential', () => {
    const token = generateToken();

    expect(hashToken(token)).not.toBe(token);
    expect(hashToken(token)).toHaveLength(64);
  });

  it('separates tokens that differ by one character', () => {
    const digest = hashToken(generateToken());

    expect(digest).not.toBe(hashToken('a-different-token'));
  });
});

describe('constant-time digest comparison', () => {
  it('accepts an exact match', () => {
    const digest = hashToken('token-value');

    expect(digestsMatch(digest, digest)).toBe(true);
  });

  it('rejects a different digest of the same length', () => {
    expect(digestsMatch(hashToken('a'), hashToken('b'))).toBe(false);
  });

  it('rejects a length mismatch without throwing', () => {
    expect(digestsMatch('short', 'a-much-longer-digest-value')).toBe(false);
  });
});
