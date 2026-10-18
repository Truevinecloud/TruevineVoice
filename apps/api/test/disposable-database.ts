/**
 * Decides whether a test suite is allowed to connect to a database.
 *
 * A destructive or mutation-heavy suite that can be aimed at any reachable
 * PostgreSQL by editing one environment variable will eventually be aimed at the
 * wrong one. Loopback plus a fixed port is not enough on its own: a forwarder
 * (`ssh -L 55432:prod:5432`), a tunnel, or a local `.env` pointing at a shared
 * instance all present as "localhost:55432" while being none of the disposable
 * database this project expects.
 *
 * The rule here is a positive allowlist, so the default answer is "no":
 *
 *   - the environment must be exactly `test`;
 *   - the host must be loopback;
 *   - the port must be the repository development port;
 *   - the database must be a name this project recognises as disposable;
 *   - the URL must not carry a parameter that redirects it somewhere else.
 *
 * `truevine_voice` is the database `docker-compose.yml`, `.env.example` and the
 * CI e2e job all use; it is disposable because the Compose stack and the
 * GitHub-hosted runner both start it empty and discard it. `rbac_security_*` is
 * created and dropped per run by `infrastructure/scripts/run-security-tests.mjs`.
 * Nothing else is allowed, so a production database named for a customer cannot
 * be reached by accident.
 */

/** The loopback port the development Compose stack publishes PostgreSQL on. */
export const DISPOSABLE_DATABASE_PORT = '55432';

/** The shared development/test database name used by Compose and CI. */
export const SHARED_TEST_DATABASE = 'truevine_voice';

/**
 * Databases created and dropped by `npm run test:security`.
 *
 * Mirrors the harness's own `validateCleanup` pattern so the two cannot drift
 * into disagreeing about which databases are disposable.
 */
export const ISOLATED_DATABASE_PATTERN = /^rbac_security_\d+_\d+_[a-z]+$/;

/**
 * Query parameters that would let the URL route the connection somewhere other
 * than the host, port and database it appears to name.
 *
 * Prisma already rejects a `host` that does not match, but this check does not
 * depend on Prisma's behaviour and gives a clearer failure. `schema`, `sslmode`
 * and the other non-routing parameters stay permitted.
 */
const ROUTING_PARAMETERS = ['host', 'hostaddr', 'port', 'database', 'dbname'] as const;

const LOOPBACK_HOSTNAMES = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

export interface DisposableDatabase {
  /** The database name, without the leading slash. */
  readonly name: string;
  readonly hostname: string;
  readonly port: string;
}

/** A dotted-quad IPv4 literal, not merely a hostname that begins with `127.`. */
const IPV4_LOOPBACK = /^127(\.\d{1,3}){3}$/;

export function isLoopbackHostname(hostname: string): boolean {
  // `127.0.0.0/8` is loopback in its entirety. The match is anchored to a full
  // literal: `127.0.0.1.example.com` starts with `127.` but resolves wherever its
  // owner says, and treating it as loopback would be the entire bug this guard
  // exists to prevent.
  return LOOPBACK_HOSTNAMES.has(hostname) || IPV4_LOOPBACK.test(hostname);
}

export function isDisposableDatabaseName(name: string): boolean {
  return name === SHARED_TEST_DATABASE || ISOLATED_DATABASE_PATTERN.test(name);
}

/**
 * Validates a connection string, returning the database it names.
 *
 * @throws if any part of the string fails the allowlist. The message lists every
 * failure at once, because a developer fixing one at a time should not have to
 * run the suite repeatedly to discover the next.
 */
export function assertDisposableDatabase(
  databaseUrl: string,
  environment: string | undefined,
): DisposableDatabase {
  let url: URL;
  try {
    url = new URL(databaseUrl);
  } catch {
    throw new Error('DATABASE_URL is not a valid connection URL.');
  }

  const reasons: string[] = [];
  let name = '';
  try {
    name = decodeURIComponent(url.pathname.replace(/^\//, ''));
  } catch {
    reasons.push(`database path "${url.pathname}" contains invalid percent-encoding`);
  }

  if (url.protocol !== 'postgres:' && url.protocol !== 'postgresql:')
    reasons.push(`protocol "${url.protocol}" is not PostgreSQL`);

  if (environment !== 'test') reasons.push(`NODE_ENV is "${environment ?? 'unset'}", not "test"`);

  if (!isLoopbackHostname(url.hostname)) reasons.push(`host "${url.hostname}" is not loopback`);

  if (url.port !== DISPOSABLE_DATABASE_PORT)
    reasons.push(
      `port "${url.port === '' ? 'default' : url.port}" is not ${DISPOSABLE_DATABASE_PORT}`,
    );

  if (!isDisposableDatabaseName(name))
    reasons.push(
      `database "${name}" is not "${SHARED_TEST_DATABASE}" or a ${ISOLATED_DATABASE_PATTERN} database`,
    );

  for (const parameter of ROUTING_PARAMETERS)
    if (url.searchParams.has(parameter))
      reasons.push(`parameter "${parameter}" can redirect the connection`);

  if (reasons.length > 0)
    throw new Error(
      'Refusing to run against a database that is not a verified disposable test database: ' +
        `${reasons.join('; ')}.`,
    );

  return { name, hostname: url.hostname, port: url.port };
}

/**
 * Confirms a live connection really reached `expected.name`.
 *
 * The URL and the connection are two different claims, and only the server can
 * settle which database a session landed in. A pooler or a misconfigured client
 * can accept the URL and connect elsewhere, so the answer is checked rather than
 * assumed. Call this once, immediately after connecting and before any write,
 * with a function that asks the live connection for `current_database()`.
 */
export async function assertConnectedToDisposableDatabase(
  readCurrentDatabase: () => Promise<string | undefined>,
  expected: DisposableDatabase,
): Promise<void> {
  const connected = await readCurrentDatabase();

  if (connected !== expected.name)
    throw new Error(
      `DATABASE_URL names "${expected.name}" but the connection reports ` +
        `"${connected ?? 'nothing'}".`,
    );
}
