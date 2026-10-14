import { describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { activate, assertReviewedMigrations } from './deploy.mjs';
import {
  assertCiJobs,
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

function response(kind = 'api', body = healthy, status = 200) {
  return {
    status,
    json: async () => body,
    text: async () =>
      kind === 'web'
        ? 'Truevine Voice Customer web application Live web for voice voice.truevinecloud.online the voice product is still under construction'
        : 'Truevine Voice Admin No admin functionality yet internal operators',
  };
}

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
