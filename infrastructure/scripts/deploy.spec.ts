import { afterAll, describe, expect, it, vi } from 'vitest';
import {
  chmodSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  activate,
  migrateReviewedRelease,
  assertReviewedMigrations,
  assertManagedProcessesAuditable,
  ECOSYSTEM,
  releaseEnv,
  switchRelease,
} from './deploy.mjs';
import {
  assertCiJobs,
  assertProcessesRunRelease,
  assertReleaseEnvAccessible,
  checkHttp,
  expectedCwd,
  managedProcesses,
  parseVerifierArguments,
  PROCESS_NAMES,
  selectSuccessfulCiRun,
  staleManagedProcesses,
  validateConfig,
  validateProcesses,
  verifyHttp,
} from './verify-deployment.mjs';

const sha = 'a'.repeat(40);
const deploymentWorkflow = readFileSync(
  resolve(process.cwd(), '.github/workflows/deploy.yml'),
  'utf8',
);
const requiredJobs = [
  'Lint, typecheck and Prisma validation',
  'Unit tests',
  'End-to-end tests',
  'Production build',
].map((name) => ({ name, conclusion: 'success' }));

describe('deployment CI gates', () => {
  it('accepts all four successful gates', () => {
    expect(() => assertCiJobs(requiredJobs)).not.toThrow();
  });
  it.each(requiredJobs)('rejects missing, failed, skipped or duplicate $name', (job) => {
    const others = requiredJobs.filter((entry) => entry.name !== job.name);
    expect(() => assertCiJobs(others)).toThrow(job.name);
    for (const conclusion of ['failure', 'cancelled', 'skipped', null]) {
      expect(() => assertCiJobs([...others, { ...job, conclusion }])).toThrow(job.name);
    }
    expect(() => assertCiJobs([...requiredJobs, job])).toThrow(job.name);
  });
});

describe('production deployment approval gate', () => {
  it('cannot start automatically after a main push or CI completion', () => {
    expect(deploymentWorkflow).not.toMatch(/^\s+workflow_run:/m);
    expect(deploymentWorkflow).not.toMatch(/^\s+push:/m);
    expect(deploymentWorkflow).toMatch(/workflow_dispatch:\s*\n\s+inputs:/);
  });

  it('requires an explicit false-by-default production authorization input', () => {
    expect(deploymentWorkflow).toMatch(
      /authorize_production:[\s\S]*?required:\s*true[\s\S]*?type:\s*boolean[\s\S]*?default:\s*false/,
    );
    expect(deploymentWorkflow).toMatch(/inputs\.authorize_production\s*==\s*true/);
    expect(deploymentWorkflow).toMatch(/environment:\s*production/);
  });
});

describe('manual deployment CI run selection', () => {
  const repository = 'Truevinecloud/TruevineVoice';
  const successfulPush = {
    id: 38997192229,
    event: 'push',
    status: 'completed',
    conclusion: 'success',
    head_repository: { full_name: repository },
  };

  it('selects the completed successful push run for this repository', () => {
    expect(selectSuccessfulCiRun([successfulPush], repository)).toBe(successfulPush.id);
  });

  it('returns the newest matching run', () => {
    // The runs API returns newest first, so a newer match must win.
    const runs = [
      { ...successfulPush, id: 2 },
      { ...successfulPush, id: 1 },
    ];
    expect(selectSuccessfulCiRun(runs, repository)).toBe(2);
  });

  it.each([
    { label: 'a pull request run', patch: { event: 'pull_request' } },
    { label: 'a fork run', patch: { head_repository: { full_name: 'someone/fork' } } },
    { label: 'a failed run', patch: { conclusion: 'failure' } },
    { label: 'a cancelled run', patch: { conclusion: 'cancelled' } },
    { label: 'an unfinished run', patch: { status: 'in_progress', conclusion: null } },
    { label: 'a run with no repository', patch: { head_repository: undefined } },
  ])('refuses to authorise a deployment from $label', ({ patch }) => {
    expect(() => selectSuccessfulCiRun([{ ...successfulPush, ...patch }], repository)).toThrow(
      'No completed successful CI push run found',
    );
  });

  it('refuses to authorise a deployment when there are no runs at all', () => {
    expect(() => selectSuccessfulCiRun([], repository)).toThrow(
      'No completed successful CI push run found',
    );
  });
});
const config = {
  webUrl: 'https://voice.truevinecloud.online/',
  apiHealthUrl: 'https://example.test/api/health',
  adminAccess: 'internal',
  adminUrl: null,
  apiPort: 3001,
};
const TERMS_URL = 'https://voice.truevinecloud.online/api/auth/terms';
const healthy = {
  status: 'ok',
  service: 'truevine-voice-api',
  version: sha,
  environment: 'production',
  dependencies: { postgres: { status: 'up' }, redis: { status: 'up' } },
};

/**
 * Operations Admin page as React renders it before authentication.
 *
 * The platform screen is public at the HTML layer so operators can sign in;
 * authorization is enforced by the API. Keep this fixture aligned with the
 * implemented dashboard instead of the retired foundation placeholder.
 */
const SSR_ADMIN_BODY =
  '<html><head><title>Truevine Voice - Admin</title></head><body>' +
  '<main class="operations-shell"><header><h1>Operations</h1></header>' +
  '<p role="status">Checking platform access…</p>' +
  '<form><h2>Platform sign in</h2></form></main></body></html>';

const SSR_WEB_BODY =
  '<div class="mk-page"><header class="mk-header"><a class="mk-brand">' +
  'Truevine <span class="mk-brand-voice">Voice</span></a></header>' +
  '<main class="mk-main"><h1 id="mk-hero-heading">Reach thousands with ' +
  '<span class="mk-gold">automated voice calls</span>.</h1>' +
  '<p>Illustrative sample data - not real customer figures.</p></main>' +
  '<footer class="mk-footer"><p>Truevine Voice<!-- --> is in development. ' +
  'Carrier integrations and AI capabilities are product plans.</p>' +
  '</footer></div>';

function response(kind = 'api', body = healthy, status = 200) {
  return {
    status,
    json: async () => body,
    text: async () => (kind === 'web' ? SSR_WEB_BODY : SSR_ADMIN_BODY),
  };
}

const TERMS_BODY = { version: '2026-10-01', url: '' };

function routeResponse(url: string) {
  if (url.endsWith('/api/auth/terms')) return response('proxy', TERMS_BODY);
  if (url.includes('health')) return response('api');
  if (url.includes('3002') || url.includes('operators')) return response('admin');
  return response('web');
}

describe('release command environment', () => {
  it('builds with NODE_ENV=production, not development', () => {
    // Regression: `development` made `next build` prerender `/_global-error`
    // with the development React renderer and fail on
    // `Cannot read properties of null (reading 'useContext')` on the VPS only.
    expect(releaseEnv().NODE_ENV).toBe('production');
  });
  it('disables Next.js telemetry so the VPS build does not phone home', () => {
    expect(releaseEnv().NEXT_TELEMETRY_DISABLED).toBe('1');
  });
});

