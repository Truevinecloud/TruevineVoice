#!/usr/bin/env node
// Runs the POSIX runtime tests for the backup implementation.
//
// infrastructure/backup/backup.test.sh is the real proof: it executes backup.sh
// and restore.sh against a live PostgreSQL instance and a real age key. It
// needs bash, `age`, and a container runtime, so it cannot run everywhere.
//
// This wrapper exists for the same reason as run-db-verify-tests.mjs: so that
// `npm test` still works on a Windows workstation. Off Linux it skips with an
// explanation rather than failing the suite. On Linux the suite runs, and if a
// prerequisite is genuinely missing the test script says so loudly and the run
// still fails on any assertion that did execute - it never fails silently.
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const script = resolve(here, '..', 'backup', 'backup.test.sh');

if (process.platform !== 'linux') {
  process.stdout.write(
    'SKIP: backup runtime tests are POSIX/Linux only (the backup job runs on the Ubuntu VPS).\n' +
      '      Static coverage of the same invariants still ran: infrastructure/backup/backup.spec.ts\n',
  );
  process.exit(0);
}

const result = spawnSync('bash', [script], { stdio: 'inherit' });
if (result.error) {
  process.stderr.write(`Could not run bash: ${result.error.message}\n`);
  process.exit(1);
}
process.exit(result.status ?? 1);
