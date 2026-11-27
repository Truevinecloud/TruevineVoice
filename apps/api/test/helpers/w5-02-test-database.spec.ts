import { describe, expect, it } from 'vitest';

import { assertW502DatabaseUrl } from './w5-02-test-database.js';

const ALLOWED =
  'postgresql://test:test@127.0.0.1:55432/truevine_w502_integration_test?schema=public';

describe('W5-02 database guard', () => {
  it('accepts only the pinned W5-02 database on the local development port', () => {
    expect(assertW502DatabaseUrl(ALLOWED, 'test')).toBe(ALLOWED);
  });

  it('refuses the shared development database', () => {
    expect(() => assertW502DatabaseUrl(ALLOWED.replace('truevine_w502_integration_test', 'truevine_voice'), 'test')).toThrow(/refuse every database/);
  });

  it('refuses a non-test environment', () => {
    expect(() => assertW502DatabaseUrl(ALLOWED, 'development')).toThrow(/NODE_ENV=test/);
  });

  it('refuses a routing parameter that could redirect the connection', () => {
    expect(() => assertW502DatabaseUrl(`${ALLOWED}&host=prod`, 'test')).toThrow(/refuse every database/);
  });
});
