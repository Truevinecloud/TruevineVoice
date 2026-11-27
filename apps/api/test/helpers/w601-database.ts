import { createDatabaseClient, type PrismaClient } from '@truevine/database';

const DATABASE_NAME = 'truevine_w601_qa';
const LOOPBACK_HOSTNAMES = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);
const ROUTING_PARAMETERS = ['host', 'hostaddr', 'port', 'database', 'dbname'];

/** Positive allowlist for the W6-01 HTTP suite; do not widen for other databases. */
export function assertW601DatabaseUrl(
  databaseUrl: string | undefined,
  environment: string | undefined,
): string {
  if (environment !== 'test') throw new Error('W6-01 HTTP tests require NODE_ENV=test.');
  if (!databaseUrl) throw new Error('W6-01 HTTP tests require DATABASE_URL.');

  let url: URL;
  try {
    url = new URL(databaseUrl);
  } catch {
    throw new Error('W6-01 DATABASE_URL is not a valid PostgreSQL connection URL.');
  }

  if (
    !['postgres:', 'postgresql:'].includes(url.protocol) ||
    !LOOPBACK_HOSTNAMES.has(url.hostname) ||
    url.port !== '55434' ||
    url.pathname !== `/${DATABASE_NAME}` ||
    url.hash ||
    ROUTING_PARAMETERS.some((parameter) => url.searchParams.has(parameter))
  ) {
    throw new Error(
      `W6-01 HTTP tests refuse every database except local ${DATABASE_NAME} on port 55434.`,
    );
  }
  return databaseUrl;
}

export async function createW601ApiDatabaseClient(): Promise<{
  readonly databaseUrl: string;
  readonly prisma: PrismaClient;
}> {
  const databaseUrl = assertW601DatabaseUrl(
    process.env['DATABASE_URL'],
    process.env['NODE_ENV'],
  );
  const prisma = createDatabaseClient(databaseUrl, { log: [] });
  try {
    const rows = await prisma.$queryRaw<Array<{ database_name: string }>>`
      SELECT current_database() AS database_name`;
    if (rows[0]?.database_name !== DATABASE_NAME) {
      throw new Error('Connected PostgreSQL database did not match the W6-01 QA target.');
    }
    return { databaseUrl, prisma };
  } catch (error) {
    await prisma.$disconnect();
    throw error;
  }
}
