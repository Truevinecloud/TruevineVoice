import { existsSync } from 'node:fs';
import path from 'node:path';

import { config as loadEnvFile } from 'dotenv';
import { defineConfig } from 'prisma/config';

/**
 * Prisma CLI configuration (Prisma ORM v7 layout).
 *
 * Paths are resolved relative to this file, not to the current directory, so
 * the commands behave identically whether they are run from the repository
 * root or from `packages/database`.
 */

// Workspace-local `.env` first, then the repository-root `.env` used by the
// rest of the monorepo. `dotenv` never overwrites values that are already set,
// so real environment variables always win. Existing files are checked first so
// that a missing file does not produce misleading "injected env (0)" output.
for (const candidate of [
  path.resolve(process.cwd(), '.env'),
  path.resolve(process.cwd(), '..', '..', '.env'),
]) {
  if (existsSync(candidate)) {
    loadEnvFile({ path: candidate });
  }
}

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
  },
  datasource: {
    // Deliberately not `env('DATABASE_URL')`: commands such as
    // `prisma generate` and `prisma validate` must succeed without a database
    // or without DATABASE_URL being present (for example during CI typecheck).
    url: process.env['DATABASE_URL'] ?? '',
  },
});
