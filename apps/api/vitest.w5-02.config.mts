import { defineConfig } from 'vitest/config';

/**
 * W5-02 isolated PostgreSQL suite.
 *
 * The normal API E2E config boots the whole application against the shared
 * disposable database. This suite does not boot HTTP or Redis; it exercises the
 * unwired reconciliation service directly against a dedicated ledger database.
 * Its `*.dbspec.ts` extension keeps it out of both the unit suite and the shared
 * E2E suite, so it cannot accidentally be pointed at `truevine_voice`.
 */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/w5-02-*.dbspec.ts'],
    setupFiles: ['./test/helpers/w5-02-database.setup.ts'],
    hookTimeout: 60_000,
    testTimeout: 60_000,
    env: {
      NODE_ENV: 'test',
    },
  },
});
