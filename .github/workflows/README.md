# GitHub Actions workflows

**Status: intentionally empty. CI is explicitly deferred to a later step.**

No workflow files exist yet. Introducing a pipeline before there is a
deployable system would be speculative, and a broken or redundant first workflow
is expensive to unwind.

The `package.json` scripts a CI pipeline will need are already in place, so
adding a workflow later requires no changes to the applications:

| Script                    | Purpose                                         |
| ------------------------- | ----------------------------------------------- |
| `npm ci`                  | Reproducible install from the lockfile          |
| `npm run prisma:validate` | Validates `schema.prisma` without a database    |
| `npm run prisma:generate` | Generates the typed Prisma client               |
| `npm run lint`            | ESLint across the whole monorepo                |
| `npm run format:check`    | Prettier formatting gate                        |
| `npm run typecheck`       | `tsc --noEmit` in every workspace               |
| `npm run test`            | Unit tests, no infrastructure required          |
| `npm run test:e2e`        | End-to-end tests, requires PostgreSQL and Redis |
| `npm run build`           | Builds packages, then apps                      |

Note that `npm run typecheck` and `npm run test` depend on `npm run
build:packages`, because apps resolve `@truevine/*` through their built
`dist` output.

When CI is added, it must run on Node 24.19.0 (from `.nvmrc`), must not need
access to production secrets, and must never run `prisma migrate deploy`.
