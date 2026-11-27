import { describe, expect, it } from 'vitest';

import {
  assertLocalPaymentEnvironment,
  assertTestOperator,
  buildLocalPaymentSecurityConfig,
} from './local-payment-security.js';

const BASE_ENV: Record<string, string | undefined> = {
  NODE_ENV: 'development',
  DATABASE_URL: 'postgresql://truevine:truevine@localhost:55432/truevine_payment_e2e?schema=public',
  REDIS_URL: 'redis://localhost:56379',
  W502_SYNTHETIC_PAYMENTS_ENABLED: 'true',
};

describe('local payment security', () => {
  it('passes for an authorized local test environment', () => {
    const config = buildLocalPaymentSecurityConfig(BASE_ENV);
    expect(() => assertLocalPaymentEnvironment(config)).not.toThrow();
    expect(config.enabled).toBe(true);
    expect(config.databaseUrl).toContain('truevine_payment_e2e');
  });

  it('rejects production environments', () => {
    const config = buildLocalPaymentSecurityConfig({ ...BASE_ENV, NODE_ENV: 'production' });
    expect(() => assertLocalPaymentEnvironment(config)).toThrow('prohibited in production');
  });

  it('rejects disabled synthetic payments', () => {
    const config = buildLocalPaymentSecurityConfig({ ...BASE_ENV, W502_SYNTHETIC_PAYMENTS_ENABLED: 'false' });
    expect(() => assertLocalPaymentEnvironment(config)).toThrow('disabled by default');
  });

  it('rejects missing database URL', () => {
    const config = buildLocalPaymentSecurityConfig({ ...BASE_ENV, DATABASE_URL: undefined });
    expect(() => assertLocalPaymentEnvironment(config)).toThrow('DATABASE_URL is required');
  });

  it('rejects main database URL', () => {
    const config = buildLocalPaymentSecurityConfig({
      ...BASE_ENV,
      DATABASE_URL: 'postgresql://truevine:truevine@localhost:55432/truevine_voice?schema=public',
    });
    expect(() => assertLocalPaymentEnvironment(config)).toThrow('isolated test database');
  });

  it('rejects non-loopback Redis URL', () => {
    const config = buildLocalPaymentSecurityConfig({
      ...BASE_ENV,
      REDIS_URL: 'redis://redis.example.com:6379',
    });
    expect(() => assertLocalPaymentEnvironment(config)).toThrow('loopback Redis URL');
  });

  it('accepts an authorized test operator', () => {
    expect(() => assertTestOperator({ userId: 'operator-1', roles: ['TEST_OPERATOR'] })).not.toThrow();
  });

  it('rejects a test operator without the required role', () => {
    expect(() => assertTestOperator({ userId: 'operator-1', roles: ['USER'] })).toThrow('TEST_OPERATOR role');
  });

  it('rejects a test operator without a user ID', () => {
    expect(() => assertTestOperator({ userId: '', roles: ['TEST_OPERATOR'] })).toThrow('user ID');
  });
});