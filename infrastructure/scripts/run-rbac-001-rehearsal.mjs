#!/usr/bin/env node
// Runs the RBAC-001 migration rehearsal (infrastructure/scripts/rbac-001-rehearsal.sh).
//
// The rehearsal needs a real container runtime and a Linux host: it starts a
// disposable PostgreSQL, runs `prisma migrate deploy` against it with several
// adversarial data profiles, and injects failures to measure whether a failed
// migration leaves partial schema behind. That cannot run on a Windows
// workstation, so this wrapper exists for the same reason as
// run-db-verify-tests.mjs and run-backup-tests.mjs: so `npm test` and
// `npm run test:rehearsal` work everywhere.
//
// Off Linux it skips with an explanation rather than failing the suite. On
// Linux, if the runtime or dependencies are genuinely missing, the script says
// so loudly; with REHEARSAL_REQUIRED=1 (which CI sets) a skip is a hard failure
// instead of a silent green tick.
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const script = resolve(here, 'rbac-001-rehearsal.sh');

if (process.platform !== 'linux') {
  process.stdout.write(
    'SKIP: the RBAC-001 migration rehearsal is POSIX/Linux only (it starts a ' +
      'disposable PostgreSQL container).\n' +
      '      The happy-path migration is still applied on every PR by the CI ' +
      'e2e job; run this rehearsal from Linux or CI for the adversarial profiles.\n',
  );
  process.exit(0);
}

const result = spawnSync('bash', [script], { stdio: 'inherit' });
if (result.error) {
  process.stderr.write(`Could not run bash: ${result.error.message}\n`);
  process.exit(1);
}
process.exit(result.status ?? 1);
