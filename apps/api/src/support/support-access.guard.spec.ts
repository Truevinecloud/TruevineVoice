import { ForbiddenException, Logger, type ExecutionContext } from '@nestjs/common';
import type { AuditStore } from '../auth/auth.store.js';
import { PRINCIPAL, type AuthenticatedRequest, type Principal } from '../auth/principal.js';
import { describe, expect, it, vi } from 'vitest';
import { SupportAccessGuard } from './support-access.guard.js';
import { SupportAccessService } from './support-access.service.js';

const operator: Principal = {
  userId: '00000000-0000-4000-8000-000000000001',
  email: 'support@example.invalid',
  sessionId: '00000000-0000-4000-8000-000000000002',
  platformRole: 'SUPPORT_ADMIN',
};

describe('SupportAccessGuard', () => {
  it('denies an organization mismatch and emits an operational signal if denial audit fails', async () => {
    const request: AuthenticatedRequest = {
      [PRINCIPAL]: operator,
      headers: { 'x-support-access-token': 'opaque-token' },
      params: { organizationId: '00000000-0000-4000-8000-000000000004' },
    };
    const access = {
      resolve: async () => ({
        id: '00000000-0000-4000-8000-000000000003',
        organizationId: '00000000-0000-4000-8000-000000000005',
        actorUserId: operator.userId,
        reasonCode: 'CUSTOMER_REQUEST',
        expiresAt: new Date(Date.now() + 60_000),
      }),
    } as unknown as SupportAccessService;
    const audit = {
      recordIdentity: async () => {
        throw new Error('audit store unavailable');
      },
    } as unknown as AuditStore;
    const guard = new SupportAccessGuard(access, audit);
    const context = {
      getType: () => 'http',
      switchToHttp: () => ({ getRequest: () => request }),
    } as unknown as ExecutionContext;
    const log = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);

    await expect(guard.canActivate(context)).rejects.toBeInstanceOf(ForbiddenException);

    expect(log).toHaveBeenCalledWith(
      expect.stringContaining('"event":"support_access_denial_audit_failed"'),
    );
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining('"reasonCode":"organization_scope_mismatch"'),
    );
    log.mockRestore();
  });
});
