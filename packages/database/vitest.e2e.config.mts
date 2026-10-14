import { defineConfig } from 'vitest/config';

/**
 * End-to-end tests: assert tenancy rules against live PostgreSQL.
 * Requires `npm run infra:up`.
 *
 * Kept out of `vitest.config.mts` so the fast unit suite never depends on a
 * database, but never skipped silently: a missing PostgreSQL is a real failure
 * that must be reported, not hidden.
 *
 * No SWC transform is used; see `apps/api/vitest.config.mts` for why.
 */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.e2e-spec.ts'],
    hookTimeout: 60_000,
    testTimeout: 60_000,
  },
});
