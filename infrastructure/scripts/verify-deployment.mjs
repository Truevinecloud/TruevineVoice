import { accessSync, constants, lstatSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const PROCESS_NAMES = ['truevine-web', 'truevine-admin', 'truevine-api', 'truevine-worker'];

/** Application directory a managed process runs from inside `release`. */
export function appDirectory(name) {
  return name.slice('truevine-'.length);
}

/**
 * Working directory PM2 must report for `name` once it runs `release`.
 *
 * Single source of truth for the release path shape. `validateProcesses` and
 * the release switch both derive it here, so they cannot disagree about which
 * directory a process is supposed to be in.
 *
 * PM2 reports POSIX paths, so separators are normalised. Without this the
 * comparison is correct on the VPS and wrong in a Windows test run, which is
 * exactly the kind of platform-only failure this module exists to prevent.
 */
export function expectedCwd(name, release) {
  return `${String(release).replace(/\\/g, '/')}/apps/${appDirectory(name)}`;
}

/**
 * Selects only the four processes this deployment owns.
 *
 * The deployment account's PM2 daemon is shared. Anything else running under it
 * — an operator's ad-hoc script, a monitoring agent — is not ours to delete,
 * reload or restart. Every command in the switch and cleanup paths filters
 * through here first, so an unrelated process cannot be reached by name
 * accident or by a broad PM2 subcommand.
 */
export function managedProcesses(processes) {
  return processes.filter((entry) => PROCESS_NAMES.includes(entry.name));
}

/**
 * Managed processes that are not running from `release`.
 *
 * The failure this detects is silent from PM2's side: a reload restarts the
 * script PM2 registered first, so a release switch can leave every process
 * reporting the previous release's directory while appearing perfectly online.
 */
export function staleManagedProcesses(processes, release) {
  return managedProcesses(processes).filter(
    (entry) => entry.pm2_env?.pm_cwd !== expectedCwd(entry.name, release),
  );
}

export function assertCiJobs(jobs) {
  for (const name of [
    'Lint, typecheck and Prisma validation',
    'Unit tests',
    'End-to-end tests',
    'Production build',
  ]) {
    const matches = jobs.filter((job) => job.name === name);
    if (matches.length !== 1 || matches[0].conclusion !== 'success') {
      throw new Error(`Missing successful CI gate: ${name}`);
    }
  }
}

/**
 * Selects the CI run a manually-triggered deployment is allowed to trust.
 *
 * An automatic deployment receives its CI run id from the `workflow_run` event.
 * A manual `workflow_dispatch` has no such event, so the run is resolved from
 * the commit the operator selected instead. Not every run counts. Only a
 * completed, successful `push` run from this same repository may authorise a
 * production release:
 *
 *  - a `pull_request` run tests a merge result, not the commit being deployed;
 *  - a fork's run is not ours to trust;
 *  - a failed or unfinished run has not proven the commit.
 *
 * The runs API returns newest first, so the first match is the run to use.
 * Throwing, rather than returning `undefined`, keeps the caller from querying
 * the jobs of an empty id and failing with a confusing GitHub error instead of
 * naming the real problem.
 *
 * @param runs Parsed `workflow_runs` array from the Actions runs API.
 * @param repository `owner/name` of the only repository whose runs count.
 * @returns The id of the matching run.
 */
export function selectSuccessfulCiRun(runs, repository) {
  const run = runs.find(
    (candidate) =>
      candidate.event === 'push' &&
      candidate.status === 'completed' &&
      candidate.conclusion === 'success' &&
      candidate.head_repository?.full_name === repository,
  );
  if (!run) {
    throw new Error(`No completed successful CI push run found for repository ${repository}`);
  }
  return run.id;
}

/**
 * Fails safely when a release cannot read the environment it needs.
 *
 * The API and worker call `loadEnvFiles()`, which walks up from the working
 * directory looking for `.env`, and then `requireEnv()` fails the boot if
 * `DATABASE_URL` or `REDIS_URL` is absent. Nothing in the repository previously
 * checked that the link exists before activation, so a missing or unreadable
 * environment file only surfaced as a crash loop after a release was live.
 *
 * Checks, in order, and never reads or logs any value:
 *
 *  1. `release/.env` exists (as a link or a regular file);
 *  2. it resolves, which rejects a dangling symlink;
 *  3. it resolves to the shared application-root environment file, so a release
 *     cannot quietly carry a different or stale environment;
 *  4. the deployment account can actually read it.
 *
 * The `release` argument is the directory being verified, passed by the caller.
 * It is deliberately not derived from `process.cwd()` or from the shared file,
 * because checking the wrong release is the failure this exists to prevent.
 *
 * @param release Absolute path of the release directory under verification.
 * @param expected Absolute path the release `.env` must resolve to.
 * @throws Error describing the first failed condition. Messages contain paths
 *   and permission bits only, never contents.
 */
export function assertReleaseEnvAccessible(release, expected) {
  const releaseEnv = resolve(release, '.env');

  try {
    lstatSync(releaseEnv);
  } catch {
    throw new Error('Release has no .env; it cannot load required configuration');
  }

  let resolvedEnv;
  try {
    resolvedEnv = realpathSync(releaseEnv);
  } catch {
    throw new Error('Release .env does not resolve; it is a broken symlink');
  }

  let resolvedExpected;
  try {
    resolvedExpected = realpathSync(expected);
  } catch {
    throw new Error('Shared environment file is missing; deployment cannot be verified');
  }

  if (resolvedEnv !== resolvedExpected) {
    throw new Error('Release .env does not resolve to the shared application environment file');
  }

  try {
    accessSync(releaseEnv, constants.R_OK);
  } catch {
    // Read the mode from the resolved target, not the link. `lstatSync` does
    // not follow symlinks and would report the link's own 0777, which is
    // useless for diagnosing a permissions problem.
    //
    // Padded to three digits: `toString(8)` renders mode 000 as "0", and a
    // permissions diagnostic that reads "mode 0" instead of "mode 000" is
    // actively misleading to whoever has to fix it.
    const mode = (statSync(resolvedEnv).mode & 0o777).toString(8).padStart(3, '0');
    throw new Error(`Release .env is not readable by the deployment account (mode ${mode})`);
  }
}

export function validateConfig(config) {
  if (config.webUrl !== 'https://voice.truevinecloud.online/') {
    throw new Error('webUrl must be the agreed customer production URL');
  }
  for (const value of [config.webUrl, config.apiHealthUrl, config.adminUrl].filter(Boolean)) {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || url.hash) {
      throw new Error('Public checks require HTTPS URLs without credentials or fragments');
    }
  }
  if (!config.apiHealthUrl) throw new Error('Confirm the existing API route and set apiHealthUrl');
  if (!['internal', 'public'].includes(config.adminAccess)) throw new Error('Confirm adminAccess');
  if ((config.adminAccess === 'public') !== Boolean(config.adminUrl)) {
    throw new Error('Public admin requires adminUrl; internal admin must have no public URL');
  }
  if (
    !Number.isInteger(config.apiPort) ||
    config.apiPort < 1024 ||
    config.apiPort > 65535 ||
    [3000, 3002].includes(config.apiPort)
  )
    throw new Error('Invalid API port');
  return config;
}

