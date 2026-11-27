import { describe, expect, it } from 'vitest';

import { assertW503DatabaseUrl } from './w5-03-test-database.js';

const ALLOWED =
  'postgresql://test:test@127.0.0.1:55432/truevine_w503_integration_test?schema=public';

describe('W5-03 isolated database guard', () => {
  it('accepts only the dedicated test database on loopback port 55432', () => {
    expect(assertW503DatabaseUrl(ALLOWED, 'test')).toBe(ALLOWED);
    expect(assertW503DatabaseUrl(ALLOWED.replace('127.0.0.1', 'localhost'), 'test')).toContain(
      'truevine_w503_integration_test',
    );
  });

  it.each([
    ['main database', ALLOWED.replace('truevine_w503_integration_test', 'truevine_voice')],
    [
      'other W5 database',
      ALLOWED.replace('truevine_w503_integration_test', 'truevine_w502_integration_test'),
    ],
    ['wrong port', ALLOWED.replace(':55432', ':5432')],
    ['remote host', ALLOWED.replace('127.0.0.1', 'prod.example')],
    ['routing parameter', `${ALLOWED}&host=elsewhere`],
  ])('rejects %s', (_label, url) => {
    expect(() => assertW503DatabaseUrl(url, 'test')).toThrow(/refuse every database/);
  });

  it('requires test mode and a URL', () => {
    expect(() => assertW503DatabaseUrl(ALLOWED, 'development')).toThrow(/NODE_ENV=test/);
    expect(() => assertW503DatabaseUrl(undefined, 'test')).toThrow(/DATABASE_URL/);
    expect(() => assertW503DatabaseUrl('not-a-url', 'test')).toThrow(/valid PostgreSQL/);
  });
});
