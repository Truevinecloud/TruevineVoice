import { defineConfig } from 'vitest/config';

/**
 * Unit tests.
 *
 * No SWC/Babel transform is used. Vitest's built-in TypeScript transform
 * (esbuild/oxc) honours the `experimentalDecorators` setting from
 * `tsconfig.json`, which is all NestJS needs: every constructor-injected
 * dependency in this app declares an explicit `@Inject(TOKEN)`, so dependency
 * injection never relies on `emitDecoratorMetadata` (which no fast transform
 * implements).
 *
 * Keeping the toolchain free of native binaries means the suite runs on any
 * developer machine without extra setup.
 */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.spec.ts'],
    setupFiles: ['./test/setup.ts'],
  },
});
