import js from '@eslint/js';
import next from 'eslint-config-next';
import prettier from 'eslint-config-prettier';
import globals from 'globals';
import tseslint from 'typescript-eslint';

/** Source globs for the two Next.js frontends. */
const nextAppFiles = [
  'apps/web/**/*.{js,jsx,mjs,ts,tsx,mts,cts}',
  'apps/admin/**/*.{js,jsx,mjs,ts,tsx,mts,cts}',
];

/**
 * `eslint-config-next` ships a config that matches every source file in the
 * repository. That is correct inside a single Next.js project and wrong in a
 * monorepo, so each entry is narrowed to the two frontend apps. Its
 * global-ignores entry is dropped because the repository-level `ignores` block
 * below already covers `.next`, `out`, `build` and `next-env.d.ts`.
 */
const nextScoped = next
  .filter((config) => Array.isArray(config.files))
  .map((config) => ({ ...config, files: nextAppFiles }));

/**
 * Truevine Voice - ESLint 10 flat configuration.
 *
 * Layout:
 *   - ignores: build output and generated code
 *   - TypeScript recommended rules for every workspace
 *   - Next.js rules scoped to the two frontend apps only, so backend code is
 *     never linted with React rules
 *   - Prettier last, so formatting never conflicts with lint rules
 */
export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/.next/**',
      '**/out/**',
      '**/build/**',
      '**/coverage/**',
      '**/*.tsbuildinfo',
      // Generated Prisma client: not ours to lint.
      'packages/database/src/generated/**',
      // Next.js generated types.
      '**/next-env.d.ts',
    ],
  },

  js.configs.recommended,
  ...tseslint.configs.recommended,

  {
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
    },
    rules: {
      // Underscore-prefixed bindings are intentionally unused.
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
        },
      ],
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'no-console': 'error',
    },
  },

  // Node-side workspaces: API, worker, packages, build tooling.
  {
    files: [
      'apps/api/**/*.ts',
      'apps/worker/**/*.ts',
      'packages/**/*.ts',
      '*.mjs',
      '**/*.config.ts',
      '**/*.config.mts',
    ],
    languageOptions: {
      globals: { ...globals.node },
    },
  },

  ...nextScoped,

  {
    files: nextAppFiles,
    languageOptions: {
      globals: { ...globals.browser },
    },
    rules: {
      // Both frontends use the App Router, so there is no `pages` directory for
      // this rule to inspect. Disabling it here is a deliberate, scoped decision
      // rather than a blanket suppression.
      '@next/next/no-html-link-for-pages': 'off',
    },
  },

  // Prettier must come last to disable formatting-related lint rules.
  prettier,
);
