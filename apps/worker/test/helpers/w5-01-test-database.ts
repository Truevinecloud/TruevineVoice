import { createDatabaseClient, type PrismaClient } from '@truevine/database';

/**
 * W5-01 settlement tests are deliberately pinned to a database that no other
 * suite uses. Financial fixtures are synthetic, but a mistaken connection to
 * the shared development database must still fail before any write.
 */
const DATABASE_NAME = 'truevine_w501_integration_test';
const LOOPBACK_HOSTNAMES = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);
const ROUTING_PARAMETERS = ['host', 'hostaddr', 'port', 'database', 'dbname'];

export function assertW501DatabaseUrl(
  databaseUrl: string | undefined,
  environment: string | undefined,
): string {
  if (environment !== 'test') throw new Error('W5-01 tests require NODE_ENV=test.');
  if (!databaseUrl) throw new Error('W5-01 tests require DATABASE_URL.');

  let url: URL;
  try {
    url = new URL(databaseUrl);
  } catch {
    throw new Error('W5-01 DATABASE_URL is not a valid PostgreSQL connection URL.');
  }

  if (
    !['postgres:', 'postgresql:'].includes(url.protocol) ||
    !LOOPBACK_HOSTNAMES.has(url.hostname) ||
    url.port !== '55432' ||
    url.pathname !== `/${DATABASE_NAME}` ||
    url.hash ||
    ROUTING_PARAMETERS.some((parameter) => url.searchParams.has(parameter))
  ) {
    throw new Error(
      `W5-01 tests refuse every database except local ${DATABASE_NAME} on port 55432.`,
    );
  }
  return databaseUrl;
}

export async function createW501TestDatabaseClient(): Promise<PrismaClient> {
  const databaseUrl = assertW501DatabaseUrl(
    process.env['DATABASE_URL'],
    process.env['NODE_ENV'],
  );
  const prisma = createDatabaseClient(databaseUrl, { log: [] });
  try {
    const rows = await prisma.$queryRaw<Array<{ database_name: string }>>`
      SELECT current_database() AS database_name`;
    if (rows[0]?.database_name !== DATABASE_NAME) {
      throw new Error('Connected PostgreSQL database did not match the W5-01 integration target.');
    }
    return prisma;
  } catch (error) {
    await prisma.$disconnect();
    throw error;
  }
}
