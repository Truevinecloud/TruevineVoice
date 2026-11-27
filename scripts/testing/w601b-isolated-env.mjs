/**
 * Runs a W6-01B browser-acceptance command against its dedicated QA stack.
 *
 * The database URL is derived from the gitignored root `.env` by replacing only
 * the database name; credentials are never printed. Redis uses the dedicated
 * W6-01B container on loopback port 56384. Every child receives explicit,
 * fail-closed destination pins so an environment mistake cannot send browser
 * acceptance traffic to the main, W6-01 or W5-03E stacks.
 */

import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const ENV_FILE = fileURLToPath(new URL('../../.env', import.meta.url));
const COMMAND = process.argv[2];
const ARGS = process.argv.slice(3);

if (!COMMAND) {
  throw new Error('Usage: node scripts/testing/w601b-isolated-env.mjs <command> [args...]');
}

function readEnvValue(name) {
  if (!existsSync(ENV_FILE)) return undefined;
  const line = readFileSync(ENV_FILE, 'utf8')
    .split(/\r?\n/)
    .find((value) => value.startsWith(`${name}=`));
  if (!line) return undefined;
  return line.slice(line.indexOf('=') + 1).trim().replace(/^['"]|['"]$/g, '');
}

function qaDatabaseUrl() {
  const source = process.env['DATABASE_URL'] ?? readEnvValue('DATABASE_URL');
  if (!source) {
    throw new Error('DATABASE_URL is required to derive the W6-01B database URL.');
  }
  const url = new URL(source);
  if (!url.username || !url.password) {
    throw new Error('DATABASE_URL must include credentials; the value is not printed.');
  }
  url.hostname = '127.0.0.1';
  url.port = '55434';
  url.pathname = '/truevine_w601b_qa';
  url.search = '';
  url.hash = '';
  return url.toString();
}

process.env['DATABASE_URL'] = qaDatabaseUrl();
process.env['EXPECTED_DATABASE_NAME'] = 'truevine_w601b_qa';
process.env['REDIS_URL'] = 'redis://127.0.0.1:56384/0';
process.env['NODE_ENV'] ??= 'development';
process.env['API_HOST'] = '127.0.0.1';
process.env['API_PORT'] = '3201';
process.env['TRUEVINE_API_URL'] = 'http://127.0.0.1:3201';
process.env['CAMPAIGN_EXECUTION_MODE'] = 'local';
process.env['CAMPAIGN_EXECUTION_QUEUE_NAME'] ??= 'w601b-campaign-execution';
process.env['AT_VOICE_PROVIDER'] = 'false';

// npm sets npm_execpath when it runs a script. Re-entering npm through its CLI
// file avoids a shell on Windows and its argument-escaping warning.
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
  process.stderr.write(`W6-01B QA command failed to start: ${error.message}\n`);
  process.exitCode = 1;
});
child.on('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exitCode = code ?? 1;
});
