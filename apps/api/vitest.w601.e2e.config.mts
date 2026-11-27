import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

/**
 * W6-01 HTTP acceptance uses its own positive database allowlist in the spec.
 * The generic e2e safety setup is intentionally not loaded: it does not include
 * truevine_w601_qa, and widening it would weaken every other e2e suite.
 */
export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  test: {
    environment: 'node',
    include: ['test/w601-*.e2e-spec.ts'],
    setupFiles: ['./test/setup.ts'],
    hookTimeout: 60_000,
    testTimeout: 60_000,
    env: {
      WEB_PUBLIC_URL: 'http://localhost:3000',
      EMAIL_TRANSPORT: 'none',
    },
  },
});
