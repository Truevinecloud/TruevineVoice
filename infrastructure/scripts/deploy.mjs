import { execFileSync } from 'node:child_process';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import {
  PROCESS_NAMES,
  validateConfig,
  validateProcesses,
  verifyHttp,
} from './verify-deployment.mjs';

const ROOT = '/var/www/TruevineVoice';
const RELEASES = join(ROOT, 'releases');
const CURRENT = join(ROOT, 'current');

function run(command, args, cwd, capture = false) {
  try {
    return execFileSync(command, args, {
      cwd,
      encoding: 'utf8',
      stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
      env: { ...process.env, NODE_ENV: 'development', NEXT_TELEMETRY_DISABLED: '1' },
      timeout: 30 * 60 * 1000,
    });
  } catch (error) {
    throw new Error(
      `Command failed: ${command} (exit ${error.status ?? 'unknown'}); consult protected service logs`,
      { cause: error },
    );
  }
}

export function assertNoMigrations(directory) {
  const schema = readFileSync(join(directory, 'packages/database/prisma/schema.prisma'), 'utf8');
  if (
    /^\s*(model|enum|view)\s+/m.test(schema) ||
    readdirSync(join(directory, 'packages/database/prisma/migrations')).some(
      (name) => name !== 'README.md',
    )
  ) {
    throw new Error(
      'Schema/migrations changed: review SQL and introduce an expand/contract plan before deploying',
    );
  }
}

function switchCurrent(release) {
  const temporary = `${CURRENT}.${process.pid}`;
  symlinkSync(release, temporary);
  renameSync(temporary, CURRENT);
}

function checkedRelease(candidate) {
  const target = realpathSync(candidate);
  if (!target.startsWith(`${RELEASES}/`))
    throw new Error('Release must be inside the releases directory');
  return target;
}

async function verify(release, config) {
  const sha = readFileSync(join(release, 'REVISION'), 'utf8').trim();
  let lastError;
  for (let attempt = 0; attempt < 12; attempt += 1) {
    try {
      await verifyHttp(config, sha);
      validateProcesses(JSON.parse(run('pm2', ['jlist'], release, true)), release, sha);
      return;
    } catch (error) {
      lastError = error;
      await delay(5000);
    }
  }
  throw lastError;
}

export async function activate({ release, previous, restart, check, switchLink, save, stopNew }) {
  try {
    await restart(release);
    await check(release);
    switchLink(release);
    await save();
  } catch (error) {
    if (previous) {
      try {
        await restart(previous);
        await check(previous);
        switchLink(previous);
        await save();
      } catch (rollbackError) {
        throw new AggregateError(
          [error, rollbackError],
          'Deployment AND rollback failed; operator intervention required',
          { cause: rollbackError },
        );
      }
    } else {
      await stopNew();
    }
    throw error;
  }
}

