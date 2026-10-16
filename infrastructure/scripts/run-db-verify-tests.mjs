#!/usr/bin/env node
// Runs the POSIX runtime tests for db-verify.sh.
//
// The tests themselves are a bash script. This wrapper exists only so that
// `npm test` still works on a Windows workstation, where bash may be absent.
// It skips cleanly off Linux rather than failing the suite.
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const script = resolve(here, 'db-verify.runtime.sh');
const target = resolve(here, 'db-verify.sh');

if (process.platform !== 'linux') {
  process.stdout.write(
    'SKIP: db-verify runtime tests are POSIX/Linux only (the recovery procedures they cover only run on the Ubuntu VPS).\n',
  );
  process.exit(0);
}

const result = spawnSync('bash', [script, target], { stdio: 'inherit' });
if (result.error) {
  process.stderr.write(`Could not run bash: ${result.error.message}\n`);
  process.exit(1);
}
process.exit(result.status ?? 1);
