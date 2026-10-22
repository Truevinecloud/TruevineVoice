import { Controller, Logger, Post, UseGuards, type INestApplication } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { hashToken } from '@truevine/auth';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthExceptionFilter } from '../src/auth/auth-exception.filter.js';
import { SessionGuard } from '../src/auth/session.guard.js';
import { AUDIT_STORE, AUTH_STORE, PLATFORM_ROLE_STORE, TERMS_VERSION } from '../src/auth/tokens.js';
import {
  aSession,
  aUser,
  FakeAuditStore,
  FakeAuthStore,
  FakePlatformRoleStore,
} from './fakes/auth.fakes.js';

const controllerCalled = vi.fn(() => ({ authorized: true }));

@Controller()
@UseGuards(SessionGuard)
class ProtectedController {
  @Post('organizations/:organizationId/campaigns')
  mutation() {
    return controllerCalled();
  }

  @Post('platform/support/sessions')
  nestedContext() {
    return controllerCalled();
  }
}

describe('SessionGuard prohibited support-context routes', () => {
  let app: INestApplication;
  let audit: FakeAuditStore;
  const actorUserId = '00000000-0000-4000-8000-000000000001';
  const cookie = 'synthetic-auth-credential';
  const supportToken = 'synthetic-support-secret';
  const sensitiveInput = 'private-customer-input';

  beforeEach(async () => {
    controllerCalled.mockClear();
    const auth = new FakeAuthStore();
    auth.users.push(aUser({ id: actorUserId }));
    await auth.createSession(aSession({ userId: actorUserId, tokenHash: hashToken(cookie) }));
    const roles = new FakePlatformRoleStore();
    roles.grant(actorUserId, 'SUPPORT_ADMIN');
    audit = new FakeAuditStore();
    const module = await Test.createTestingModule({
      controllers: [ProtectedController],
      providers: [
        SessionGuard,
        { provide: AUTH_STORE, useValue: auth },
        { provide: PLATFORM_ROLE_STORE, useValue: roles },
        { provide: AUDIT_STORE, useValue: audit },
        { provide: TERMS_VERSION, useValue: '2026-10-01' },
        { provide: APP_FILTER, useClass: AuthExceptionFilter },
      ],
    }).compile();
    app = module.createNestApplication();
    await app.init();
  });

  afterEach(async () => {
    await app?.close();
    vi.restoreAllMocks();
  });

  it.each([
    '/organizations/00000000-0000-4000-8000-000000000002/campaigns',
    '/platform/support/sessions',
  ])('denies %s and logs a safe structured error when denial auditing fails', async (path) => {
    vi.spyOn(audit, 'recordIdentity').mockRejectedValue(new Error(sensitiveInput));
    const log = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const before = Date.now();

    const response = await request(app.getHttpServer())
      .post(`${path}?query=${sensitiveInput}`)
      .set('cookie', `tv_session=${cookie}`)
      .set('x-support-access-token', supportToken)
      .send({ name: sensitiveInput });

    expect(response.status).toBe(403);
    expect(controllerCalled).not.toHaveBeenCalled();
    expect(audit.recordIdentity).toHaveBeenCalledWith({
      actorUserId,
      action: 'platform.support.access_denied',
      outcome: 'DENIED',
      metadata: { reason: 'support_context_route_not_allowed' },
    });
    expect(log).toHaveBeenCalledTimes(1);
    const message = log.mock.calls[0]![0] as string;
    const event = JSON.parse(message);
    expect(event).toEqual({
      event: 'support_access_denial_audit_failed',
      actorUserId,
      reasonCode: 'support_context_route_not_allowed',
      occurredAt: expect.any(String),
    });
    expect(new Date(event.occurredAt).toISOString()).toBe(event.occurredAt);
    expect(Date.parse(event.occurredAt)).toBeGreaterThanOrEqual(before);
    expect(Date.parse(event.occurredAt)).toBeLessThanOrEqual(Date.now());
    for (const secret of [cookie, supportToken, sensitiveInput, 'owner@example.invalid']) {
      expect(message).not.toContain(secret);
    }
  });

  it('allows the same authenticated controller route without a support context', async () => {
    const response = await request(app.getHttpServer())
      .post('/platform/support/sessions')
      .set('cookie', `tv_session=${cookie}`);
    expect(response.status).toBe(201);
    expect(controllerCalled).toHaveBeenCalledTimes(1);
  });
});