async function main() {
  if (process.platform !== 'linux' || process.getuid() === 0) {
    throw new Error('Deploy on Linux as the dedicated non-root deployment account');
  }
  const rollback = process.argv[2] === '--rollback';
  const sha = process.argv[rollback ? 3 : 2];
  if (!/^[a-f0-9]{40}$/.test(sha ?? '')) throw new Error('A full verified commit SHA is required');
  const config = validateConfig(JSON.parse(readFileSync(join(ROOT, 'deployment.json'), 'utf8')));
  const envFile = join(ROOT, '.env');
  const envStat = statSync(envFile);
  if (!envStat.isFile() || (envStat.mode & 0o027) !== 0) {
    throw new Error(
      'Production .env must already exist with mode 600 or 640; it will not be changed',
    );
  }
  // The audited legacy checkout is retained for recovery, never used as release input.
  mkdirSync(RELEASES, { recursive: true, mode: 0o750 });
  let previous = null;
  if (existsSync(CURRENT)) {
    if (!lstatSync(CURRENT).isSymbolicLink()) throw new Error('current must be a symlink');
    previous = checkedRelease(CURRENT);
    if (!existsSync(join(previous, 'READY')))
      throw new Error('The rollback baseline is not verified (READY missing)');
  }
  const processes = JSON.parse(run('pm2', ['jlist'], ROOT, true));
  const managed = processes.filter((entry) => PROCESS_NAMES.includes(entry.name));
  if (!previous && managed.length) {
    throw new Error(
      'Existing PM2 deployment needs a verified baseline release before first cutover; see runbook',
    );
  }
  for (const entry of managed) {
    if (!entry.pm2_env.pm_cwd?.startsWith(`${RELEASES}/`)) {
      throw new Error(`Audit and migrate the existing process before cutover: ${entry.name}`);
    }
  }
  let release;
  if (rollback) {
    const matches = readdirSync(RELEASES).filter(
      (name) => name.startsWith(`${sha}-`) && existsSync(join(RELEASES, name, 'READY')),
    );
    if (matches.length !== 1) throw new Error('Expected one READY release for rollback SHA');
    release = checkedRelease(join(RELEASES, matches[0]));
  } else {
    const staging = realpathSync(process.cwd());
    if (!staging.startsWith(`${ROOT}/incoming/`))
      throw new Error('Build from an isolated incoming directory');
    assertNoMigrations(staging);
    const expectedNode = readFileSync(join(staging, '.nvmrc'), 'utf8').trim();
    const pkg = JSON.parse(readFileSync(join(staging, 'package.json'), 'utf8'));
    if (
      process.version !== `v${expectedNode}` ||
      run('npm', ['--version'], staging, true).trim() !== pkg.packageManager.split('@')[1]
    )
      throw new Error('Install the exact pinned Node and npm versions');
    if (existsSync(join(staging, '.env'))) throw new Error('Incoming release must contain no .env');
    run('npm', ['ci', '--include=dev'], staging);
    run('npm', ['run', 'prisma:generate'], staging);
    run('npm', ['run', 'prisma:validate'], staging);
    run('npm', ['run', 'build'], staging);
    release = join(RELEASES, `${sha}-${Date.now()}`);
    renameSync(staging, release);
    symlinkSync(envFile, join(release, '.env'));
    writeFileSync(join(release, 'REVISION'), `${sha}\n`, { mode: 0o640 });
  }
  for (const file of [
    'apps/web/.next/BUILD_ID',
    'apps/admin/.next/BUILD_ID',
    'apps/api/dist/main.js',
    'apps/worker/dist/main.js',
  ]) {
    if (!existsSync(join(release, file))) throw new Error(`Missing production build: ${file}`);
  }
  assertNoMigrations(release);
  await activate({
    release,
    previous,
    restart: (directory) =>
      run(
        'pm2',
        [
          'startOrReload',
          join(directory, 'infrastructure/pm2/ecosystem.config.js'),
          '--update-env',
        ],
        directory,
      ),
    check: (directory) => verify(directory, config),
    switchLink: (directory) => {
      writeFileSync(join(directory, 'READY'), readFileSync(join(directory, 'REVISION')), {
        mode: 0o640,
      });
      switchCurrent(directory);
    },
    save: () => run('pm2', ['save'], ROOT),
    stopNew: () => {
      const started = JSON.parse(run('pm2', ['jlist'], ROOT, true)).filter((entry) =>
        PROCESS_NAMES.includes(entry.name),
      );
      if (started.length) run('pm2', ['delete', ...started.map((entry) => entry.name)], ROOT);
      if (existsSync(CURRENT)) unlinkSync(CURRENT);
      run('pm2', ['save'], ROOT);
    },
  });
  process.stdout.write(`Verified deployment ${sha}; release ${release}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    // Child-process output and PM2 environments may contain secrets.
    process.stderr.write('Deployment failed; review the failed command or preflight checks\n');
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