describe('release environment accessibility', () => {
  /**
   * Builds a throwaway application root containing one release.
   *
   * Nothing here reads or asserts on the contents of the environment file. A
   * placeholder is written only because the checks under test care about
   * existence, link resolution and permission bits, never values.
   */
  function fixture() {
    const root = mkdtempSync(join(tmpdir(), 'truevine-env-'));
    const release = join(root, 'releases', 'abc123-baseline');
    mkdirSync(release, { recursive: true });
    const shared = join(root, '.env');
    writeFileSync(shared, 'DATABASE_URL=placeholder\nREDIS_URL=placeholder\n', { mode: 0o640 });
    return { root, release, shared };
  }

  /**
   * `realpath` resolves symlinks, not hard links, so the "resolves to the
   * shared file" contract can only be exercised with a real symlink. Creating
   * one on Windows requires elevation or Developer Mode, and `chmod 000` does
   * not deny the owner access there either.
   *
   * This is a platform capability gate, not a weakened assertion. CI runs
   * Ubuntu and production is Ubuntu, so every case below runs there. The cases
   * that need neither primitive run on every platform.
   */
  const posixOnly = process.platform === 'win32' ? it.skip : it;

  it('rejects a release with no .env at all', () => {
    const { root, release, shared } = fixture();
    try {
      expect(() => assertReleaseEnvAccessible(release, shared)).toThrow('no .env');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('rejects a release .env that is a different file with the same name', () => {
    const { root, release, shared } = fixture();
    try {
      // Present, resolvable, readable, but NOT the shared file.
      writeFileSync(join(release, '.env'), readFileSync(shared));
      expect(() => assertReleaseEnvAccessible(release, shared)).toThrow(
        'does not resolve to the shared',
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('rejects a missing shared environment file', () => {
    const { root, release } = fixture();
    try {
      writeFileSync(join(release, '.env'), 'DATABASE_URL=placeholder\n');
      expect(() => assertReleaseEnvAccessible(release, join(root, 'absent.env'))).toThrow(
        'Shared environment file is missing',
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('checks the release it is given, not a sibling release', () => {
    const { root, release, shared } = fixture();
    try {
      // A healthy release and a broken one side by side. Verifying the broken
      // one must fail even though a healthy release exists in the same root.
      const healthy = join(root, 'releases', 'def456-baseline');
      mkdirSync(healthy, { recursive: true });
      writeFileSync(join(healthy, '.env'), readFileSync(shared));

      expect(() => assertReleaseEnvAccessible(healthy, join(healthy, '.env'))).not.toThrow();
      expect(() => assertReleaseEnvAccessible(release, shared)).toThrow('no .env');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  posixOnly('accepts a release whose .env links to the shared file and is readable', () => {
    const { root, release, shared } = fixture();
    try {
      symlinkSync(shared, join(release, '.env'));
      expect(() => assertReleaseEnvAccessible(release, shared)).not.toThrow();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  posixOnly('rejects a broken symlink', () => {
    const { root, release, shared } = fixture();
    try {
      symlinkSync(join(root, 'does-not-exist'), join(release, '.env'));
      expect(() => assertReleaseEnvAccessible(release, shared)).toThrow('does not resolve');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  posixOnly('rejects a release .env the deployment account cannot read', () => {
    // root bypasses file permission checks, and CI runners are commonly root,
    // so this assertion cannot hold there. Production verification runs as the
    // unprivileged deployment account, which is exactly the case under test.
    if (typeof process.getuid === 'function' && process.getuid() === 0) return;

    const { root, release, shared } = fixture();
    try {
      symlinkSync(shared, join(release, '.env'));
      chmodSync(shared, 0o000);
      let message = '';
      try {
        assertReleaseEnvAccessible(release, shared);
      } catch (error) {
        message = error.message;
      }
      // Reports the permission bits, and never the contents.
      expect(message).toContain('not readable');
      // The mode must be the resolved target's, not the symlink's 0777.
      expect(message).toMatch(/mode 000/);
      expect(message).not.toContain('placeholder');
      expect(message).not.toContain('DATABASE_URL');
    } finally {
      // Restore before cleanup so the temporary file is always removable.
      chmodSync(shared, 0o600);
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('verifier CLI argument handling', () => {
  // Built from tmpdir rather than hardcoded, because `resolve()` is
  // platform-dependent and CI runs Ubuntu while this suite also runs on Windows.
  const appRoot = mkdtempSync(join(tmpdir(), 'truevine-cli-'));
  const release = join(appRoot, 'releases', 'abc123-baseline');
  const shared = join(appRoot, '.env');
  const config = join(appRoot, 'deployment.json');

  afterAll(() => {
    rmSync(appRoot, { recursive: true, force: true });
  });

  it('resolves the explicitly supplied release and shared env paths', () => {
    const args = parseVerifierArguments([config, sha, release, shared]);

    expect(args.release).toBe(resolve(release));
    expect(args.sharedEnv).toBe(resolve(shared));
    expect(args.sha).toBe(sha);
  });

  it('rejects a missing release directory instead of using the cwd', () => {
    // The regression: the previous version defaulted to process.cwd(), so
    // running the verifier from a temporary directory validated that
    // directory rather than the release under verification.
    expect(() => parseVerifierArguments([config, sha])).toThrow('Missing RELEASE_DIR');
  });

  it('rejects a missing shared environment path instead of guessing one', () => {
    expect(() => parseVerifierArguments([config, sha, release])).toThrow('Missing SHARED_ENV');
  });

  it('rejects a missing or malformed SHA', () => {
    expect(() => parseVerifierArguments([config])).toThrow('Missing or invalid SHA');
    expect(() => parseVerifierArguments([config, 'not-a-sha', release, shared])).toThrow(
      'Missing or invalid SHA',
    );
    expect(() => parseVerifierArguments([config, 'A'.repeat(40), release, shared])).toThrow(
      'Missing or invalid SHA',
    );
  });

  it('rejects a missing config path', () => {
    expect(() => parseVerifierArguments([])).toThrow('Missing CONFIG');
  });

  it('resolves relative paths against the cwd rather than accepting them as-is', () => {
    const args = parseVerifierArguments([config, sha, 'rel/release', 'rel/.env']);

    expect(args.release).toBe(resolve('rel/release'));
    expect(args.sharedEnv).toBe(resolve('rel/.env'));
  });

  it('validates the supplied release, not the directory the verifier runs from', () => {
    // A temporary directory stands in for wherever the verifier is invoked from.
    const elsewhere = mkdtempSync(join(tmpdir(), 'truevine-cwd-'));
    const previousCwd = process.cwd();
    try {
      // Deliberately give the invocation directory a valid-looking .env. If
      // the verifier fell back to cwd it would pass, which is the bug.
      writeFileSync(join(elsewhere, '.env'), 'DATABASE_URL=placeholder\n');

      const root = mkdtempSync(join(tmpdir(), 'truevine-env-'));
      const real = join(root, 'releases', 'abc123-baseline');
      mkdirSync(real, { recursive: true });
      const realShared = join(root, '.env');
      writeFileSync(realShared, 'DATABASE_URL=placeholder\n');

      process.chdir(elsewhere);
      const args = parseVerifierArguments([config, sha, real, realShared]);

      // The broken release still fails even though cwd holds a valid .env.
      expect(args.release).toBe(real);
      expect(() => assertReleaseEnvAccessible(args.release, args.sharedEnv)).toThrow('no .env');

      // And a release whose .env is a different file than the shared one fails
      // on the mismatch, rather than passing because cwd happened to be valid.
      writeFileSync(join(real, '.env'), 'DATABASE_URL=placeholder\n');
      expect(() => assertReleaseEnvAccessible(args.release, args.sharedEnv)).toThrow(
        'does not resolve to the shared',
      );
      rmSync(root, { recursive: true, force: true });
    } finally {
      process.chdir(previousCwd);
      rmSync(elsewhere, { recursive: true, force: true });
    }
  });
});

describe('process validation for baseline verification', () => {
  // POSIX-style path built portably: `validateProcesses` compares
  // `pm_cwd` against `${release}/apps/<name>` with a forward slash, so the
  // release must be built the same way on every platform.
  const release = resolve('/srv/releases/abc123-baseline').replace(/\\/g, '/');
  const now = 1_700_000_000_000;

  const stable = (name: string, overrides: Record<string, unknown> = {}) => ({
    name,
    pm2_env: {
      status: 'online',
      APP_VERSION: sha,
      pm_uptime: now - 60_000,
      pm_cwd: `${release}/apps/${name.slice('truevine-'.length)}`,
      ...overrides,
    },
  });

  it('confirms all four processes run from the expected release', () => {
    const processes = PROCESS_NAMES.map((name) => stable(name));

    expect(assertProcessesRunRelease(processes, release, sha, now)).toBe(4);
  });

  it('rejects a process running from a different release, naming both paths', () => {
    const processes = PROCESS_NAMES.map((name) =>
      stable(name, { pm_cwd: '/var/www/TruevineVoice/apps/api' }),
    );

    // The failure this whole change exists to fix: PM2 reported `online` while
    // still pointing at the previous release. The message must say so, because
    // the operator action differs completely â€” a failed switch, not a sick app.
    expect(() => assertProcessesRunRelease(processes, release, sha, now)).toThrow(
      'did not switch to the release under verification',
    );
    expect(() => assertProcessesRunRelease(processes, release, sha, now)).toThrow(
      'truevine-web runs from /var/www/TruevineVoice/apps/api',
    );
    expect(() => assertProcessesRunRelease(processes, release, sha, now)).toThrow(
      `expected ${expectedCwd('truevine-web', release)}`,
    );
  });

  it('reports an unknown working directory rather than a vague failure', () => {
    // A process PM2 cannot place is still a switch failure, not an unhealthy
    // application, and the diagnostic must not print `undefined`.
    const processes = PROCESS_NAMES.map((name) => stable(name, { pm_cwd: undefined }));

    expect(() => assertProcessesRunRelease(processes, release, sha, now)).toThrow(
      'runs from an unknown directory',
    );
  });

  it('rejects a process reporting a different release version', () => {
    const processes = PROCESS_NAMES.map((name, index) =>
      stable(name, index === 0 ? { APP_VERSION: 'b'.repeat(40) } : {}),
    );

    expect(() => assertProcessesRunRelease(processes, release, sha, now)).toThrow(
      'not stable on the expected release',
    );
  });

  it('rejects a missing process', () => {
    const processes = PROCESS_NAMES.slice(1).map((name) => stable(name));

    expect(() => assertProcessesRunRelease(processes, release, sha, now)).toThrow(
      'Expected exactly one PM2 process: truevine-web',
    );
  });

  it('rejects a process that restarted too recently to be considered stable', () => {
    const processes = PROCESS_NAMES.map((name) => stable(name, { pm_uptime: now - 2_000 }));

    expect(() => assertProcessesRunRelease(processes, release, sha, now)).toThrow(
      'not stable on the expected release',
    );
  });
});

describe('deployment HTTP checks', () => {
  it('accepts the expected production API commit and both dependencies', async () => {
    await checkHttp('https://example.test/health', 'api', sha, async () => response());
  });
  it.each([
    { ...healthy, version: 'b'.repeat(40) },
    { ...healthy, environment: 'development' },
    { ...healthy, service: 'another-app' },
    { ...healthy, dependencies: { ...healthy.dependencies, redis: { status: 'down' } } },
    { ...healthy, dependencies: { ...healthy.dependencies, postgres: { status: 'down' } } },
  ])('rejects stale commits, wrong services and unhealthy dependencies', async (body) => {
    await expect(
      checkHttp('https://example.test/health', 'api', sha, async () => response('api', body)),
    ).rejects.toThrow('API release/dependency check failed');
  });
  it('rejects a default Nginx page with status 200', async () => {
    await expect(
      checkHttp('https://example.test/', 'web', sha, async () => ({
        status: 200,
        text: async () => 'Welcome to nginx!',
      })),
    ).rejects.toThrow('foundation');
  });
  it('rejects a web page missing the development-status statement', async () => {
    // Guards the same contract as the admin case below: a page that drops the
    // honest scope statement must not pass, or a page claiming the calling
    // product works in production would deploy unchallenged.
    await expect(
      checkHttp('https://example.test/', 'web', sha, async () => ({
        status: 200,
        text: async () =>
          '<main><h1>Reach thousands with <span>automated voice calls</span>.</h1></main>',
      })),
    ).rejects.toThrow('web foundation page check failed');
  });
  it('accepts the Operations Admin page in its pre-auth SSR state', async () => {
    // This matches the implemented Operations Dashboard rendered before sign-in.
    await expect(
      checkHttp('https://example.test/admin', 'admin', sha, async () => response('admin')),
    ).resolves.toBeUndefined();
  });
  it('still rejects an admin page that is not this application', async () => {
    await expect(
      checkHttp('https://example.test/admin', 'admin', sha, async () => ({
        status: 200,
        text: async () => '<main><h1>Some other admin</h1></main>',
      })),
    ).rejects.toThrow('admin foundation page check failed');
  });
  it('rejects an admin page without the sign-in screen marker', async () => {
    // Guards against someone "fixing" the marker by dropping the checks that
    // prove the page is ours rather than swapping in a weaker single marker.
    await expect(
      checkHttp('https://example.test/admin', 'admin', sha, async () => ({
        status: 200,
        text: async () => '<title>Truevine Voice - Admin</title><main><h1>Operations</h1></main>',
      })),
    ).rejects.toThrow('admin foundation page check failed');
  });
  it('rejects non-200 responses', async () => {
    await expect(
      checkHttp('https://example.test/', 'web', sha, async () => response('web', null, 404)),
    ).rejects.toThrow('404');
  });
  it('checks each application locally and the agreed public routes', async () => {
    const fetcher = vi.fn(async (url) => routeResponse(url));
    await verifyHttp(config, sha, fetcher);
    expect(fetcher.mock.calls.map(([url]) => url)).toEqual([
      'http://127.0.0.1:3000/',
      'http://127.0.0.1:3002/admin',
      'http://127.0.0.1:3001/health',
      config.webUrl,
      config.apiHealthUrl,
      TERMS_URL,
    ]);
    expect(fetcher.mock.calls[0][1].redirect).toBe('error');
  });
  it('verifies a confirmed public admin route', async () => {
    const fetcher = vi.fn(async (url) => routeResponse(url));
    await verifyHttp(
      { ...config, adminAccess: 'public', adminUrl: 'https://operators.example.test/' },
      sha,
      fetcher,
    );
    expect(fetcher.mock.calls.map(([url]) => url)).toContain('https://operators.example.test/');
  });
  it.each(['2026-10-01', '2027-04-01'])(
    'accepts the terms JSON through the customer-facing proxy at version %s',
    async (version) => {
      await expect(
        checkHttp(TERMS_URL, 'proxy', sha, async () => response('proxy', { version, url: '' })),
      ).resolves.toBeUndefined();
    },
  );
  it('rejects HTTP 500 from the customer-facing proxy', async () => {
    await expect(
      checkHttp(TERMS_URL, 'proxy', sha, async () => response('proxy', TERMS_BODY, 500)),
    ).rejects.toThrow('proxy HTTP check returned 500');
  });
  it.each([
    { label: 'an empty version', body: { version: '', url: '' } },
    { label: 'a non-string version', body: { version: 7, url: '' } },
    { label: 'a missing url field', body: { version: 'v1' } },
    { label: 'an error payload', body: { error: { code: 'not_found', message: 'Not found.' } } },
  ])('rejects a 200 carrying $label instead of the terms response', async ({ body }) => {
    await expect(
      checkHttp(TERMS_URL, 'proxy', sha, async () => response('proxy', body)),
    ).rejects.toThrow('Terms proxy response check failed');
  });
  it.each([
    { ...config, webUrl: 'https://wrong.example/' },
    { ...config, apiHealthUrl: null },
    { ...config, apiHealthUrl: 'http://example.test/health' },
    { ...config, apiHealthUrl: 'https://user:secret@example.test/health' },
    { ...config, adminAccess: 'public', adminUrl: null },
    { ...config, adminAccess: 'internal', adminUrl: 'https://example.test/' },
    { ...config, apiPort: 3000 },
  ])('rejects incomplete or unsafe routing configuration', (value) => {
    expect(() => validateConfig(value)).toThrow();
  });
});

describe('PM2 deployment checks', () => {
  const release = '/var/www/TruevineVoice/releases/test';
  const now = Date.now();
  const processes = PROCESS_NAMES.map((name) => ({
    name,
    pm2_env: {
      status: 'online',
      APP_VERSION: sha,
      pm_cwd: `${release}/apps/${name.slice('truevine-'.length)}`,
      pm_uptime: now - 11000,
    },
  }));
  it('requires all four stable processes on the new release', () => {
    expect(() => validateProcesses(processes, release, sha, now)).not.toThrow();
  });
  it('rejects a missing worker', () => {
    expect(() => validateProcesses(processes.slice(0, 3), release, sha, now)).toThrow('worker');
  });
  it('rejects a duplicate process', () => {
    expect(() => validateProcesses([...processes, processes[0]], release, sha, now)).toThrow(
      'exactly one',
    );
  });
  it('rejects a worker crash loop or old release', () => {
    const worker = processes[3];
    for (const patch of [
      { status: 'errored' },
      { pm_uptime: now - 1000 },
      { APP_VERSION: 'old' },
      { pm_uptime: undefined },
    ]) {
      expect(() =>
        validateProcesses(
          [...processes.slice(0, 3), { ...worker, pm2_env: { ...worker.pm2_env, ...patch } }],
          release,
          sha,
          now,
        ),
      ).toThrow('not stable on the expected release: truevine-worker');
    }
  });

  it.each([
    { pm_cwd: '/var/www/other/apps/worker' },
    { pm_cwd: `${release}/apps/api` },
    { pm_cwd: undefined },
  ])('rejects a worker still on the wrong release path (%o)', (patch) => {
    // A worker left on the previous release is the specific regression this
    // branch fixes. It must fail as a switch failure, and never pass on the
    // strength of being `online` with the right APP_VERSION.
    const worker = processes[3];
    expect(() =>
      validateProcesses(
        [...processes.slice(0, 3), { ...worker, pm2_env: { ...worker.pm2_env, ...patch } }],
        release,
        sha,
        now,
      ),
    ).toThrow('did not switch to the release under verification: truevine-worker');
  });
});

describe('activation and rollback', () => {
  function operations() {
    return {
      release: 'new',
      previous: 'old',
      migrate: vi.fn(),
      restart: vi.fn(),
      check: vi.fn(),
      switchLink: vi.fn(),
      save: vi.fn(),
      stopNew: vi.fn(),
    };
  }
  it('completes migration before touching application processes', async () => {
    const ops = operations();
    const order: string[] = [];
    ops.migrate.mockImplementation(async () => {
      order.push('migrate');
    });
    ops.restart.mockImplementation(async () => {
      order.push('restart');
    });
    await activate(ops);
    expect(order).toEqual(['migrate', 'restart']);
    expect(ops.migrate).toHaveBeenCalledExactlyOnceWith('new');
  });
  it.each(['old', null])(
    'preserves the baseline after migration failure (%s)',
    async (previous) => {
      const ops = { ...operations(), previous };
      ops.migrate.mockRejectedValue(new Error('migration failed'));
      await expect(activate(ops)).rejects.toThrow('migration failed');
      for (const action of ['restart', 'check', 'switchLink', 'save', 'stopNew'] as const)
        expect(ops[action]).not.toHaveBeenCalled();
    },
  );
  it('saves only after every verification passes', async () => {
    const order = [];
    const ops = operations();
    ops.check = async () => {
      order.push('check');
    };
    ops.switchLink = () => {
      order.push('switch');
    };
    ops.save = async () => {
      order.push('save');
    };
    await activate(ops);
    expect(order).toEqual(['check', 'switch', 'save']);
  });
  it.each(['restart', 'check', 'save'])(
    'restores the old release after %s fails and still fails deployment',
    async (stage) => {
      const ops = operations();
      ops[stage].mockRejectedValueOnce(new Error('failed')).mockResolvedValue(undefined);
      await expect(activate(ops)).rejects.toThrow('failed');
      expect(ops.restart.mock.calls.at(-1)).toEqual(['old']);
      expect(ops.switchLink.mock.calls.at(-1)).toEqual(['old']);
      expect(ops.stopNew).not.toHaveBeenCalled();
    },
  );
  it('reports rollback failures without claiming recovery', async () => {
    const ops = operations();
    ops.check.mockRejectedValue(new Error('unhealthy'));
    await expect(activate(ops)).rejects.toThrow('Deployment AND rollback failed');
  });
  it('restores the old release when the customer-facing proxy check fails', async () => {
    let proxyBroken = true;
    const fetcher = vi.fn(async (url) => {
      if (proxyBroken && url.endsWith('/api/auth/terms')) {
        proxyBroken = false;
        return { status: 500, json: async () => ({}), text: async () => '' };
      }
      return routeResponse(url);
    });
    const ops = { ...operations(), check: () => verifyHttp(config, sha, fetcher) };
    await expect(activate(ops)).rejects.toThrow('proxy HTTP check returned 500');
    expect(fetcher.mock.calls.some(([url]) => url === TERMS_URL)).toBe(true);
    expect(ops.restart.mock.calls.at(-1)).toEqual(['old']);
    expect(ops.switchLink.mock.calls.at(-1)).toEqual(['old']);
    expect(ops.stopNew).not.toHaveBeenCalled();
  });
  it('stops only newly managed processes on failed initial deployment', async () => {
    const ops = { ...operations(), previous: null };
    ops.check.mockRejectedValueOnce(new Error('unhealthy'));
    await expect(activate(ops)).rejects.toThrow('unhealthy');
    expect(ops.stopNew).toHaveBeenCalledOnce();
  });
});

describe('release switching', () => {
  const now = 1_800_000_000_000;
  const NEW_SHA = 'b'.repeat(40);
  const OLD_SHA = 'c'.repeat(40);
  const UNRELATED = 'operator-scratch-script';

  const created: string[] = [];

  /**
   * A release under a `releases/` root, carrying the `REVISION` the ecosystem
   * reads.
   *
   * The `releases` parent is built explicitly rather than recovered by walking
   * up from `mkdtemp`. Temporary-directory depth is platform-specific â€” two
   * levels under `/tmp`, four under `%LOCALAPPDATA%\Temp` â€” so a walk-up
   * fixture resolves to `/` on the CI runner and to the temp directory on the
   * developer's machine. The same test then asserts two different things and
   * passes on one platform only.
   */
  function fixture(): { root: string; releases: string } {
    const root = mkdtempSync(join(tmpdir(), 'truevine-root-'));
    created.push(root);
    const releases = resolve(join(root, 'releases'));
    mkdirSync(releases, { recursive: true });
    return { root, releases };
  }

  function release(version: string, releases = fixture().releases): string {
    const directory = join(releases, `v-${version}`);
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, 'REVISION'), `${version}\n`);
    return directory;
  }

  afterAll(() => {
    for (const directory of created) rmSync(directory, { recursive: true, force: true });
  });

  /**
   * In-memory PM2 daemon, faithful to the behaviour that caused the failure.
   *
   * The important detail is `startOrReload`: for a name that already exists,
   * PM2 restarts the script it registered the first time and carries the
   * captured `pm_cwd` into the restarted process, while `--update-env` does
   * still refresh the environment. That combination is the whole defect â€” the
   * process comes back `online` and carrying the new `APP_VERSION`, while its
   * working directory silently remains the previous release's.
   *
   * A plain `delete` + `start` instead re-reads the ecosystem, so the working
   * directory is rebuilt from the release it was started from.
   *
   * Entries mirror real `pm2 jlist` output, with the process state nested under
   * `pm2_env`. That nesting is not cosmetic: a flat shape makes every path
   * check in this file pass or fail for reasons unrelated to the switch.
   */
  function daemon(running: Record<string, string> = {}) {
    interface Fake {
      name: string;
      pm2_env: {
        pm_cwd: string;
        APP_VERSION: string;
        status: string;
        pm_uptime: number;
      };
    }
    const state = new Map<string, Fake>();
    const calls: string[][] = [];
    for (const [name, cwd] of Object.entries(running)) {
      state.set(name, {
        name,
        pm2_env: {
          pm_cwd: cwd,
          APP_VERSION: OLD_SHA,
          status: 'online',
          pm_uptime: now - 60_000,
        },
      });
    }
    const pm2 = (...args: string[]): string => {
      calls.push(args);
      const [subcommand, ...rest] = args;
      if (subcommand === 'jlist') return JSON.stringify([...state.values()]);
      if (subcommand === 'delete') {
        for (const name of rest) state.delete(name);
        return '';
      }
      if (subcommand !== 'start' && subcommand !== 'startOrReload') {
        throw new Error(`fake daemon received an unexpected subcommand: ${subcommand}`);
      }
      const releaseDirectory = resolve(rest[0], '..', '..', '..');
      const version = readFileSync(join(releaseDirectory, 'REVISION'), 'utf8').trim();
      const onlyIndex = rest.indexOf('--only');
      const scope =
        onlyIndex === -1
          ? [...state.keys()]
          : (rest[onlyIndex + 1] ?? '').split(',').filter(Boolean);
      for (const name of scope) {
        const existing = state.get(name);
        if (subcommand === 'startOrReload' && existing) {
          // Reload in place: environment refreshed, captured cwd preserved.
          existing.pm2_env.APP_VERSION = version;
          existing.pm2_env.pm_uptime = now - 60_000;
          continue;
        }
        state.set(name, {
          name,
          pm2_env: {
            pm_cwd: expectedCwd(name, releaseDirectory),
            APP_VERSION: version,
            status: 'online',
            pm_uptime: now - 60_000,
          },
        });
      }
      return '';
    };
    return { pm2, state, calls, jlist: () => JSON.parse(pm2('jlist')) as Fake[] };
  }

  /** The four processes as they sit on `directory` before a switch. */
  function runningOn(directory: string) {
    return Object.fromEntries(PROCESS_NAMES.map((name) => [name, expectedCwd(name, directory)]));
  }

  describe('the defect being fixed', () => {
    it('shows a startOrReload switch leaving every process on the old release', () => {
      const previous = release(OLD_SHA);
      const next = release(NEW_SHA);
      const fake = daemon(runningOn(previous));

      fake.pm2('startOrReload', join(next, ECOSYSTEM), '--update-env');

      const processes = fake.jlist();
      // Healthy on every axis PM2 reports: online, new version, recently
      // restarted. Nothing looks wrong, which is why this failed in production.
      for (const entry of processes) {
        expect(entry.pm2_env.status).toBe('online');
        expect(entry.pm2_env.APP_VERSION).toBe(NEW_SHA);
      }
      // Four processes, none of which switched.
      expect(staleManagedProcesses(processes, next)).toHaveLength(4);
      expect(() => validateProcesses(processes, next, NEW_SHA, now)).toThrow(
        'did not switch to the release under verification: truevine-web',
      );
    });

    it('switchRelease puts every managed process on the new release', async () => {
      const previous = release(OLD_SHA);
      const next = release(NEW_SHA);
      const fake = daemon(runningOn(previous));

      await switchRelease(next, fake.pm2);

      expect(staleManagedProcesses(fake.jlist(), next)).toEqual([]);
      expect(() => validateProcesses(fake.jlist(), next, NEW_SHA, now)).not.toThrow();
    });

    it('deletes only the managed processes that already exist', async () => {
      const previous = release(OLD_SHA);
      const next = release(NEW_SHA);
      // Only two of the four ever started; the other two never came up.
      const half = { ...runningOn(previous) };
      for (const name of ['truevine-web', 'truevine-admin']) delete half[name];
      const fake = daemon(half);

      const result = await switchRelease(next, fake.pm2);

      // Only the two survivors were deleted, and both were still on the old
      // release, which is what `alreadyStale` reports.
      expect(result.deleted).toEqual(['truevine-api', 'truevine-worker']);
      expect(result.alreadyStale).toEqual(['truevine-api', 'truevine-worker']);
      // And all four are correct afterwards, including the two that were absent.
      expect(staleManagedProcesses(fake.jlist(), next)).toEqual([]);
    });
  });

  describe('unrelated process protection', () => {
    it('never deletes a process this deployment does not own', async () => {
      const previous = release(OLD_SHA);
      const next = release(NEW_SHA);
      const foreignPath = '/home/truevine-deploy/scratch/checkout.mjs';
      const fake = daemon({ ...runningOn(previous), [UNRELATED]: foreignPath });

      await switchRelease(next, fake.pm2);

      // Still there, still running from where it was.
      expect(fake.state.get(UNRELATED)).toMatchObject({
        pm2_env: { pm_cwd: foreignPath, status: 'online' },
      });
      // And the name never reached a destructive subcommand.
      const flat = fake.calls.flat();
      expect(flat).not.toContain(UNRELATED);
      expect(flat).not.toContain('all');
    });

    it('ignores an unrelated process when deciding what to delete or audit', () => {
      const foreign = { name: UNRELATED, pm2_env: { pm_cwd: '/tmp/anything' } };

      expect(managedProcesses([foreign])).toEqual([]);
      expect(staleManagedProcesses([foreign], '/var/www/TruevineVoice/releases/x')).toEqual([]);
      // It must not block a switch either.
      expect(() =>
        assertManagedProcessesAuditable([foreign], '/var/www/TruevineVoice/releases'),
      ).not.toThrow();
    });

    it('scopes the start to the four managed names', async () => {
      const next = release(NEW_SHA);
      const fake = daemon({ [UNRELATED]: '/home/truevine-deploy/scratch/checkout.mjs' });

      await switchRelease(next, fake.pm2);

      const start = fake.calls.find(([subcommand]) => subcommand === 'start')!;
      expect(start).toContain('--only');
      expect(start[1]).toBe(join(next, ECOSYSTEM));
      expect(start[3]).toBe(PROCESS_NAMES.join(','));
      expect(start).toContain('--update-env');
      // The unrelated process was never adopted into the scoped start.
      expect(fake.state.get(UNRELATED)?.pm2_env.pm_cwd).toBe(
        '/home/truevine-deploy/scratch/checkout.mjs',
      );
    });
  });

  describe('command sequence', () => {
    it('deletes the managed processes by name before starting the new release', async () => {
      const previous = release(OLD_SHA);
      const next = release(NEW_SHA);
      const fake = daemon(runningOn(previous));

      await switchRelease(next, fake.pm2);

      expect(fake.calls).toEqual([
        ['jlist'],
        ['delete', ...PROCESS_NAMES],
        ['start', join(next, ECOSYSTEM), '--only', PROCESS_NAMES.join(','), '--update-env'],
      ]);
    });

    it('skips the delete entirely on a first cutover with nothing to replace', async () => {
      const next = release(NEW_SHA);
      const fake = daemon();

      const result = await switchRelease(next, fake.pm2);

      expect(result.deleted).toEqual([]);
      expect(fake.calls.map(([subcommand]) => subcommand)).toEqual(['jlist', 'start']);
    });

    it('surfaces a PM2 failure rather than activating an unchecked release', async () => {
      const next = release(NEW_SHA);
      const failing = (...args: string[]): string => {
        if (args[0] === 'jlist') return '[]';
        throw new Error('Command failed: pm2 (exit 1)');
      };

      await expect(switchRelease(next, failing)).rejects.toThrow('Command failed: pm2');
    });
  });

  describe('audit before cutover', () => {
    it('accepts managed processes running from a release directory', () => {
      const { releases } = fixture();
      const previous = release(OLD_SHA, releases);
      const processes = PROCESS_NAMES.map((name) => ({
        name,
        pm2_env: { pm_cwd: expectedCwd(name, previous) },
      }));

      expect(() => assertManagedProcessesAuditable(processes, releases)).not.toThrow();
    });

    it('refuses to take over a managed name running from outside the releases root', () => {
      const processes = [
        { name: 'truevine-api', pm2_env: { pm_cwd: '/home/truevine-deploy/api.js' } },
      ];

      expect(() =>
        assertManagedProcessesAuditable(processes, '/var/www/TruevineVoice/releases'),
      ).toThrow('Audit and migrate the existing process before cutover: truevine-api');
    });

    // These use literal POSIX paths on purpose. The audit is pure string
    // matching, so fixed paths test it identically on every platform â€” unlike a
    // fixture whose shape depends on where the temporary directory happens to
    // sit, which is what let a `//` prefix regression reach CI.
    const productionProcesses = PROCESS_NAMES.map((name) => ({
      name,
      pm2_env: {
        pm_cwd: `/var/www/TruevineVoice/releases/v-1/apps/${name.slice('truevine-'.length)}`,
      },
    }));

    it.each([
      { label: 'no trailing slash', root: '/var/www/TruevineVoice/releases' },
      { label: 'one trailing slash', root: '/var/www/TruevineVoice/releases/' },
      { label: 'several trailing slashes', root: '/var/www/TruevineVoice/releases///' },
    ])('accepts the releases root with $label', ({ root }) => {
      // Regression: `${root}/` produced `//` for a root that already ended in a
      // slash, and nothing starts with `//`, so a healthy deployment would have
      // been aborted as unauditable.
      expect(() => assertManagedProcessesAuditable(productionProcesses, root)).not.toThrow();
    });

    it('accepts the filesystem root rather than rejecting every process', () => {
      // `/` is the degenerate case behind the same defect, and the one the
      // original CI failure produced.
      expect(() => assertManagedProcessesAuditable(productionProcesses, '/')).not.toThrow();
    });

    it('still rejects a process outside the root when the root has a trailing slash', () => {
      const processes = [
        { name: 'truevine-api', pm2_env: { pm_cwd: '/home/truevine-deploy/api.js' } },
      ];

      expect(() =>
        assertManagedProcessesAuditable(processes, '/var/www/TruevineVoice/releases/'),
      ).toThrow('Audit and migrate the existing process before cutover: truevine-api');
    });

    it('does not let a sibling directory pass by name prefix alone', () => {
      // `/var/www/TruevineVoice/releases-evil` must not satisfy the
      // `/var/www/TruevineVoice/releases/` prefix.
      const processes = [
        {
          name: 'truevine-api',
          pm2_env: { pm_cwd: '/var/www/TruevineVoice/releases-evil/apps/api' },
        },
      ];

      expect(() =>
        assertManagedProcessesAuditable(processes, '/var/www/TruevineVoice/releases'),
      ).toThrow('Audit and migrate the existing process before cutover: truevine-api');
    });

    it('reports the name of the process that is not auditable', () => {
      const processes = [
        {
          name: 'truevine-web',
          pm2_env: { pm_cwd: '/var/www/TruevineVoice/releases/v-1/apps/web' },
        },
        { name: 'truevine-worker', pm2_env: { pm_cwd: '/opt/stale/worker' } },
      ];

      expect(() =>
        assertManagedProcessesAuditable(processes, '/var/www/TruevineVoice/releases'),
      ).toThrow('truevine-worker');
    });
  });

  describe('rollback with a real switch', () => {
    it('puts the baseline processes back on the baseline release', async () => {
      const previous = release(OLD_SHA);
      const next = release(NEW_SHA);
      const fake = daemon(runningOn(previous));
      const switchLink = vi.fn();

      // The new release switches cleanly, then fails its own health check.
      // Rollback must re-enter the same switch with the baseline, so the four
      // processes genuinely run from `previous` rather than inheriting the
      // failed release's paths.
      await expect(
        activate({
          migrate: vi.fn(),
          release: next,
          previous,
          restart: (directory) => switchRelease(directory, fake.pm2),
          check: async (directory) => {
            if (directory === next) throw new Error('API release/dependency check failed');
            validateProcesses(fake.jlist(), directory, OLD_SHA, now);
          },
          switchLink,
          save: vi.fn(),
          stopNew: vi.fn(),
        }),
      ).rejects.toThrow('API release/dependency check failed');

      expect(staleManagedProcesses(fake.jlist(), previous)).toEqual([]);
      expect(() => validateProcesses(fake.jlist(), previous, OLD_SHA, now)).not.toThrow();
      expect(fake.state.get('truevine-api')?.pm2_env.pm_cwd).toBe(
        expectedCwd('truevine-api', previous),
      );
      expect(fake.state.get('truevine-web')?.pm2_env.APP_VERSION).toBe(OLD_SHA);
      // Only the baseline was ever marked current.
      expect(switchLink).toHaveBeenCalledTimes(1);
      expect(switchLink).toHaveBeenCalledWith(previous);
    });

    it('recovers the baseline even when the failed release left broken processes', async () => {
      const previous = release(OLD_SHA);
      const next = release(NEW_SHA);
      const fake = daemon(runningOn(previous));

      // The switch is attempted, then the daemon is left holding processes
      // that belong to neither release. Rollback must not depend on the failed
      // release's process state being sane.
      await expect(
        activate({
          migrate: vi.fn(),
          release: next,
          previous,
          restart: async (directory) => {
            await switchRelease(directory, fake.pm2);
            if (directory === next) {
              for (const entry of fake.state.values())
                entry.pm2_env.pm_cwd = '/var/www/TruevineVoice/gone';
            }
          },
          check: async (directory) => {
            if (directory === next) {
              throw new Error('did not switch to the release under verification: truevine-web');
            }
            validateProcesses(fake.jlist(), directory, OLD_SHA, now);
          },
          switchLink: vi.fn(),
          save: vi.fn(),
          stopNew: vi.fn(),
        }),
      ).rejects.toThrow('did not switch to the release under verification');

      expect(staleManagedProcesses(fake.jlist(), previous)).toEqual([]);
      expect(() => validateProcesses(fake.jlist(), previous, OLD_SHA, now)).not.toThrow();
    });

    it('reports a genuine double failure instead of claiming recovery', async () => {
      const previous = release(OLD_SHA);
      const next = release(NEW_SHA);
      const fake = daemon(runningOn(previous));

      await expect(
        activate({
          migrate: vi.fn(),
          release: next,
          previous,
          restart: (directory) => switchRelease(directory, fake.pm2),
          check: async () => {
            throw new Error('unhealthy');
          },
          switchLink: vi.fn(),
          save: vi.fn(),
          stopNew: vi.fn(),
        }),
      ).rejects.toThrow('Deployment AND rollback failed');
    });

    it('leaves no managed process running when there is no baseline to roll back to', async () => {
      const next = release(NEW_SHA);
      const foreignPath = '/home/truevine-deploy/scratch/checkout.mjs';
      const fake = daemon({ [UNRELATED]: foreignPath });

      await expect(
        activate({
          migrate: vi.fn(),
          release: next,
          previous: null,
          restart: (directory) => switchRelease(directory, fake.pm2),
          check: async () => {
            throw new Error('unhealthy');
          },
          switchLink: vi.fn(),
          save: vi.fn(),
          stopNew: async () => {
            const started = managedProcesses(fake.jlist());
            if (started.length) fake.pm2('delete', ...started.map((entry) => entry.name));
          },
        }),
      ).rejects.toThrow('unhealthy');

      expect(managedProcesses(fake.jlist())).toEqual([]);
      // Cleanup reached only our own four.
      expect(fake.state.get(UNRELATED)?.pm2_env.pm_cwd).toBe(foreignPath);
    });
  });
});

describe('datastore recovery script safety rails', () => {
  // Static assertions over the script's own text, not its runtime behaviour.
  // They need no Docker daemon and no PostgreSQL, so they run in CI and on a
  // developer machine alike. The properties checked here are the ones whose
  // removal would be silent and dangerous.
  const script = readFileSync(resolve(__dirname, 'db-verify.sh'), 'utf8');

  it('fails immediately on any command error', () => {
    // `set -e` alone still lets a failing command inside a pipeline or a `&&`
    // chain slip through, which is how a hand-run verification produced a false
    // pass: both sides of a comparison returned the same error text.
    expect(script).toMatch(/^#!\/usr\/bin\/env bash/m);
    expect(script).toContain('set -euo pipefail');
  });

  it('fails immediately on SQL errors rather than comparing them as results', () => {
    expect(script).toContain('ON_ERROR_STOP=1');
    expect(script).toMatch(/refusing to compare errors as results/);
  });

  it('keeps the constraint-type cast that PostgreSQL requires', () => {
    // Regression: `contype` is the "char" type, so `text || "char"` is an
    // ambiguous-operator error. Without the cast the fingerprint query aborts.
    expect(script).toContain('contype::text');
    expect(script).not.toMatch(/\|\| contype \|\|/);
  });

  it('runs every verification container with no network and no published ports', () => {
    const runs = script.match(/docker run[^\n]*/g) ?? [];
    expect(runs.length).toBeGreaterThan(0);
    for (const run of runs) expect(run).toContain('--network none');
    expect(script).not.toMatch(/--publish/);
    expect(script).not.toMatch(/docker run[^\n]*\s-p\s/);
  });

  it('destroys nothing without proving this run created it', () => {
    // Identity, not name. A renamed production container has no such label, so
    // it can never be a candidate however it is called.
    expect(script).toContain('readonly LABEL_KEY="truevine.verify.run"');
    expect(script).toContain('assert_owned()');
    expect(script).toMatch(/refusing to remove .* it carries no/);
    expect(script).toMatch(/refusing to remove .* it belongs to run/);
    // The raw destructive commands are confined to the two gated helpers.
    // `safe_remove_*` call assert_owned first; `cleanup_owned` re-checks the
    // label inline. Nothing else may destroy anything.
    expect(script).toMatch(
      /safe_remove_container\(\) \{[\s\S]*?assert_owned container "\$1"[\s\S]*?docker rm -fv "\$1"/,
    );
    expect(script).toMatch(
      /safe_remove_volume\(\) \{[\s\S]*?assert_owned volume "\$1"[\s\S]*?docker volume rm "\$1"/,
    );
    expect(script).toMatch(/cleanup_owned\(\)[\s\S]*?label_of container "\$name"\)" = "\$RUN_ID"/);
    // The destructive surface is pinned: exactly six call sites, each inside a
    // gated helper, each naming a variable that helper has already proven is
    // owned. Any new `docker rm` or `docker volume rm` fails this test.
    const destructive = [
      ...script.matchAll(/docker (?:volume )?rm (?:-fv )?"\$[A-Za-z0-9_]+"/g),
    ].map(([line]) => line);
    expect(destructive.sort()).toEqual(
      [
        'docker rm -fv "$1"', // safe_remove_container
        'docker rm -fv "$c"', // cmd_cleanup, after a label filter
        'docker rm -fv "$name"', // cleanup_owned, after an inline label check
        'docker volume rm "$1"', // safe_remove_volume
        'docker volume rm "$name"', // cleanup_owned, after an inline label check
        'docker volume rm "$v"', // cmd_cleanup, after a label filter
      ].sort(),
    );
  });

  it('never sweeps resources by name', () => {
    // A name sweep would delete an unrelated container that merely resembles a
    // test resource; a label filter cannot.
    expect(script).toMatch(/docker ps -aq --filter "label=\$\{LABEL_PREFIX\}run"/);
    expect(script).toMatch(/docker volume ls -q --filter "label=\$\{LABEL_PREFIX\}run"/);
    expect(script).not.toMatch(/--filter "name=\$\{TEST_PREFIX\}"/);
  });

  it('refuses production by captured identity as well as by name', () => {
    // Names can change; ids cannot be reused by a new container.
    expect(script).toContain('capture_production_identity()');
    expect(script).toContain('assert_not_production_id()');
    expect(script).toMatch(/refusing: \$\{id\} is a production container id/);
    expect(script).toMatch(/is the production mountpoint/);
  });

  it('cleans up after itself on failure and on interrupt', () => {
    expect(script).toContain('trap on_exit EXIT');
    expect(script).toContain("trap 'exit 130' INT");
    expect(script).toContain("trap 'exit 143' TERM");
    expect(script).toContain("trap 'exit 129' HUP");
    // Cleanup is scoped to the run and never touches backups.
    expect(script).toContain('cleanup_owned()');
    expect(script).toMatch(/backups in .* are never touched/);
  });

  it('validates its assumptions before restoring anything', () => {
    expect(script).toContain('validate_restore_assumptions()');
    expect(script).toContain('assert_restored_schema()');
    expect(script).toMatch(/refusing to interpret an empty listing/);
    expect(script).toMatch(/archive contains no TABLE entries/);
  });

  it('declares no unused configuration knobs', () => {
    // APP_ROOT was declared but never read, which misleads an operator into
    // thinking it changes where the script looks.
    expect(script).not.toContain('APP_ROOT');
    expect(script).toMatch(/BACKUP_DIR="\$\{BACKUP_DIR:-\/var\/backups\/truevinevoice\}"/);
    expect(script).toContain('$BACKUP_DIR');
  });

  it('exposes every documented subcommand', () => {
    for (const sub of [
      'preflight',
      'backup',
      'verify-restore',
      'verify-volume',
      'verify-redis',
      'cleanup',
    ]) {
      expect(script).toContain(`${sub})`);
    }
    expect(script).toContain('--all-runs');
  });
});

describe('migration safety', () => {
  /** Builds a minimal tree with a manifest and an optional set of migrations. */
  function tree(migrations: string[], reviewed: string[]): string {
    const directory = mkdtempSync(join(tmpdir(), 'truevine-deploy-'));
    const prismaMigrations = join(directory, 'packages/database/prisma/migrations');
    mkdirSync(prismaMigrations, { recursive: true });
    for (const name of migrations) mkdirSync(join(prismaMigrations, name));
    mkdirSync(join(directory, 'infrastructure'), { recursive: true });
    writeFileSync(
      join(directory, 'infrastructure/migrations-reviewed.json'),
      JSON.stringify({ migrations: reviewed }),
    );
    return directory;
  }

  it('allows a tree with no migrations', () => {
    const directory = tree([], []);
    try {
      expect(() => assertReviewedMigrations(directory)).not.toThrow();
    } finally {
      rmSync(directory, { recursive: true });
    }
  });

  it('allows a reviewed migration', () => {
    const directory = tree(['20261014042915_tenancy_core'], ['20261014042915_tenancy_core']);
    try {
      expect(() => assertReviewedMigrations(directory)).not.toThrow();
    } finally {
      rmSync(directory, { recursive: true });
    }
  });

  it('blocks a migration that has not been reviewed', () => {
    const directory = tree(['20261014042915_tenancy_core'], []);
    try {
      expect(() => assertReviewedMigrations(directory)).toThrow(
        'Unreviewed migration(s) present: 20261014042915_tenancy_core',
      );
    } finally {
      rmSync(directory, { recursive: true });
    }
  });

  it('blocks when the manifest claims a migration the tree does not contain', () => {
    const directory = tree([], ['20261014042915_tenancy_core']);
    try {
      expect(() => assertReviewedMigrations(directory)).toThrow(
        'Reviewed migration(s) listed but absent from this tree',
      );
    } finally {
      rmSync(directory, { recursive: true });
    }
  });

  it('rejects a malformed manifest rather than silently permitting everything', () => {
    const directory = tree([], []);
    try {
      writeFileSync(
        join(directory, 'infrastructure/migrations-reviewed.json'),
        '{"migrations": "all"}',
      );
      expect(() => assertReviewedMigrations(directory)).toThrow('string array');
    } finally {
      rmSync(directory, { recursive: true });
    }
  });
});

describe('controlled production migration execution', () => {
  const directories: string[] = [];
  afterAll(() => {
    for (const directory of directories) rmSync(directory, { recursive: true, force: true });
  });
  function fixture(
    configuration = 'DATABASE_URL="postgresql://fixture:secret@localhost:5432/disposable"\n',
  ) {
    const release = mkdtempSync(join(tmpdir(), 'migration-execution-'));
    directories.push(release);
    mkdirSync(join(release, 'infrastructure'));
    mkdirSync(join(release, 'packages/database/prisma/migrations/reviewed'), { recursive: true });
    writeFileSync(
      join(release, 'infrastructure/migrations-reviewed.json'),
      JSON.stringify({ migrations: ['reviewed'] }),
    );
    const envFile = join(release, '.env');
    writeFileSync(envFile, configuration);
    return { release, envFile };
  }
  it('uses the production file URL instead of ambient configuration and captures output', () => {
    const input = fixture();
    const execute = vi.fn();
    vi.stubEnv('DATABASE_URL', 'postgresql://wrong:wrong@other/wrong');
    try {
      migrateReviewedRelease({ ...input, execute });
      expect(execute).toHaveBeenCalledExactlyOnceWith(
        'npm',
        ['run', 'prisma:migrate:deploy'],
        expect.objectContaining({
          cwd: input.release,
          stdio: ['ignore', 'pipe', 'pipe'],
          timeout: 1800000,
          env: expect.objectContaining({
            DATABASE_URL: 'postgresql://fixture:secret@localhost:5432/disposable?options=-c+lock_timeout%3D5s',
            NODE_ENV: 'production',
          }),
        }),
      );
    } finally {
      vi.unstubAllEnvs();
    }
  });
  it('adds a five-second fail-fast PostgreSQL lock timeout to Prisma migration connections', () => {
    const input = fixture('DATABASE_URL="postgresql://fixture:secret@localhost:5432/disposable?schema=public"\n');
    const execute = vi.fn();
    migrateReviewedRelease({ ...input, execute });
    const environment = execute.mock.calls[0]?.[2]?.env as NodeJS.ProcessEnv;
    const url = new URL(environment.DATABASE_URL ?? '');
    expect(url.searchParams.get('schema')).toBe('public');
    expect(url.searchParams.get('options')).toBe('-c lock_timeout=5s');
  });
  it('fails closed when the database URL already sets a lock timeout', () => {
    const input = fixture('DATABASE_URL="postgresql://fixture:secret@localhost:5432/disposable?options=-c%20lock_timeout%3D30s"\n');
    const execute = vi.fn();
    expect(() => migrateReviewedRelease({ ...input, execute })).toThrow('DATABASE_URL is missing or invalid');
    expect(execute).not.toHaveBeenCalled();
  });
  it('fails without exposing credentials from child-process errors', () => {
    const input = fixture();
    const execute = vi.fn(() => {
      throw new Error('postgresql://fixture:secret@localhost:5432/disposable');
    });
    expect(() => migrateReviewedRelease({ ...input, execute })).toThrow(
      'migration failed; activation was not attempted',
    );
    try {
      migrateReviewedRelease({ ...input, execute });
    } catch (error) {
      expect(String(error)).not.toContain('secret');
      expect(error).not.toHaveProperty('cause');
    }
  });
  it.each(['', 'DATABASE_URL=invalid', 'DATABASE_URL=https://example.com/db'])(
    'rejects invalid production configuration (%s)',
    (configuration) => {
      const execute = vi.fn();
      expect(() => migrateReviewedRelease({ ...fixture(configuration), execute })).toThrow(
        'DATABASE_URL is missing or invalid',
      );
      expect(execute).not.toHaveBeenCalled();
    },
  );
  it('refuses unreviewed SQL before running Prisma', () => {
    const input = fixture();
    mkdirSync(join(input.release, 'packages/database/prisma/migrations/unreviewed'));
    const execute = vi.fn();
    expect(() => migrateReviewedRelease({ ...input, execute })).toThrow('Unreviewed migration');
    expect(execute).not.toHaveBeenCalled();
  });
});