export function validateProcesses(processes, release, sha, now = Date.now()) {
  for (const name of PROCESS_NAMES) {
    const matches = processes.filter((entry) => entry.name === name);
    if (matches.length !== 1) throw new Error(`Expected exactly one PM2 process: ${name}`);
    const env = matches[0].pm2_env;
    const cwd = env.pm_cwd;
    const wanted = expectedCwd(name, release);
    if (cwd !== wanted) {
      // Reported separately from the generic stability failure because the
      // operator action is completely different. A process pointing at another
      // release is a failed switch, not an unhealthy application: the release
      // that is actually serving traffic is fine and must not be rolled back
      // for this. Naming both paths is what tells the two apart under pressure.
      throw new Error(
        `PM2 process did not switch to the release under verification: ${name} ` +
          `runs from ${cwd ?? 'an unknown directory'}, expected ${wanted}`,
      );
    }
    if (
      env.status !== 'online' ||
      env.APP_VERSION !== sha ||
      !Number.isFinite(env.pm_uptime) ||
      now - env.pm_uptime < 10000
    ) {
      throw new Error(`PM2 process is not stable on the expected release: ${name}`);
    }
  }
}

export async function checkHttp(url, kind, sha, fetcher = fetch) {
  const response = await fetcher(url, { redirect: 'error', signal: AbortSignal.timeout(8000) });
  if (response.status !== 200) throw new Error(`${kind} HTTP check returned ${response.status}`);
  if (kind === 'api') {
    const body = await response.json();
    if (
      body.status !== 'ok' ||
      body.service !== 'truevine-voice-api' ||
      body.version !== sha ||
      body.environment !== 'production' ||
      body.dependencies?.postgres?.status !== 'up' ||
      body.dependencies?.redis?.status !== 'up'
    )
      throw new Error('API release/dependency check failed');
  } else if (kind === 'proxy') {
    const body = await response.json();
    if (
      typeof body?.version !== 'string' ||
      body.version.length === 0 ||
      typeof body.url !== 'string'
    )
      throw new Error('Terms proxy response check failed');
  } else {
    const body = await response.text();
    // Markers prove Nginx is serving THIS release's own page rather than a
    // default site or a stale release. They are updated deliberately whenever
    // the foundation page copy changes, in the same commit as that change.
    const markers =
      kind === 'web'
        ? [
            'Truevine Voice',
            // Distinctive marketing homepage copy (TV-WEB-001).
            'Reach thousands with',
            'automated voice calls',
            // The honest scope statement. The platform is in development and
            // the carrier/AI capabilities are product plans; the calling
            // product is not live. Removing this would let a page claiming
            // calling works in production pass the gate.
            'is in development',
            'product plans',
          ]
        : // This is the current Operations Dashboard, rendered before sign-in.
          // These markers identify its actual server-rendered screen rather than a
          // retired foundation placeholder that disappeared when Operations Admin shipped.
          ['Truevine Voice', 'Operations', 'Platform sign in'];
    if (!markers.every((marker) => body.includes(marker)))
      throw new Error(`${kind} foundation page check failed`);
  }
}

