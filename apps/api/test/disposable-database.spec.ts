import { describe, expect, it } from 'vitest';

import {
  assertConnectedToDisposableDatabase,
  assertDisposableDatabase,
  isDisposableDatabaseName,
  isLoopbackHostname,
  type DisposableDatabase,
} from './disposable-database.js';

/**
 * The guard exists so that a test suite cannot be pointed at production by an
 * environment variable. These cases pin the allowlist itself: each one is a value
 * a real `.env` or a forwarder could plausibly produce.
 */

const SHARED = 'postgresql://truevine:truevine@localhost:55432/truevine_voice?schema=public';
const ISOLATED =
  'postgresql://truevine:truevine@localhost:55432/rbac_security_1740000000000_4321_empty';
const expected: DisposableDatabase = {
  name: 'truevine_voice',
  hostname: 'localhost',
  port: '55432',
};

describe('assertDisposableDatabase', () => {
  it('accepts the shared development database in the test environment', () => {
    expect(assertDisposableDatabase(SHARED, 'test')).toEqual(expected);
  });

  it('accepts a database created by the security harness', () => {
    expect(assertDisposableDatabase(ISOLATED, 'test').name).toBe(
      'rbac_security_1740000000000_4321_empty',
    );
  });

  it('accepts an explicit 127.0.0.1 address', () => {
    expect(
      assertDisposableDatabase(SHARED.replace('localhost', '127.0.0.1'), 'test').hostname,
    ).toBe('127.0.0.1');
  });

  it('refuses any environment other than test', () => {
    for (const environment of ['production', 'development', 'staging', undefined])
      expect(() => assertDisposableDatabase(SHARED, environment)).toThrow(/NODE_ENV/);
  });

  it('refuses a host that is not loopback', () => {
    for (const host of ['db.internal', '10.4.0.9', 'truevine-prod.example.com']) {
      expect(() =>
        assertDisposableDatabase(
          `postgresql://truevine:truevine@${host}:55432/truevine_voice`,
          'test',
        ),
      ).toThrow(/not loopback/);
    }
  });

  it('accepts a loopback host that is not one of the literals', () => {
    expect(isLoopbackHostname('127.9.8.7')).toBe(true);
    expect(
      assertDisposableDatabase(SHARED.replace('localhost', '127.9.9.9'), 'test').hostname,
    ).toBe('127.9.9.9');
  });

  it('refuses the production PostgreSQL port', () => {
    expect(() => assertDisposableDatabase(SHARED.replace(':55432', ':5432'), 'test')).toThrow(
      /port "5432" is not 55432/,
    );
  });

  it('refuses a missing port', () => {
    expect(() => assertDisposableDatabase(SHARED.replace(':55432', ''), 'test')).toThrow(
      /port "default" is not 55432/,
    );
  });

  it('refuses a database name that is not on the disposable allowlist', () => {
    for (const name of ['truevine_voice_prod', 'production', 'postgres', 'rbac_security'])
      expect(() =>
        assertDisposableDatabase(SHARED.replace('/truevine_voice', `/${name}`), 'test'),
      ).toThrow(/is not "truevine_voice" or a/);
  });

  it('refuses a non-PostgreSQL connection string', () => {
    expect(() =>
      assertDisposableDatabase('mysql://user@localhost:55432/truevine_voice', 'test'),
    ).toThrow(/protocol "mysql:" is not PostgreSQL/);
  });

  it('refuses a parameter that redirects the connection', () => {
    expect(() => assertDisposableDatabase(`${SHARED}&host=prod.internal`, 'test')).toThrow(
      /parameter "host" can redirect the connection/,
    );
  });

  it('still allows the schema parameter the application uses', () => {
    expect(assertDisposableDatabase(SHARED, 'test').name).toBe('truevine_voice');
  });

  it('refuses something that is not a URL at all', () => {
    expect(() => assertDisposableDatabase('not a url', 'test')).toThrow(
      /not a valid connection URL/,
    );
  });

  it('refuses a malformed database path rather than throwing a raw URIError', () => {
    expect(() =>
      assertDisposableDatabase(
        'postgresql://truevine:truevine@localhost:55432/truevine_%zz',
        'test',
      ),
    ).toThrow(/contains invalid percent-encoding/);
  });

  it('reports every failure at once rather than one per run', () => {
    let message = '';
    try {
      assertDisposableDatabase(
        'postgresql://user@db.internal:5432/prod?dbname=other',
        'production',
      );
    } catch (error) {
      message = (error as Error).message;
    }

    for (const fragment of [
      'NODE_ENV is "production"',
      'host "db.internal" is not loopback',
      'port "5432" is not 55432',
      'database "prod"',
      'parameter "dbname" can redirect the connection',
    ])
      expect(message, fragment).toContain(fragment);
  });
});

describe('isDisposableDatabaseName', () => {
  it('accepts only the shared name and harness-shaped names', () => {
    expect(isDisposableDatabaseName('truevine_voice')).toBe(true);
    expect(isDisposableDatabaseName('rbac_security_1_2_owners')).toBe(true);
    expect(isDisposableDatabaseName('rbac_security_1740000000000_999_representative')).toBe(true);
    expect(isDisposableDatabaseName('truevine_voice_prod')).toBe(false);
    expect(isDisposableDatabaseName('rbac_security_1_2_EMPTY')).toBe(false);
    expect(isDisposableDatabaseName('rbac_security')).toBe(false);
  });
});

describe('isLoopbackHostname', () => {
  it('accepts only loopback forms', () => {
    for (const host of ['localhost', '127.0.0.1', '127.255.255.254', '::1', '[::1]'])
      expect(isLoopbackHostname(host), host).toBe(true);
    for (const host of ['0.0.0.0', '10.0.0.1', 'db', 'example.com', '127.0.0.1.example.com'])
      expect(isLoopbackHostname(host), host).toBe(false);
  });
});

describe('assertConnectedToDisposableDatabase', () => {
  it('accepts a connection that reports the expected database', async () => {
    await expect(
      assertConnectedToDisposableDatabase(async () => 'truevine_voice', expected),
    ).resolves.toBeUndefined();
  });

  it('refuses a connection that reports a different database', async () => {
    await expect(
      assertConnectedToDisposableDatabase(async () => 'production', expected),
    ).rejects.toThrow(/names "truevine_voice" but the connection reports "production"/);
  });

  it('refuses a connection that reports nothing', async () => {
    await expect(
      assertConnectedToDisposableDatabase(async () => undefined, expected),
    ).rejects.toThrow(/reports "nothing"/);
  });
});
