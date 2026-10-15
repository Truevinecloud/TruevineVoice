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
import { activate, assertReviewedMigrations, assertManagedProcessesAuditable, ECOSYSTEM, releaseEnv, switchRelease } from './deploy.mjs';
import {
  assertCiJobs,
  assertProcessesRunRelease,
  assertReleaseEnvAccessible,
  checkHttp,
  expectedCwd,
  managedProcesses,
  parseVerifierArguments,
  PROCESS_NAMES,
  staleManagedProcesses,
  validateConfig,
  validateProcesses,
  verifyHttp,
} from './verify-deployment.mjs';

const sha = 'a'.repeat(40);
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
const config = {
  webUrl: 'https://voice.truevinecloud.online/',
  apiHealthUrl: 'https://example.test/api/health',
  adminAccess: 'internal',
  adminUrl: null,
  apiPort: 3001,
};
const healthy = {
  status: 'ok',
  service: 'truevine-voice-api',
  version: sha,
  environment: 'production',
  dependencies: { postgres: { status: 'up' }, redis: { status: 'up' } },
};

/**
 * Body as React actually emits it from server rendering.
 *
 * The `<!-- -->` separators are not decoration. When a heading mixes an
 * interpolated expression with literal text, as `{product} Admin` does, React
 * SSR inserts a comment between the two text nodes, so the concatenated words
 * never appear as a contiguous substring of the HTML. A marker built by joining
 * those words therefore fails against a perfectly healthy page.
 *
 * Reproducing that here means a marker regression of this kind fails in CI
 * rather than on the VPS, where the deployment has already activated a release
 * before verification rejects it.
 */
const SSR_ADMIN_BODY =
  '<main><h1>Truevine Voice<!-- --> Admin</h1>' +
  '<p>Intended audience: Truevine Voice<!-- --> internal operators.</p>' +
  '<h2>No admin functionality yet</h2></main>';

const SSR_WEB_BODY =
  '<main><h1>Truevine Voice</h1>' +
  '<p>Customer web application<!-- --> for Truevine Voice is live.</p>' +
  '<h2>Live web for voice</h2>' +
  '<p>Live at voice.truevinecloud.online</p>' +
  '<p>The voice product is still under construction.</p></main>';

function response(kind = 'api', body = healthy, status = 200) {
  return {
    status,
    json: async () => body,
    text: async () => (kind === 'web' ? SSR_WEB_BODY : SSR_ADMIN_BODY),
  };
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
    // the operator action differs completely — a failed switch, not a sick app.
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
  it('accepts the admin page as React SSR emits it', async () => {
    // The regression this guards: the marker used to be `Truevine Voice Admin`,
    // but React renders `<h1>Truevine Voice<!-- --> Admin</h1>`, so the
    // contiguous string is absent and verification failed on a healthy page.
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
  it('rejects an admin page missing the deferred-functionality statement', async () => {
    // Guards against someone "fixing" the marker by dropping the checks that
    // prove the page is ours rather than swapping in a weaker single marker.
    await expect(
      checkHttp('https://example.test/admin', 'admin', sha, async () => ({
        status: 200,
        text: async () => '<main><h1>Truevine Voice<!-- --> Admin</h1></main>',
      })),
    ).rejects.toThrow('admin foundation page check failed');
  });
  it('rejects non-200 responses', async () => {
    await expect(
      checkHttp('https://example.test/', 'web', sha, async () => response('web', null, 404)),
    ).rejects.toThrow('404');
  });
  it('checks each application locally and the agreed public routes', async () => {
    const fetcher = vi.fn(async (url) =>
      response(url.includes('health') ? 'api' : url.includes('3002') ? 'admin' : 'web'),
    );
    await verifyHttp(config, sha, fetcher);
    expect(fetcher.mock.calls.map(([url]) => url)).toEqual([
      'http://127.0.0.1:3000/',
      'http://127.0.0.1:3002/admin',
      'http://127.0.0.1:3001/health',
      config.webUrl,
      config.apiHealthUrl,
    ]);
    expect(fetcher.mock.calls[0][1].redirect).toBe('error');
  });
  it('verifies a confirmed public admin route', async () => {
    const fetcher = vi.fn(async (url) =>
      response(
        url.includes('health')
          ? 'api'
          : url.includes('3002') || url.includes('operators')
            ? 'admin'
            : 'web',
      ),
    );
    await verifyHttp(
      { ...config, adminAccess: 'public', adminUrl: 'https://operators.example.test/' },
      sha,
      fetcher,
    );
    expect(fetcher.mock.calls.map(([url]) => url)).toContain('https://operators.example.test/');
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
      restart: vi.fn(),
      check: vi.fn(),
      switchLink: vi.fn(),
      save: vi.fn(),
      stopNew: vi.fn(),
    };
  }
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

  /** A release directory carrying the `REVISION` the ecosystem reads. */
  function release(version: string): string {
    const directory = mkdtempSync(join(tmpdir(), 'truevine-release-'));
    created.push(directory);
    writeFileSync(join(directory, 'REVISION'), `${version}\n`);
    return resolve(directory);
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
   * still refresh the environment. That combination is the whole defect — the
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
          : (rest[onlyIndex + 1] ?? '')
              .split(',')
              .filter(Boolean);
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
      const previous = release(OLD_SHA);
      const releases = resolve(previous, '..', '..');
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
