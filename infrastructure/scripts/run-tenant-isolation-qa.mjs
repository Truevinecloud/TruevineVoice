import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnvFiles, requireEnv } from '@truevine/shared';
import { createDatabaseClient } from '@truevine/database';

export const QA_DATABASE = 'truevine_bootstrap_test_a1b2c3d4e5f67890';
export function qaTarget(value, environment) {
  if (environment === 'production' || environment === 'staging')
    throw new Error('QA refuses deployed environments.');
  const url = new URL(value);
  if (
    !['postgres:', 'postgresql:'].includes(url.protocol) ||
    !['localhost', '127.0.0.1'].includes(url.hostname) ||
    url.port !== '55432'
  ) {
    throw new Error('QA requires the repository loopback PostgreSQL port.');
  }
  for (const [key, value] of url.searchParams) {
    if (key !== 'schema' || value !== 'public')
      throw new Error('QA refuses connection routing options.');
  }
  url.search = '';
  // Reuse local connection credentials in memory; never connect to the source database.
  // Only the explicitly authorized, pinned QA database is passed to any client.
  url.pathname = '/' + QA_DATABASE;
  return url.toString();
}

export async function main() {
  loadEnvFiles();
  const target = qaTarget(requireEnv('DATABASE_URL'), process.env.NODE_ENV);
  const database = createDatabaseClient(target, { log: [] });
  try {
    const rows = await database.$queryRaw`SELECT current_database() AS name`;
    if (rows[0]?.name !== QA_DATABASE) throw new Error('QA database identity mismatch.');
  } finally {
    await database.$disconnect();
  }
  const result = spawnSync(
    process.execPath,
    [
      resolve('node_modules/vitest/vitest.mjs'),
      'run',
      '--config',
      'vitest.e2e.config.mts',
      'tenant-isolation.e2e-spec.ts',
      'contacts.e2e-spec.ts',
      'audio-assets.e2e-spec.ts',
      'campaigns.e2e-spec.ts',
      'billing.e2e-spec.ts',
      'call-persistence.e2e-spec.ts',
      'organization-admin.e2e-spec.ts',
      'authorization.e2e-spec.ts',
      'contact-groups.e2e-spec.ts',
      'payment-intents.e2e-spec.ts',
      'billing-admin.e2e-spec.ts',
      '--maxWorkers=1',
    ],
    {
      cwd: resolve('apps/api'),
      stdio: 'inherit',
      env: {
        ...process.env,
        DATABASE_URL: target,
        NODE_ENV: 'test',
        RBAC_ISOLATED_QA: '1',
        TENANT_ISOLATION_DISPOSABLE: '1',
        BILLING_E2E_DISPOSABLE: '1',
        CALL_PERSISTENCE_DISPOSABLE: '1',
        BILLING_ADMIN_E2E_DISPOSABLE: '1',
        WEB_PUBLIC_URL: 'http://localhost:3000',
        EMAIL_TRANSPORT: 'none',
      },
    },
  );
  if (result.error || result.status !== 0) throw new Error('Cross-tenant QA suite failed.');
}
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main().catch(() => {
    process.stderr.write(
      'RBAC-012 QA failed. Verify the pinned QA database and test results; no fallback is allowed.\n',
    );
    process.exitCode = 1;
  });
}
