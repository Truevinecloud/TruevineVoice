import { describe, expect, it } from 'vitest';

import { optionalEnv, optionalIntEnv, requireEnv } from './env.js';

describe('requireEnv', () => {
  it('returns the trimmed value when present', () => {
    expect(requireEnv('DATABASE_URL', { DATABASE_URL: '  postgres://x  ' })).toBe('postgres://x');
  });

  it('throws an actionable error when missing', () => {
    expect(() => requireEnv('DATABASE_URL', {})).toThrow(/Missing required environment variable/);
  });

  it('treats a blank value as missing', () => {
    expect(() => requireEnv('REDIS_URL', { REDIS_URL: '   ' })).toThrow(
      /Missing required environment variable/,
    );
  });
});

describe('optionalEnv', () => {
  it('returns the fallback when absent or blank', () => {
    expect(optionalEnv('API_HOST', '0.0.0.0', {})).toBe('0.0.0.0');
    expect(optionalEnv('API_HOST', '0.0.0.0', { API_HOST: '' })).toBe('0.0.0.0');
  });

  it('returns the provided value when present', () => {
    expect(optionalEnv('API_HOST', '0.0.0.0', { API_HOST: '127.0.0.1' })).toBe('127.0.0.1');
  });
});

describe('optionalIntEnv', () => {
  it('returns the fallback when absent', () => {
    expect(optionalIntEnv('API_PORT', 3001, {})).toBe(3001);
  });

  it('parses a valid positive integer', () => {
    expect(optionalIntEnv('API_PORT', 3001, { API_PORT: '8080' })).toBe(8080);
  });

  it('rejects non-numeric or non-positive values instead of silently defaulting', () => {
    expect(() => optionalIntEnv('API_PORT', 3001, { API_PORT: 'abc' })).toThrow(
      /must be a positive integer/,
    );
    expect(() => optionalIntEnv('API_PORT', 3001, { API_PORT: '0' })).toThrow(
      /must be a positive integer/,
    );
    expect(() => optionalIntEnv('API_PORT', 3001, { API_PORT: '-5' })).toThrow(
      /must be a positive integer/,
    );
  });
});