/**
 * @param release Optional release directory. When given, the environment
 *   accessibility check runs against it. Callers that know which release they
 *   are verifying should always pass it.
 */
export async function verifyHttp(
  config,
  sha,
  fetcher = fetch,
  release = undefined,
  sharedEnv = undefined,
) {
  validateConfig(config);
  if (release !== undefined)
    assertReleaseEnvAccessible(release, sharedEnv ?? resolve(release, '../.env'));
  const checks = [
    ['http://127.0.0.1:3000/', 'web'],
    ['http://127.0.0.1:3002/admin', 'admin'],
    [`http://127.0.0.1:${config.apiPort}/health`, 'api'],
    [config.webUrl, 'web'],
    [config.apiHealthUrl, 'api'],
    [new URL('api/auth/terms', config.webUrl).href, 'proxy'],
  ];
  if (config.adminUrl) checks.push([config.adminUrl, 'admin']);
  await Promise.all(checks.map(([url, kind]) => checkHttp(url, kind, sha, fetcher)));
}

/**
 * Runs the command-line entry point.
 *
 * Both the release directory and the shared environment file are **required**
 * and are never inferred. An earlier version defaulted them to `process.cwd()`
 * and `../.env`, which meant that running the verifier from a temporary
 * directory validated the temporary directory instead of the release under
 * verification — precisely the failure `assertReleaseEnvAccessible` exists to
 * prevent. Guessing a path from the working directory is never safe here.
 *
 * @returns Resolved absolute paths, for tests.
 */
export function parseVerifierArguments(argv) {
  const [configPath, sha, releaseDir, sharedEnvDir] = argv;
  if (!configPath) throw new Error('Missing CONFIG path');
  if (!/^[a-f0-9]{40}$/.test(sha ?? ''))
    throw new Error('Missing or invalid SHA: expected 40 lowercase hex characters');
  if (!releaseDir) throw new Error('Missing RELEASE_DIR; it is never inferred from the cwd');
  if (!sharedEnvDir) throw new Error('Missing SHARED_ENV path; it is never inferred');
  return {
    config: resolve(configPath),
    sha,
    release: resolve(releaseDir),
    sharedEnv: resolve(sharedEnvDir),
  };
}

/**
 * Read-only confirmation that the four managed processes run from `release`.
 *
 * Separate from `checkHttp` because it needs PM2, and therefore only makes
 * sense on the server. Baseline verification requires BOTH:
 *
 *  - this module's `verifyHttp`, for the HTTP surface, release version and
 *    dependency health;
 *  - `deploy.mjs`'s `validateProcesses`, for process ownership and working
 *    directory, which the CLI entry point cannot perform.
 *
 * `deploy.mjs` performs both automatically. Anything verifying a baseline by
 * hand must run both.
 *
 * @param processes Parsed `pm2 jlist` output.
 * @param release Absolute release directory the processes must run from.
 * @param sha Full commit SHA the processes must report.
 * @param now Injectable clock for the stability window.
 */
export function assertProcessesRunRelease(processes, release, sha, now = Date.now()) {
  validateProcesses(processes, release, sha, now);
  return PROCESS_NAMES.length;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = parseVerifierArguments(process.argv.slice(2));
  assertReleaseEnvAccessible(args.release, args.sharedEnv);
  await verifyHttp(JSON.parse(readFileSync(args.config, 'utf8')), args.sha);
  process.stdout.write(`HTTP verification passed for ${args.sha}\n`);
  process.stdout.write(
    'Note: HTTP only. Confirm processes run from this release with ' +
      'deploy.mjs validateProcesses, or npm run deploy:verify -- CONFIG SHA RELEASE_DIR SHARED_ENV ' +
      'plus a separate process check.\n',
  );
}
