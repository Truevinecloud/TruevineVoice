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
  assertReleaseEnvAccessible,
  managedProcesses,
  PROCESS_NAMES,
  staleManagedProcesses,
  validateConfig,
  validateProcesses,
  verifyHttp,
} from './verify-deployment.mjs';

const ROOT = '/var/www/TruevineVoice';
const RELEASES = join(ROOT, 'releases');
const CURRENT = join(ROOT, 'current');

/**
 * Environment every release command runs with.
 *
 * `NODE_ENV` is `production` for everything here, including the build.
 * Forcing `development` made `next build` prerender with the development React
 * renderer, which expects a live dispatcher and crashes on `useContext` while
 * statically rendering `/_global-error`:
 *
 *   TypeError: Cannot read properties of null (reading 'useContext')
 *   Export encountered an error on /_global-error/page, exiting the build.
 *
 * That failed only on the VPS, because the deploy script set the variable while
 * a local `npm run build` left it unset.
 *
 * `NEXT_TELEMETRY_DISABLED` keeps the build from phoning home from the VPS.
 */
export function releaseEnv() {
  return { NODE_ENV: 'production', NEXT_TELEMETRY_DISABLED: '1' };
}

function run(command, args, cwd, capture = false) {
  try {
    return execFileSync(command, args, {
      cwd,
      encoding: 'utf8',
      stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
      env: { ...process.env, ...releaseEnv() },
      timeout: 30 * 60 * 1000,
    });
  } catch (error) {
    throw new Error(
      `Command failed: ${command} (exit ${error.status ?? 'unknown'}); consult protected service logs`,
      { cause: error },
    );
  }
}

/** Ecosystem file a release is started from. */
export const ECOSYSTEM = 'infrastructure/pm2/ecosystem.config.js';

/** Builds a PM2 caller bound to `cwd`, for injection into `switchRelease`. */
export function pm2Runner(cwd = ROOT) {
  return (...args) => run('pm2', args, cwd, true);
}

/**
 * Pre-flight audit of the processes this deployment is about to take over.
 *
 * Deployment may only replace processes that already run from a release
 * directory under our own root. A managed name pointing anywhere else is an
 * unmanaged process wearing our name, and replacing it would silently destroy
 * something the audit never looked at.
 *
 * Unrelated processes are ignored by design — the audit is about our own four.
 */
export function assertManagedProcessesAuditable(processes, releases = RELEASES) {
  // Normalise before appending the separator. `${releases}/` on its own yields
  // `//` whenever the root already ends in a slash — including when it is the
  // filesystem root — and nothing starts with `//`, so every managed process
  // would be rejected as unauditable and the deployment would abort on a
  // perfectly healthy PM2 state. Trailing slashes are stripped so the check is
  // idempotent and does not depend on the caller formatting the path.
  const prefix = `${String(releases).replace(/\\/g, '/').replace(/\/+$/, '')}/`;
  for (const entry of managedProcesses(processes)) {
    if (!entry.pm2_env?.pm_cwd?.replace(/\\/g, '/').startsWith(prefix)) {
      throw new Error(`Audit and migrate the existing process before cutover: ${entry.name}`);
    }
  }
}

/**
 * Switches the four managed processes onto `release`.
 *
 * Why this replaces `pm2 startOrReload`:
 *
 * `startOrReload` finds an existing process by name and issues a *reload*.
 * A reload restarts the script PM2 registered when that process was first
 * started, and PM2 carries the `cwd` and `pm_exec_path` captured at that moment
 * forward into the restarted process. With a release layout — where every
 * process's `cwd` is a different absolute path per release — the switch
 * therefore completes, every process reports `online`, and `pm2 jlist` still
 * shows the *previous* release's directory. `validateProcesses` then rejects a
 * build that is perfectly healthy, and automatic rollback restarts a release
 * that was never at fault.
 *
 * Switching is made explicit instead. The managed processes are deleted and
 * started again, so `cwd`, `script`, `args` and `APP_VERSION` are all read from
 * the ecosystem belonging to the release being activated. Nothing else changes
 * shape.
 *
 * Two independent guards keep this inside its boundary:
 *
 *  - every deletion is named, built from `managedProcesses()`, so an unrelated
 *    process on the shared daemon can never be deleted — not by a broad PM2
 *    subcommand and not by a name typo reaching `delete`;
 *  - the start is scoped with `--only` to the same four names, so the switch
 *    cannot adopt or disturb anything else even if the ecosystem later grows an
 *    entry that is not ours.
 *
 * `previous` is switched exactly the same way during rollback, so a rollback
 * also produces processes that genuinely run from the baseline release rather
 * than inheriting the failed release's paths.
 *
 * @param release Absolute release directory to switch to.
 * @param pm2 Injected PM2 caller, so the command sequence is testable without
 *   a PM2 daemon. Returns raw stdout, like `execFileSync`.
 * @returns `deleted` names and `alreadyStale` names — the subset that was still
 *   pointing at a different release. Non-empty on a first switch and non-empty
 *   again after a deployment that was rolled back, which is the signature of the
 *   `startOrReload` defect this replaces.
 */
