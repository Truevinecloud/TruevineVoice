import { describe, expect, it, vi } from 'vitest';

import { OrganizationsController } from './organizations.controller.js';
import { OrganizationsService } from './organizations.service.js';
import { aMembership, FakeAuditStore, FakeAuthStore, FakeOrganizationStore, FakeSecurityTransaction } from '../../test/fakes/auth.fakes.js';

describe('GET /me organization permission projection', () => {
  it('isolates fresh grants per tenant, hides suspended authority, and rejects a partial snapshot', async () => {
    const auth = new FakeAuthStore();
    const audit = new FakeAuditStore();
    const organizations = new FakeOrganizationStore();
    organizations.organizations.push(
      { id: 'org-b', slug: 'org-b', name: 'B', suspendedAt: null },
      { id: 'org-c', slug: 'org-c', name: 'C', suspendedAt: new Date(0) },
    );
    for (const organizationId of ['org-1', 'org-b', 'org-c']) {
      organizations.memberships.push(aMembership({ organizationId, userId: 'user-1', role: 'VIEWER' }));
    }
    const grants = new Map([['org-1', ['campaign:create', 'wallet:read']]]);
    const lookup = vi.fn(async (organizationId: string) => grants.get(organizationId) ?? []);
    const store = Object.assign(organizations, { readCustomOrganizationGrants: lookup });
    const service = new OrganizationsService(
      store, auth, audit,
      { send: async () => undefined } as never,
      'http://localhost:3000', 'test-terms',
      new FakeSecurityTransaction(auth, organizations, audit),
      { consume: async () => ({ allowed: true, retryAfterMs: 0, remaining: 1 }) } as never,
    );
    const controller = new OrganizationsController(service);
    const principal = { userId: 'user-1', platformRole: null };
    const snapshot = await controller.me(principal);
    const memberships = new Map(snapshot.memberships.map((membership) => [membership.organizationId, membership]));
    expect(memberships.get('org-1')?.role).toBe('VIEWER');
    expect(memberships.get('org-1')?.permissions).toContain('campaign:create');
    expect(memberships.get('org-1')?.permissions).not.toContain('wallet:read');
    expect(memberships.get('org-b')?.permissions).not.toContain('campaign:create');
    expect(memberships.get('org-c')?.permissions).toEqual([]);
    expect(lookup.mock.calls.map(([id]) => id)).not.toContain('org-c');

    grants.delete('org-1');
    const refreshed = await controller.me(principal);
    expect(refreshed.memberships.find((membership) => membership.organizationId === 'org-1')?.permissions)
      .not.toContain('campaign:create');

    lookup.mockRejectedValueOnce(new Error('private grant failure'));
    await expect(controller.me(principal)).rejects.toMatchObject({
      status: 503,
      response: { error: { code: 'permissions_unavailable' } },
    });
  });
});
