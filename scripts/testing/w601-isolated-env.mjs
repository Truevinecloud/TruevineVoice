/**
 * Runs a W6-01 command against the dedicated isolated test stack.
 *
 * The database URL is derived from the gitignored root `.env` (or an existing
 * environment variable) by replacing only the host, port and database name.
 * Credentials are never printed or committed. Every child command receives
 * NODE_ENV=test and the W6-01 Redis endpoint, so the root scripts work without
 * caller-supplied environment variables and cannot drift onto another stack.
 */

import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const ENV_FILE = fileURLToPath(new URL('../../.env', import.meta.url));
const COMMAND = process.argv[2];
const ARGS = process.argv.slice(3);

if (!COMMAND) {
  throw new Error('Usage: node scripts/testing/w601-isolated-env.mjs <command> [args...]');
}

function readEnvValue(name) {
  if (!existsSync(ENV_FILE)) return undefined;
  const line = readFileSync(ENV_FILE, 'utf8')
    .split(/\r?\n/)
    .find((value) => value.startsWith(`${name}=`));
  if (!line) return undefined;
  return line.slice(line.indexOf('=') + 1).trim().replace(/^['"]|['"]$/g, '');
}

function isolatedDatabaseUrl() {
  const source = process.env['DATABASE_URL'] ?? readEnvValue('DATABASE_URL');
  if (!source) {
    throw new Error('DATABASE_URL is required to derive the isolated W6-01 database URL.');
  }
  const url = new URL(source);
  if (!url.username || !url.password) {
    throw new Error('DATABASE_URL must include credentials; the value is not printed.');
  }
  url.hostname = '127.0.0.1';
  url.port = '55434';
  url.pathname = '/truevine_w601_qa';
  url.search = '';
  url.hash = '';
  return url.toString();
}

process.env['DATABASE_URL'] = isolatedDatabaseUrl();
process.env['REDIS_URL'] = 'redis://127.0.0.1:56382/0';
process.env['NODE_ENV'] = 'test';

// npm sets npm_execpath when it runs a script. Re-entering npm through its CLI
// file avoids a shell on Windows and the argument-escaping warning that comes
// with spawn(..., { shell: true }).
const npmCli = process.env['npm_execpath'];
const child =
  COMMAND === 'npm' && npmCli?.endsWith('npm-cli.js')
    ? spawn(process.execPath, [npmCli, ...ARGS], { stdio: 'inherit', env: process.env })
    : spawn(COMMAND, ARGS, {
        stdio: 'inherit',
        shell: process.platform === 'win32',
        env: process.env,
      });

child.on('error', (error) => {
  process.stderr.write(`W6-01 isolated command failed to start: ${error.message}\n`);
  process.exitCode = 1;
});
child.on('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exitCode = code ?? 1;
});
