import { describe, expect, it } from 'vitest';
import { qaTarget, QA_DATABASE } from './run-tenant-isolation-qa.mjs';

describe('RBAC-012 QA target pinning', () => {
  const local = 'postgresql://synthetic:synthetic@127.0.0.1:55432/truevine_voice?schema=public';
  it('pins the connection to QA without connecting to the source database', () => {
    const target = new URL(qaTarget(local, 'test'));
    expect(target.pathname).toBe('/' + QA_DATABASE);
    expect(target.hostname).toBe('127.0.0.1');
    expect(target.search).toBe('');
  });
  it('refuses deployed environments, other hosts/ports/protocols and routing overrides', () => {
    for (const environment of ['production', 'staging'])
      expect(() => qaTarget(local, environment)).toThrow();
    for (const bad of [
      local.replace('127.0.0.1', 'remote.invalid'),
      local.replace('55432', '5432'),
      local.replace('postgresql:', 'mysql:'),
      local + '&host=remote',
      local + '&schema=private',
    ]) {
      expect(() => qaTarget(bad, 'test')).toThrow();
    }
  });
});
