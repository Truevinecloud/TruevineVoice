/**
 * Generates the local-only synthetic callback credential.
 *
 * The credential is 32 random bytes encoded as base64url. It is written to the
 * existing gitignored `.qa-credentials` directory with owner-only permissions.
 * This script never prints the value: callers pass the file path to the API and
 * read the file themselves when they need to send the header.
 */

import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { restrictPath } from './local-qa-credentials.mjs';

const FILE_NAME = 'local-callback-key';

/** Absolute path of the generated credential file. */
export function localCallbackKeyPath(directory = resolve(process.cwd(), '.qa-credentials')) {
  return join(directory, FILE_NAME);
}

/** Generates the credential file. An existing value is preserved unless forced. */
export function generateLocalCallbackKey(directory = resolve(process.cwd(), '.qa-credentials'), options = {}) {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  restrictPath(directory, true);

  const destination = localCallbackKeyPath(directory);
  if (existsSync(destination) && !options.force) return destination;

  const temporary = join(directory, `.${FILE_NAME}.${randomUUID()}.tmp`);
  writeFileSync(temporary, `${randomBytes(32).toString('base64url')}\n`, {
    encoding: 'utf8',
    mode: 0o600,
    flag: 'wx',
  });
  restrictPath(temporary);

  try {
    if (existsSync(destination)) rmSync(destination);
    renameSync(temporary, destination);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
  restrictPath(destination);
  return destination;
}

function main() {
  const force = process.argv.slice(2).includes('--force');
  const path = generateLocalCallbackKey(undefined, { force });
  process.stdout.write(`Local callback credential is ready at ${path}. Value not shown.\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
