import { hashToken } from '@truevine/auth';
import { describe, expect, it } from 'vitest';
import type { AuditStore } from '../auth/auth.store.js';
import type { Principal } from '../auth/principal.js';
import { SUPPORT_ACCESS_TTL_MS, SupportAccessService } from './support-access.service.js';
import type { NewSupportAccessSession, SupportAccessStore } from './support-access.store.js';

const PRINCIPAL: Principal = {
  userId: '00000000-0000-4000-8000-000000000001',
  email: 'operator@example.invalid',
  sessionId: '00000000-0000-4000-8000-000000000002',
  platformRole: 'SUPPORT_ADMIN',
};
const ORG = '00000000-0000-4000-8000-000000000003';

class StoreFake implements SupportAccessStore {
  created?: NewSupportAccessSession;
  resolution: Awaited<ReturnType<SupportAccessStore['resolve']>> = { kind: 'invalid' };
  revokeResult: Awaited<ReturnType<SupportAccessStore['revoke']>> = 'invalid';
  createResult: Awaited<ReturnType<SupportAccessStore['create']>> = 'created';

  async create(input: NewSupportAccessSession) {
    this.created = input;
    return this.createResult;
  }

  async resolve() {
    return this.resolution;
  }

  async revoke() {
    return this.revokeResult;
  }
}

class AuditFake implements AuditStore {
  readonly identityEvents: unknown[] = [];
  async record() {}
  async recordIdentity(event: unknown) {
    this.identityEvents.push(event);
  }
}

describe('SupportAccessService', () => {
  it('creates a hashed, one-time capability for one organization with a fixed 15-minute expiry', async () => {
    const store = new StoreFake();
    const service = new SupportAccessService(store, new AuditFake());
    const result = await service.start(
      PRINCIPAL,
      { organizationId: ORG, reasonCode: 'CUSTOMER_REQUEST' },
      false,
    );
    expect(result.organizationId).toBe(ORG);
    expect(result.reasonCode).toBe('CUSTOMER_REQUEST');
    expect(result.supportAccessToken).not.toBe(store.created?.tokenHash);
    expect(store.created?.tokenHash).toBe(hashToken(result.supportAccessToken));
    expect(new Date(result.expiresAt).getTime() - store.created!.createdAt.getTime()).toBe(
      SUPPORT_ACCESS_TTL_MS,
    );
  });

  it('rejects a missing or invalid reason and records a denied attempt', async () => {
    const store = new StoreFake();
    const audit = new AuditFake();
    const service = new SupportAccessService(store, audit);
    await expect(service.start(PRINCIPAL, { organizationId: ORG }, false)).rejects.toMatchObject({
      status: 400,
    });
    expect(store.created).toBeUndefined();
    expect(audit.identityEvents).toHaveLength(1);
  });

  it('rejects nested contexts and never resolves an invalid or cross-actor capability', async () => {
    const store = new StoreFake();
    const audit = new AuditFake();
    const service = new SupportAccessService(store, audit);
    await expect(
      service.start(PRINCIPAL, { organizationId: ORG, reasonCode: 'SECURITY_REVIEW' }, true),
    ).rejects.toMatchObject({ status: 400 });
    await expect(service.resolve(PRINCIPAL, 'x'.repeat(48))).rejects.toMatchObject({ status: 403 });
    expect(audit.identityEvents).toHaveLength(2);
  });

  it('ends an access context only when the store confirms revocation', async () => {
    const store = new StoreFake();
    const service = new SupportAccessService(store, new AuditFake());
    store.revokeResult = 'revoked';
    await expect(service.end(PRINCIPAL, 'a'.repeat(48))).resolves.toEqual({ ended: true });
  });
});
