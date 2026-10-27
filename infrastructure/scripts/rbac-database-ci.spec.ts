import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { check } from 'prettier';
import { assertDisposableDatabase } from '../../apps/api/test/disposable-database.js';

const workflow = readFileSync(
  new URL('../../.github/workflows/rbac-database-e2e.yml', import.meta.url),
  'utf8',
);

describe('isolated RBAC database CI', () => {
  it('uses valid YAML, pinned actions, hosted runners and read-only credentials', async () => {
    await check(workflow, { parser: 'yaml' });
    expect(workflow).toContain('contents: read');
    expect(workflow).toContain('persist-credentials: false');
    expect(workflow).not.toMatch(
      /secrets\.|environment:|self-hosted|pull_request_target:|workflow_run:|id-token:|contents: write/,
    );
    for (const [, sha] of workflow.matchAll(/uses: [\w/-]+@(\S+)/g)) {
      expect(sha).toMatch(/^[a-f0-9]{40}$/);
    }
  });

  it('runs both candidate suites on fresh service databases without suppressing failure', () => {
    expect(workflow).toContain('suite: [billing, campaigns]');
    expect(workflow).toContain('POSTGRES_DB: truevine_voice');
    expect(workflow).toContain('postgres:18-alpine');
    expect(workflow).toContain('redis:8-alpine');
    expect(workflow).toContain('NODE_ENV: test');
    expect(workflow).toContain("BILLING_E2E_DISPOSABLE: '1'");
    expect(workflow).toContain('localhost:%s/truevine_voice?schema=public');
    expect(workflow).toContain('test -f apps/api/test/billing.e2e-spec.ts');
    expect(workflow).toContain('test ! -f .env');
    expect(workflow).toContain('npm run prisma:migrate:deploy');
    expect(workflow).toContain(
      'npm run test:e2e --workspace @truevine/api -- ${{ matrix.suite }}.e2e-spec.ts',
    );
    expect(workflow).not.toMatch(
      /continue-on-error|passWithNoTests|\|\| true|deploy:release|ssh|scp/,
    );
  });

  it('uses the allowed loopback PostgreSQL endpoint and an assigned Redis port', () => {
    expect(workflow).toMatch(/- 127\.0\.0\.1:55432:5432/);
    expect(workflow).toMatch(/ports:\s+- 6379\/tcp/);
    expect(workflow).toContain('POSTGRES_TEST_PORT: ${{ job.services.postgres.ports[5432] }}');
    expect(workflow).toContain('REDIS_TEST_PORT: ${{ job.services.redis.ports[6379] }}');
    expect(workflow).toContain('"$POSTGRES_TEST_PORT" >> "$GITHUB_ENV"');
    expect(workflow).toContain('"$REDIS_TEST_PORT" >> "$GITHUB_ENV"');
    expect(workflow).not.toContain('56379');
  });

  it('produces a URL accepted by the unchanged campaign database guard', () => {
    const database = workflow.match(/POSTGRES_DB: (\w+)/)?.[1];
    const port = workflow.match(/- 127\.0\.0\.1:(\d+):5432/)?.[1];
    const template = workflow.match(/DATABASE_URL=(postgresql:\/\/[^\s']+)/)?.[1];
    expect(database).toBeDefined();
    expect(port).toBeDefined();
    expect(template).toBeDefined();
    if (!database || !port || !template) throw new Error('Missing CI PostgreSQL configuration');
    const endpoint = template.replace('%s', port);
    expect(assertDisposableDatabase(endpoint, 'test')).toEqual({
      name: database,
      hostname: 'localhost',
      port,
    });
    expect(workflow).toContain(`-U rbac_test -d ${database}`);

    // Pin both independent causes of the reported failure; a CI marker must
    // never turn either unsafe endpoint into an allowed database.
    expect(() => assertDisposableDatabase(endpoint.replace(':55432/', ':32768/'), 'test')).toThrow(
      /port/,
    );
    expect(() =>
      assertDisposableDatabase(endpoint.replace('/truevine_voice?', '/rbac_e2e_test?'), 'test'),
    ).toThrow(/database/);
  });
});
