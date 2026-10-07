# ADR 0002: Runtime and toolchain version policy

- **Status:** Accepted
- **Date:** 2026-10-07

## Context

The developer workstation currently runs Node v24.19.0. Production and CI need
a pinned, supported runtime. The framework ecosystem imposes its own
constraints, and choosing "latest" for each tool would produce an unbuildable
combination.

## Decision

Pin **Node 24.19.0** and use an **LTS-based** toolchain.

- `.nvmrc` pins the exact version.
- `package.json` `engines` declares `node >=24.19.0 <25` and `npm >=11.17.0 <12`.
- `.npmrc` sets `engine-strict=true`, so a mismatched runtime fails at install
  time instead of at runtime.
- TypeScript is pinned to **6.0.3**, deliberately not the `latest` tag.

### Why TypeScript 6 and not 7

TypeScript 7 is the native-port major release. It cannot be used yet because
the toolchain has not caught up:

- `typescript-eslint` declares `typescript >=4.8.4 <6.1.0`
- `@nestjs/schematics` declares `typescript >=6.0.0`

TypeScript 6.0.3 is the only release satisfying both constraints
simultaneously. TypeScript 5.x would fail the Nest CLI peer range; TypeScript 7
would fail the lint peer range.

### Why Node 24 rather than the newest release

Node 26 exists but is `Current`, not `LTS`. LTS is required for a production
and CI runtime. Node 24 is the active LTS line and satisfies every engine
constraint in the dependency graph (Next.js `>=20.9.0`, NestJS `^20`,
`@nestjs/schematics ^22.22.3 || ^24.15.0 || >=26.0.0`, Prisma
`^20.19 || ^22.12 || >=24.0`, ESLint `^20.19.0 || ^22.13.0 || >=24`).

### ESM-only

`@nestjs/common`, `@nestjs/core`, `@nestjs/platform-express` and
`@nestjs/testing` are published with `"type": "module"` and no CommonJS export.
NestJS 12 cannot be consumed from a CommonJS build.

Therefore **every Node workspace in this repository is an ES module**
(`"type": "module"` in each `package.json`, `module`/`moduleResolution` set to
`nodenext`). Consequences:

- Relative imports carry an explicit `.js` extension, including in the
  generated Prisma client.
- The Prisma generator must use `moduleFormat = "esm"`.
- The two Next.js apps are the exception: they keep Next.js's own defaults
  (`bundler` resolution, extensionless relative imports) because Turbopack does
  not remap `.js` specifiers onto TypeScript sources.
- A built package is verified by importing it from plain Node ESM, not only by
  type-checking it.

### No native transform in the test toolchain

NestJS dependency injection normally reads constructor parameter types from the
`design:paramtypes` metadata that `emitDecoratorMetadata` produces. Only `tsc`
(or SWC, or Babel) emits that metadata; esbuild and Oxc do not.

Rather than require a native transform such as `@swc/core` — which ships
platform binaries that fail to load on some developer machines — every
constructor-injected dependency in this repository declares an **explicit
`@Inject(TOKEN)`**. NestJS overlays those tokens onto the (possibly empty)
`design:paramtypes` array, so injection is fully specified by source and the
test suite runs on Vitest's built-in transform with no extra tooling.

The cost is a few extra decorators. The benefit is that `npm test` works on any
machine with no native build step, and that no test can pass or fail because
decorator metadata was missing.

### Other pins

| Tool              | Version | Note                                                                                                        |
| ----------------- | ------- | ----------------------------------------------------------------------------------------------------------- |
| Next.js           | 16.4.0  | Current stable; requires React 19                                                                           |
| React / React DOM | 19.3.0  | Matches Next.js peer range                                                                                  |
| NestJS            | 12.1.2  | Current stable major                                                                                        |
| BullMQ            | 6.3.11  | Satisfies `@nestjs/bullmq` peer range                                                                       |
| ioredis           | 6.0.0   | Used directly by BullMQ and health probes                                                                   |
| Prisma            | 7.10.0  | Newest **stable**. `prisma@latest` currently resolves to an 8.0.0 release candidate, which is not shippable |
| ESLint            | 10.12.0 | Flat config; compatible with `eslint-config-next` and `typescript-eslint`                                   |
| Vitest            | 5.0.3   | Requires an SWC transform for NestJS decorator metadata                                                     |

Exact versions are used rather than ranges (`save-exact=true`) so that builds
are reproducible and upgrades are explicit, reviewable changes.

## Consequences

- Upgrades become deliberate pull requests rather than surprises.
- The TypeScript 6.0.3 pin must be revisited together with the
  `typescript-eslint` and `@nestjs/schematics` peer ranges. It is a documented
  constraint, not an arbitrary preference.
- Node 24 reaches end of life; a Node 26 upgrade will need the same treatment.
- The repository is ESM-only for Node code. Introducing CommonJS in a new
  workspace would not compile, which is the intended safety net.
- The explicit `@Inject(TOKEN)` convention must be preserved in every new
  NestJS class. Dropping it in one place would break that file's tests while
  `nest build` still succeeded, so review should check for it.
