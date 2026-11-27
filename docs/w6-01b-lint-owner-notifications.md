# W6-01B lint owner notifications

Status: **draft / not delivered**.

Per the handoff, the coordination messages below were drafted but not actually
sent because no direct agent-messaging channel was available. No delivery,
acknowledgement, acceptance, or remediation is claimed.

## Scope

W6-01B is limited to recording ownership and preparing copy-ready notifications
for pre-existing root-lint failures. It does not take ownership of the fixes.
The three findings are outside W6-01B because they belong to other workstreams:

| Finding | Assigned owner | Why it is outside W6-01B |
| --- | --- | --- |
| Unused `PrismaClient` import in `apps/api/src/payments/top-up-integration.controller.ts` and `no-explicit-any` in `apps/api/src/payments/top-up-integration.module.ts` | W5-02 payment integration / Kilo Code | This is payment-controller/module code. ADR 0029 records Kilo Code as owning payment E2E and migration-approval worktrees, and the W6-01 verification report already lists the controller error as unrelated to W6-01. W6-01B has no payment-code ownership. |
| `no-console` and `no-unsafe-finally` in `scripts/testing/w402-enqueue-smoke.mjs` | W4-02 worker/recovery / GitHub Copilot | This is the W4-02 enqueue smoke script documented in the README. Changing its logging or cleanup flow is worker/recovery work, not W6-01B lint coordination. |
| `react-hooks/exhaustive-deps` warning in `apps/admin/src/app/billing/page.tsx` | RBAC-008 billing admin owner (name not confirmed) | ADR 0025 identifies RBAC-008 as platform Billing Admin wallet adjustments. No confirmed individual owner name was found in the repository documentation, so W6-01B does not guess one or edit the financial admin UI. |

**W6-01B did not change, fix, suppress, weaken, skip, or configure away any of
these findings.** No source file, test, `package.json`, lint configuration, ADR,
or other documentation was changed by this task. The only file created is this
record.

## Exact failures observed

Read-only scoped ESLint check (exit code `1`):

```text
F:\TruevineVoice\apps\admin\src\app\billing\page.tsx
  127:6  warning  React Hook useEffect has a missing dependency: 'load'. Either include it or remove the dependency array  react-hooks/exhaustive-deps

F:\TruevineVoice\apps\api\src\payments\top-up-integration.controller.ts
  2:15  error  'PrismaClient' is defined but never used. Allowed unused vars must match /^_/u  @typescript-eslint/no-unused-vars

F:\TruevineVoice\apps\api\src\payments\top-up-integration.module.ts
  32:53  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any

F:\TruevineVoice\scripts\testing\w402-enqueue-smoke.mjs
   91:3  error  Unexpected console statement    no-console
  110:9  error  Unsafe usage of ThrowStatement  no-unsafe-finally

✖ 4 problems (3 errors, 1 warning)
```

The scoped run confirms the context's three paths, rules, and severity mix. It
also supplies exact line/column positions. A later root `npm run lint` run during
W6-01B browser acceptance reproduced those findings and additionally found
`apps/api/src/payments/top-up-integration.module.ts:32:53` —
`@typescript-eslint/no-explicit-any`; that finding is recorded above under the
same W5-02 owner. No suppression or fix was applied.

## Copy-ready notifications — draft / not delivered

### 1. W5-02 payment integration / Kilo Code — draft / not delivered

```text
Subject: W5-02 lint follow-up: unused PrismaClient import

Please triage/remediate in the W5-02 lane:
apps/api/src/payments/top-up-integration.controller.ts:2:15 —
@typescript-eslint/no-unused-vars: 'PrismaClient' is defined but never used.
Allowed unused vars must match /^_/u. Also
apps/api/src/payments/top-up-integration.module.ts:32:53 —
@typescript-eslint/no-explicit-any: Unexpected any. Specify a different type.

This is a pre-existing root-lint error unrelated to W6-01B. W6-01B did not
change or suppress it.
```

### 2. W4-02 worker/recovery / GitHub Copilot — draft / not delivered

```text
Subject: W4-02 lint follow-up: w402-enqueue-smoke.mjs

Please triage/remediate in the W4-02 worker/recovery lane:
scripts/testing/w402-enqueue-smoke.mjs:91:3 — no-console: Unexpected console
statement; 110:9 — no-unsafe-finally: Unsafe usage of ThrowStatement.

These are pre-existing root-lint errors unrelated to W6-01B. W6-01B did not
change or suppress them.
```

### 3. RBAC-008 billing admin owner — draft / not delivered

```text
Subject: RBAC-008 lint follow-up: admin billing hook dependency warning

Please route to the confirmed RBAC-008 billing admin owner; the individual name
was not confirmed in this handoff. In apps/admin/src/app/billing/page.tsx:127:6,
react-hooks/exhaustive-deps warns: React Hook useEffect has a missing
dependency: 'load'. Either include it or remove the dependency array.

This is a pre-existing root-lint warning unrelated to W6-01B. W6-01B did not
change or suppress it.
```

## Commands used

1. `git status --short` — read-only inspection; showed extensive pre-existing
   uncommitted user work before this task. No cleanup or staging was performed.
2. `npm.cmd exec -- eslint apps/api/src/payments/top-up-integration.controller.ts scripts/testing/w402-enqueue-smoke.mjs apps/admin/src/app/billing/page.tsx` —
   exit code `1`; 3 errors and 1 warning, exact output recorded above.
3. `git status --short docs/w6-01b-lint-owner-notifications.md` — read-only
   verification after creation; reports the new untracked documentation file.

## Discrepancy from context

No discrepancy found. The supplied paths, rule names, severities, ownership
assignments, and "draft / not delivered" status match the scoped check and the
handoff. The new information recorded here is the exact ESLint message text and
line/column positions, plus the explicit statement that W6-01B made no source,
test, configuration, or suppression changes.
