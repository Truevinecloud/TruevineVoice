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
    await expect(state.service.grantRole('actor-1', '11111111-2222-4333-8444-555555555555', 'NOT_A_ROLE')).rejects.toBeTruthy();
    expect(state.store.grantRole).not.toHaveBeenCalled();
  });

  it('revokes a role and records an audit event', async () => {
    const state = service();
    const result = await state.service.revokeRole('actor-1', '11111111-2222-4333-8444-555555555555');
    expect(result).toMatchObject({ revoked: true });
    expect(state.audit.recordIdentity).toHaveBeenCalled();
  });

  it('refuses to remove the last active platform owner', async () => {
    const state = service({ revokeRole: vi.fn(async () => 'last_owner' as const) });
    await expect(state.service.revokeRole('actor-1', 'user-1')).rejects.toBeTruthy();
  });
});
