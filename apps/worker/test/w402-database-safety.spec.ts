import { describe, expect, it } from 'vitest';
import { assertW402DatabaseUrl } from './helpers/w402-test-database.js';

const W402_DATABASE_URL =
  'postgresql://test:test@localhost:55432/truevine_w402_integration_test?schema=public';

describe('W402 database safety', () => {
  it('accepts only the isolated local integration database in the test environment', () => {
    expect(assertW402DatabaseUrl(W402_DATABASE_URL, 'test')).toBe(W402_DATABASE_URL);
  });

  it('refuses the development database, non-test environments and routing overrides', () => {
    expect(() =>
      assertW402DatabaseUrl(
        W402_DATABASE_URL.replace('truevine_w402_integration_test', 'truevine_voice'),
        'test',
      ),
    ).toThrow(/refuse every database/);
    expect(() => assertW402DatabaseUrl(W402_DATABASE_URL, 'development')).toThrow(
      /NODE_ENV=test/,
    );
    expect(() => assertW402DatabaseUrl(`${W402_DATABASE_URL}&host=other`, 'test')).toThrow(
      /refuse every database/,
    );
  });
});
