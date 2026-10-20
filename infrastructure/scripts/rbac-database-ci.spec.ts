import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { check } from 'prettier';

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
    expect(workflow).toContain('POSTGRES_DB: rbac_e2e_test');
    expect(workflow).toContain('postgres:18-alpine');
    expect(workflow).toContain('redis:8-alpine');
    expect(workflow).toContain('NODE_ENV: test');
    expect(workflow).toContain("BILLING_E2E_DISPOSABLE: '1'");
    expect(workflow).toContain('localhost:%s/rbac_e2e_test?schema=public');
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

  it('allocates free service ports and uses their actual assigned endpoints', () => {
    expect(workflow).toMatch(/ports:\s+- 5432\/tcp/);
    expect(workflow).toMatch(/ports:\s+- 6379\/tcp/);
    expect(workflow).toContain('POSTGRES_TEST_PORT: ${{ job.services.postgres.ports[5432] }}');
    expect(workflow).toContain('REDIS_TEST_PORT: ${{ job.services.redis.ports[6379] }}');
    expect(workflow).toContain('"$POSTGRES_TEST_PORT" >> "$GITHUB_ENV"');
    expect(workflow).toContain('"$REDIS_TEST_PORT" >> "$GITHUB_ENV"');
    expect(workflow).not.toMatch(/55432|56379/);
  });
});
