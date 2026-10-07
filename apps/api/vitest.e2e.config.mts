import { defineConfig } from 'vitest/config';

/**
 * End-to-end tests.
 *
 * These boot the real Nest application. Tests that exercise live PostgreSQL and
 * Redis require local infrastructure to be running:
 *
 *   npm run infra:up
 *   npm run test:e2e
 *
 * They are kept out of `npm run test` so that the fast unit suite never depends
 * on Docker, but they are never skipped silently - a broken dependency should
 * fail loudly here.
 *
 * See `vitest.config.mts` for why no SWC transform is used.
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
