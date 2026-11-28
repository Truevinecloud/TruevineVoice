import { describe, expect, it, vi } from 'vitest';

import { PlatformAdminService } from './platform-admin.service.js';
import type { PlatformAdminStore } from './platform-admin.store.js';

const assignment = {
  userId: 'user-1',
  email: 'owner@example.invalid',
  status: 'ACTIVE' as const,
  role: 'PLATFORM_OWNER' as const,
  grantedByUserId: 'actor-1',
  grantedAt: new Date('2026-11-04T00:00:00Z'),
  revokedAt: null,
};

function service(storeOverrides: Partial<PlatformAdminStore> = {}) {
  const store: PlatformAdminStore = {
    listAssignments: vi.fn(async () => [assignment]),
    findUser: vi.fn(async () => ({ id: '11111111-2222-4333-8444-555555555555', email: 'target@example.invalid', status: 'ACTIVE' as const })),
    searchEligibleUsers: vi.fn(async () => []),
    grantRole: vi.fn(async () => ({ ...assignment, userId: '11111111-2222-4333-8444-555555555555', email: 'target@example.invalid', role: 'AUDITOR' as const })),
    revokeRole: vi.fn(async () => 'revoked' as const),
    countActiveOwners: vi.fn(async () => 1),
    ...storeOverrides,
  };
  const audit = { recordIdentity: vi.fn(async () => undefined) };
  return { service: new PlatformAdminService(store, audit as never), store, audit };
}

describe('PlatformAdminService', () => {
  it('lists assignments and records an audit event', async () => {
    const state = service();
    const result = await state.service.listAssignments('actor-1');
    expect(result).toHaveLength(1);
    expect(state.audit.recordIdentity).toHaveBeenCalled();
  });

  it('refuses invalid role grants', async () => {
    const state = service();
    await expect(
      state.service.grantRole(
        'actor-1',
        '11111111-2222-4333-8444-555555555555',
        'NOT_A_ROLE',
        { reasonCode: 'routine_administration' },
      ),
    ).rejects.toBeTruthy();
    expect(state.store.grantRole).not.toHaveBeenCalled();
  });

  it('requires a valid reason before granting a role', async () => {
    const state = service();
    await expect(
      state.service.grantRole(
        'actor-1',
        '11111111-2222-4333-8444-555555555555',
        'AUDITOR',
        undefined,
      ),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      state.service.grantRole(
        'actor-1',
        '11111111-2222-4333-8444-555555555555',
        'AUDITOR',
        { reasonCode: 'not_a_reason' },
      ),
    ).rejects.toMatchObject({ status: 400 });
    expect(state.store.grantRole).not.toHaveBeenCalled();
  });

  it('passes a validated reason to the store, which commits the audit', async () => {
    const state = service();
    await state.service.grantRole(
      'actor-1',
      '11111111-2222-4333-8444-555555555555',
      'AUDITOR',
      { reasonCode: 'security_incident', justification: '  Incident review  ' },
    );
    expect(state.store.grantRole).toHaveBeenCalledWith({
      userId: '11111111-2222-4333-8444-555555555555',
      role: 'AUDITOR',
      grantedByUserId: 'actor-1',
      reason: { reasonCode: 'security_incident', justification: 'Incident review' },
    });
    // The service must not write a second, post-commit record for the same change.
    expect(state.audit.recordIdentity).not.toHaveBeenCalled();
  });

  it('revokes a role and passes the actor and reason to the store', async () => {
    const state = service();
    const result = await state.service.revokeRole(
      'actor-1',
      '11111111-2222-4333-8444-555555555555',
      { reasonCode: 'customer_request' },
    );
    expect(result).toMatchObject({ revoked: true });
    expect(state.store.revokeRole).toHaveBeenCalledWith(
      '11111111-2222-4333-8444-555555555555',
      'actor-1',
      { reasonCode: 'customer_request', justification: null },
    );
    expect(state.audit.recordIdentity).not.toHaveBeenCalled();
  });

  it('refuses to remove the last active platform owner', async () => {
    const state = service({ revokeRole: vi.fn(async () => 'last_owner' as const) });
    await expect(
      state.service.revokeRole(
        'actor-1',
        '11111111-2222-4333-8444-555555555555',
        { reasonCode: 'routine_administration' },
      ),
    ).rejects.toBeTruthy();
  });
});
