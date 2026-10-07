import { defineConfig } from 'vitest/config';

/**
 * Unit tests.
 *
 * See `apps/api/vitest.config.mts` for why no SWC transform is used.
 */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.spec.ts'],
  },
});
