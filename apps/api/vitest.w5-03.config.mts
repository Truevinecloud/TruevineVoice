import { defineConfig } from 'vitest/config';

/**
 * W5-03 isolated PostgreSQL suite.
 *
 * Only the dedicated truevine_w503_integration_test database is accepted. This
 * config does not boot HTTP, Redis or the whole application; it exercises the
 * read adapter directly against synthetic call and ledger fixtures.
 */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/w5-03-*.dbspec.ts'],
    setupFiles: ['./test/helpers/w5-03-database.setup.ts'],
    hookTimeout: 60_000,
    testTimeout: 60_000,
    fileParallelism: false,
    env: {
      NODE_ENV: 'test',
    },
  },
});
