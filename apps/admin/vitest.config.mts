import { defineConfig } from 'vitest/config';

/**
 * Renders through `react-dom/server`; no DOM implementation required at this
 * stage. See the note in `apps/web/vitest.config.mts` about the JSX transform.
 */
export default defineConfig({
  oxc: {
    jsx: 'react-jsx',
  },
  test: {
    environment: 'node',
    include: ['src/**/*.spec.ts', 'src/**/*.spec.tsx'],
  },
});
