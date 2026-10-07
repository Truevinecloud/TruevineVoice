import { defineConfig } from 'vitest/config';

/**
 * End-to-end tests: boot the real worker application context against live Redis.
 * Requires `npm run infra:up`.
 *
 * See `apps/api/vitest.config.mts` for why no SWC transform is used.
 */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.e2e-spec.ts'],
    setupFiles: ['./test/setup.ts'],
    hookTimeout: 60_000,
    testTimeout: 60_000,
  },
});