export async function switchRelease(release, pm2) {
  const processes = JSON.parse(pm2('jlist'));
  const managed = managedProcesses(processes);
  const alreadyStale = staleManagedProcesses(processes, release).map((entry) => entry.name);
  if (managed.length > 0) {
    pm2('delete', ...managed.map((entry) => entry.name));
  }
  pm2('start', join(release, ECOSYSTEM), '--only', PROCESS_NAMES.join(','), '--update-env');
  return { deleted: managed.map((entry) => entry.name), alreadyStale };
}

/** Directories under `prisma/migrations` that are migration folders. */
function migrationDirectories(directory) {
  return readdirSync(join(directory, 'packages/database/prisma/migrations'), {
    withFileTypes: true,
  })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
}

/**
 * Gate that permits reviewed migrations and blocks everything else.
 *
 * This replaces a blanket "no models, no migrations" rule, which became
 * impossible to keep once the tenancy schema landed. The safety property is
 * preserved rather than dropped: a migration reaches production only after a
 * human has listed it in `infrastructure/migrations-reviewed.json`, and that
 * file is where the review of its SQL, backward compatibility, rollback and
 * execution plan is recorded.
 *
 * Both directions are checked. An unreviewed migration blocks the deploy, and
 * so does an entry that claims a migration the tree does not contain, because
 * that means the manifest and the schema have drifted apart.
 */
export function assertReviewedMigrations(directory, reviewed = readReviewedMigrations(directory)) {
  const present = migrationDirectories(directory);
  const missing = present.filter((name) => !reviewed.includes(name));
  if (missing.length > 0) {
    throw new Error(
      `Unreviewed migration(s) present: ${missing.join(', ')}. ` +
        'Review the SQL, backward compatibility, rollback and execution plan, then add the ' +
        'migration name to infrastructure/migrations-reviewed.json before deploying.',
    );
  }
  const absent = reviewed.filter((name) => !present.includes(name));
  if (absent.length > 0) {
    throw new Error(
      `Reviewed migration(s) listed but absent from this tree: ${absent.join(', ')}. ` +
        'infrastructure/migrations-reviewed.json and prisma/migrations have drifted apart.',
    );
  }
}

/** Reads the reviewed-migration manifest from the release being deployed. */
export function readReviewedMigrations(directory) {
  const manifest = JSON.parse(
    readFileSync(join(directory, 'infrastructure/migrations-reviewed.json'), 'utf8'),
  );
  if (
    !Array.isArray(manifest.migrations) ||
    manifest.migrations.some((n) => typeof n !== 'string')
  ) {
    throw new Error(
      'infrastructure/migrations-reviewed.json must list a "migrations" string array',
    );
  }
  return manifest.migrations;
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
  // Checked before the first activation attempt, and therefore before the
  // release can serve traffic. A release that cannot read its environment
  // would otherwise crash-loop the API and worker. ROOT is the application root
  // that holds the shared environment file, matching where the release symlink
  // was created.
  assertReleaseEnvAccessible(release, join(ROOT, '.env'));
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
  const managed = managedProcesses(processes);
  if (!previous && managed.length) {
    throw new Error(
      'Existing PM2 deployment needs a verified baseline release before first cutover; see runbook',
    );
  }
  assertManagedProcessesAuditable(processes);
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
    assertReviewedMigrations(staging);
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
  assertReviewedMigrations(release);
  await activate({
    release,
    previous,
    // Restart is a genuine switch, not a reload. Rollback re-enters this same
    // function with `previous`, so the baseline is started from its own
    // ecosystem rather than inheriting the failed release's process paths.
    restart: (directory) => switchRelease(directory, pm2Runner(directory)),
    check: (directory) => verify(directory, config),
    switchLink: (directory) => {
      writeFileSync(join(directory, 'READY'), readFileSync(join(directory, 'REVISION')), {
        mode: 0o640,
      });
      switchCurrent(directory);
    },
    save: () => run('pm2', ['save'], ROOT),
    stopNew: () => {
      // Named deletes only. `pm2 delete all` would also remove unrelated
      // processes on the shared deployment-account daemon.
      const started = managedProcesses(JSON.parse(run('pm2', ['jlist'], ROOT, true)));
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
