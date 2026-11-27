/**
 * Local synthetic payment security guards.
 *
 * This file is intentionally independent of W5-01 billing ownership and of any
 * real provider contract. It enforces that synthetic payment workflows can only
 * run in an explicitly authorized local-test environment and never in production.
 *
 * Identity is derived from the session (PRINCIPAL), never from a forgeable
 * request header. Database identity is verified by an exact connection-string
 * comparison at boot and by `SELECT current_database()` before every write.
 */

const PRODUCTION_ENVIRONMENTS = ['production', 'prod'];
const ISOLATED_DB_HOSTNAMES = ['localhost', '127.0.0.1', '::1'];
const ISOLATED_DB_NAME = 'truevine_payment_e2e';

export interface LocalPaymentSecurityConfig {
  readonly enabled: boolean;
  readonly environment: string;
  readonly databaseUrl: string | undefined;
  readonly redisUrl: string | undefined;
}

export function buildLocalPaymentSecurityConfig(env: Record<string, string | undefined>): LocalPaymentSecurityConfig {
  const databaseUrl = env['DATABASE_URL'];
  const redisUrl = env['REDIS_URL'];
  return {
    enabled: env['W502_SYNTHETIC_PAYMENTS_ENABLED'] === 'true',
    environment: env['NODE_ENV'] ?? 'development',
    databaseUrl,
    redisUrl,
  };
}

export function assertLocalPaymentEnvironment(config: LocalPaymentSecurityConfig): void {
  if (PRODUCTION_ENVIRONMENTS.includes(config.environment)) {
    throw new Error('Synthetic payments are prohibited in production.');
  }
  if (!config.enabled) {
    throw new Error('Synthetic payments are disabled by default. Set W502_SYNTHETIC_PAYMENTS_ENABLED=true.');
  }
  if (!config.databaseUrl) {
    throw new Error('DATABASE_URL is required for synthetic payment testing.');
  }
  if (!isIsolatedDatabaseUrl(config.databaseUrl)) {
    throw new Error('Synthetic payments require an isolated test database URL.');
  }
  if (config.redisUrl && !isLoopbackRedisUrl(config.redisUrl)) {
    throw new Error('Synthetic payments require a loopback Redis URL.');
  }
}

function isIsolatedDatabaseUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    if (!ISOLATED_DB_HOSTNAMES.includes(parsed.hostname)) return false;
    return parsed.pathname === `/${ISOLATED_DB_NAME}`;
  } catch {
    return false;
  }
}

function isLoopbackRedisUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return ISOLATED_DB_HOSTNAMES.includes(parsed.hostname);
  } catch {
    return false;
  }
}

export interface TestOperator {
  readonly userId: string;
  readonly roles: readonly string[];
}

export function assertTestOperator(operator: TestOperator): void {
  if (!operator.userId) {
    throw new Error('Test operator user ID is required.');
  }
  if (!operator.roles.includes('TEST_OPERATOR')) {
    throw new Error('Test operator must have TEST_OPERATOR role.');
  }
}

/**
 * Verifies the actual connected database identity by name.
 *
 * Called before every synthetic financial write to confirm the running process
 * is connected to the intended isolated test database, not the main development
 * database. The database URL substring check at boot is not enough: the process
 * could be connected to a different database than the URL suggests if the URL
 * was tampered with after boot.
 */
export async function assertDatabaseIdentity(
  prisma: { $queryRawUnsafe: (sql: string, ...values: unknown[]) => Promise<unknown> },
): Promise<void> {
  const row = await prisma.$queryRawUnsafe(`SELECT current_database()`);
  const result = row as { current_database: string }[];
  const actual = result[0]?.current_database;
  if (actual !== ISOLATED_DB_NAME) {
    throw new Error(
      `Refusing synthetic payment write: connected database is "${actual}", expected "${ISOLATED_DB_NAME}".`,
    );
  }
}