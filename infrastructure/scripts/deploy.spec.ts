import { describe, expect, it, vi } from 'vitest';
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
import { join } from 'node:path';
import { activate, assertReviewedMigrations, releaseEnv } from './deploy.mjs';
import {
  assertCiJobs,
  assertReleaseEnvAccessible,
  checkHttp,
  PROCESS_NAMES,
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
      { pm_cwd: '/var/www/other/apps/worker' },
      { pm_cwd: `${release}/apps/api` },
      { pm_uptime: undefined },
    ]) {
      expect(() =>
        validateProcesses(
          [...processes.slice(0, 3), { ...worker, pm2_env: { ...worker.pm2_env, ...patch } }],
          release,
          sha,
          now,
        ),
      ).toThrow('worker');
    }
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
