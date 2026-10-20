import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { check } from 'prettier';

const workflow = readFileSync(
  new URL('../../.github/workflows/restore-integration.yml', import.meta.url),
  'utf8',
).replace(/\r\n/g, '\n');
const script = readFileSync(new URL('./restore-integration.sh', import.meta.url), 'utf8');

describe('isolated restore integration workflow', () => {
  it('is valid YAML and uses only a hosted runner with read-only checkout', async () => {
    // Prettier parses YAML; syntax errors throw even when formatting differs.
    await check(workflow, { parser: 'yaml' });
    expect(workflow).toContain('runs-on: ubuntu-24.04');
    expect(workflow).toContain('contents: read');
    expect(workflow).toContain('persist-credentials: false');
    for (const [, sha] of workflow.matchAll(/uses: [\w/-]+@(\S+)/g)) {
      expect(sha).toMatch(/^[a-f0-9]{40}$/);
    }
    expect(workflow).not.toMatch(
      /secrets\.|environment:|self-hosted|workflow_run:|pull_request_target:|id-token:|write/,
    );
    expect(workflow).not.toMatch(/deploy:|migrate|ssh|scp|production/);
  });

  it('runs regressions and real Docker integration with unconditional fallback cleanup', () => {
    expect(workflow).toContain('run: npm run test:restore-integration:checks');
    expect(workflow).toContain('run: npm run test:db-verify');
    expect(workflow).toContain('run: npm run test:restore-integration\n');
    expect(workflow).toMatch(/if: always\(\)\s+run: npm run test:restore-integration -- --cleanup/);
  });

  it('refuses execution outside the hosted runner before contacting Docker', () => {
    const result = spawnSync(
      process.execPath,
      [fileURLToPath(new URL('./run-restore-integration.mjs', import.meta.url))],
      {
        encoding: 'utf8',
        env: { ...process.env, GITHUB_ACTIONS: '', RUNNER_ENVIRONMENT: '' },
      },
    );
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/GitHub-hosted/);
    expect(script.indexOf('RUNNER_ENVIRONMENT')).toBeLessThan(script.indexOf('docker info'));
    expect(script).toContain('export DOCKER_HOST=unix:///var/run/docker.sock');
    expect(script).toContain('unset DOCKER_CONTEXT DOCKER_TLS_VERIFY DOCKER_CERT_PATH');
    expect(script).toContain('initial_containers=$(docker ps -aq) || die');
    expect(script).toContain('initial_volumes=$(docker volume ls -q) || die');
    expect(script).not.toMatch(/docker context|--host|\bssh\b|\bprisma\s+(?:migrate|db)\b|\.env/);
  });

  it('exercises the actual CLI against real archives with a PostgreSQL failure', () => {
    expect(script).toContain('bash "$script" "$command" "$backup"');
    expect(script).toContain(
      'for command in verify-restore verify-volume; do run_case "$command" success',
    );
    expect(script).toContain(
      'for command in verify-restore verify-volume; do run_case "$command" failure',
    );
    expect(script).toContain('TABLE DATA public ');
    expect(script).toContain('= 22 ]');
    expect(script).toContain('archive declares 11 public table(s)');
    expect(script).toContain('--exclude-schema=failure_fixture');
    expect(script).toContain('schema "failure_fixture" does not exist');
    expect(script).toContain('[ "$rc" = 1 ]');
    expect(script).not.toMatch(/write_stub|source "\$script"/);
  });

  it('asserts cleanup before emergency cleanup and never prunes the daemon', () => {
    expect(script).toMatch(/assert_fixture_only\n\s+\[ -s "\$backup"/);
    expect(script).toContain('rehearsal container leaked');
    expect(script).toContain('rehearsal volume leaked');
    expect(script).toContain('trap on_exit EXIT');
    expect(script).toContain('cleanup owner mismatch');
    expect(script).toContain('--network none --label "$label"');
    expect(script).not.toMatch(/docker (?:system|volume|container) prune|--publish|--volumes-from/);
    expect(script).toContain('containers remain after final cleanup');
    expect(script).toContain('volumes remain after final cleanup');
  });
});
