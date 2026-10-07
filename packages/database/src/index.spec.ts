import { describe, expect, it, vi } from 'vitest';

import { OrganizationTenantClient, probeDatabase } from './index.js';

describe('probeDatabase', () => {
  it('reports "up" when the round trip succeeds', async () => {
    const client = { $queryRaw: vi.fn().mockResolvedValue([{ '?column?': 1 }]) };

    const health = await probeDatabase(client, 1_000);

    expect(health.status).toBe('up');
    expect(health.latencyMs).toBeGreaterThanOrEqual(0);
    expect(health.error).toBeUndefined();
  });

  it('reports "down" with a log-safe message when the query fails', async () => {
    const client = {
      $queryRaw: vi.fn().mockRejectedValue(new Error('connection refused')),
    };

    const health = await probeDatabase(client, 1_000);

    expect(health.status).toBe('down');
    expect(health.error).toBe('connection refused');
  });

  it('reports "down" when the probe exceeds its timeout', async () => {
    const client = { $queryRaw: vi.fn().mockReturnValue(new Promise(() => {})) };

    const health = await probeDatabase(client, 5);

    expect(health.status).toBe('down');
    expect(health.error).toContain('timed out');
  });
});

describe('OrganizationTenantClient', () => {
  it('rejects an empty organization identifier', () => {
    const client = {} as never;

    expect(() => new OrganizationTenantClient(client, '   ')).toThrow(
      /requires a non-empty organizationId/,
    );
  });

  it('binds to the organization it was created with', () => {
    const client = {} as never;

    expect(new OrganizationTenantClient(client, 'org_123').organizationId).toBe('org_123');
  });
});
