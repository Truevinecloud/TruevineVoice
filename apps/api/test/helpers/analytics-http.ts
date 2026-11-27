import { type INestApplication } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { hashToken } from '@truevine/auth';

import { AnalyticsController } from '../../src/analytics/analytics.controller.js';
import { AnalyticsService, type AnalyticsReader } from '../../src/analytics/analytics.service.js';
import { ANALYTICS_READER } from '../../src/analytics/analytics.tokens.js';
import { AuthExceptionFilter } from '../../src/auth/auth-exception.filter.js';
import { CsrfGuard } from '../../src/auth/csrf.guard.js';
import { SESSION_COOKIE } from '../../src/auth/cookies.js';
import { OrganizationGuard } from '../../src/auth/organization.guard.js';
import {
  AUDIT_STORE,
  AUTH_STORE,
  ORGANIZATION_STORE,
  PLATFORM_ROLE_STORE,
  TERMS_VERSION,
} from '../../src/auth/tokens.js';
import type { MembershipRole } from '../../src/auth/prisma-types.js';
import { SessionGuard } from '../../src/auth/session.guard.js';
import {
  FakeAuditStore,
  FakeAuthStore,
  FakeOrganizationStore,
  FakePlatformRoleStore,
  aMembership,
  aSession,
  aUser,
} from '../fakes/auth.fakes.js';

/** Matches the value bound by AuthModule; kept local because it is not exported. */
const TERMS_VERSION_VALUE = '2026-10-01';

/**
 * Boots the real analytics controller, guards and exception filter.
 *
 * The authorization stores are in-memory fakes; the reader is supplied by each
 * suite so the same HTTP surface can be exercised with a stub or with the real
 * W5-03 adapter over the dedicated PostgreSQL database.
 */
export interface AnalyticsHttpHarness {
  readonly app: INestApplication;
  readonly auth: FakeAuthStore;
  readonly organizations: FakeOrganizationStore;
  readonly audit: FakeAuditStore;
}

export async function createAnalyticsHttpApp(
  reader: AnalyticsReader,
): Promise<AnalyticsHttpHarness> {
  const auth = new FakeAuthStore();
  const organizations = new FakeOrganizationStore();
  const audit = new FakeAuditStore();

  const module = await Test.createTestingModule({
    controllers: [AnalyticsController],
    providers: [
      AnalyticsService,
      { provide: ANALYTICS_READER, useValue: reader },
      SessionGuard,
      OrganizationGuard,
      CsrfGuard,
      { provide: AUTH_STORE, useValue: auth },
      { provide: ORGANIZATION_STORE, useValue: organizations },
      { provide: PLATFORM_ROLE_STORE, useValue: new FakePlatformRoleStore() },
      { provide: AUDIT_STORE, useValue: audit },
      { provide: TERMS_VERSION, useValue: TERMS_VERSION_VALUE },
      { provide: APP_FILTER, useClass: AuthExceptionFilter },
    ],
  }).compile();

  const app = module.createNestApplication();
  await app.init();
  return { app, auth, organizations, audit };
}

export interface SeedAnalyticsCallerInput {
  readonly organizationId: string;
  readonly userId: string;
  readonly email: string;
  readonly role?: MembershipRole;
  readonly token?: string;
}

/** Creates an accepted-terms session with membership in exactly one organization. */
export async function seedAnalyticsCaller(
  harness: AnalyticsHttpHarness,
  input: SeedAnalyticsCallerInput,
): Promise<string> {
  const token = input.token ?? `analytics-${input.userId}`;
  harness.auth.users.push(aUser({ id: input.userId, email: input.email }));
  await harness.auth.createSession(aSession({ userId: input.userId, tokenHash: hashToken(token) }));
  await harness.auth.recordTermsAcceptance(input.userId, TERMS_VERSION_VALUE);
  harness.organizations.organizations.push({
    id: input.organizationId,
    slug: `analytics-${input.userId}`,
    name: 'Analytics HTTP test organization',
    suspendedAt: null,
  });
  harness.organizations.memberships.push(
    aMembership({
      organizationId: input.organizationId,
      userId: input.userId,
      role: input.role ?? 'OWNER',
    }),
  );
  return `${SESSION_COOKIE}=${token}`;
}
