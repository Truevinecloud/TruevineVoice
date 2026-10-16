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
    // `test/**/*.spec.ts` is included deliberately. Those files are unit tests
    // that happen to need the shared fakes in `test/fakes/`, not end-to-end
    // tests: they inject in-memory stores and never touch PostgreSQL, Redis or
    // the HTTP layer. End-to-end tests are `*.e2e-spec.ts` and run under
    // `vitest.e2e.config.mts` against real infrastructure.
    include: ['src/**/*.spec.ts', 'test/**/*.spec.ts'],
    setupFiles: ['./test/setup.ts'],
  },
});
