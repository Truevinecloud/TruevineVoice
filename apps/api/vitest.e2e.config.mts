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
    env: {
      // `WEB_PUBLIC_URL` has no default on purpose: a password-reset link built
      // against the wrong host either 404s for the recipient or works on a host
      // somebody else controls, so the application refuses to boot without it.
      // The end-to-end suites therefore set it here rather than weakening the
      // check.
      WEB_PUBLIC_URL: 'http://localhost:3000',

      // No mail leaves a test run. `none` records that a send was requested and
      // sends nothing; `development` would write token-bearing files to disk.
      EMAIL_TRANSPORT: 'none',
    },
  },
});
