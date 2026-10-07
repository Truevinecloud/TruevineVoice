import { defineConfig } from 'vitest/config';

/**
 * Component tests render through `react-dom/server`, which needs no DOM
 * implementation.
 *
 * `jsx: 'react-jsx'` is set explicitly rather than relying on tsconfig
 * discovery, so the transform is deterministic regardless of which
 * configuration file the runner picks up.
 *
 * If real browser tests become necessary later, add `happy-dom` or `jsdom` and
 * a React plugin here rather than pulling them in now.
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
