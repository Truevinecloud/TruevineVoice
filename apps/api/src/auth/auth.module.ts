/**
 * Authentication and authorization module.
 *
 * Exports the guards and the permission decorators rather than the stores, so
 * other modules depend on the *mechanism* for authorization and never reach into
 * a persistence implementation. AGENTS.md 3 requires cross-module access to go
 * through exported providers.
 *
 * The store implementations are bound here and nowhere else. Swapping Prisma for
 * something else means changing this module's providers and nothing else.
 */

import { MiddlewareConsumer, Module, RequestMethod, type NestModule } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';

import { InfrastructureModule } from '../infrastructure/infrastructure.module.js';

import { AuthController } from './auth.controller.js';
import { AuthExceptionFilter } from './auth-exception.filter.js';
import { AuthService } from './auth.service.js';
import { CsrfGuard } from './csrf.guard.js';
import { CsrfTokenMiddleware } from './csrf-token.middleware.js';
import { OrganizationGuard, PlatformGuard } from './organization.guard.js';
import {
  PrismaAuditStore,
  PrismaAuthStore,
  PrismaOrganizationStore,
  PrismaPlatformRoleStore,
  PrismaProvisioningStore,
} from './prisma-stores.js';
import { RedisRateLimiter } from './rate-limiter.js';
import { SessionGuard } from './session.guard.js';
import {
  AUDIT_STORE,
  AUTH_STORE,
  ORGANIZATION_STORE,
  PASSWORD_RESET_COOLDOWN_MS,
  PLATFORM_ROLE_STORE,
  PROVISIONING_STORE,
  RATE_LIMITER,
  SIGN_IN_FAILURE_LIMIT,
  SIGN_IN_LOCKOUT_MS,
  TERMS_VERSION,
} from './tokens.js';

/**
 * Security-relevant constants.
 *
 * Declared here rather than in environment variables because none of them is a
 * secret, and a value that silently changed with a deployment would change
 * security behaviour without appearing in a diff. Changing one is a code change.
 */
const DEFAULT_SIGN_IN_FAILURE_LIMIT = 5;
const DEFAULT_SIGN_IN_LOCKOUT_MS = 15 * 60 * 1_000;
const DEFAULT_PASSWORD_RESET_COOLDOWN_MS = 60 * 1_000;

/**
 * The terms version a user must have accepted.
 *
 * Bumping this string is what makes previously-accepted terms insufficient: the
 * acceptance table is keyed by (user, version), so a new version requires a new
 * acceptance rather than inheriting the old one.
 */
const CURRENT_TERMS_VERSION = '2026-10-01';

@Module({
  // Explicit, even though `InfrastructureModule` is `@Global()`. Relying on a
  // global provider being registered before this module is initialised is an
  // ordering assumption, and it fails in a testing module that overrides the
  // client. Declaring the import states the dependency instead of implying it.
  imports: [InfrastructureModule],
  controllers: [AuthController],
  providers: [
    { provide: AUTH_STORE, useClass: PrismaAuthStore },
    { provide: ORGANIZATION_STORE, useClass: PrismaOrganizationStore },
    { provide: PLATFORM_ROLE_STORE, useClass: PrismaPlatformRoleStore },
    { provide: AUDIT_STORE, useClass: PrismaAuditStore },
    { provide: PROVISIONING_STORE, useClass: PrismaProvisioningStore },
    { provide: RATE_LIMITER, useClass: RedisRateLimiter },
    { provide: SIGN_IN_FAILURE_LIMIT, useValue: DEFAULT_SIGN_IN_FAILURE_LIMIT },
    { provide: SIGN_IN_LOCKOUT_MS, useValue: DEFAULT_SIGN_IN_LOCKOUT_MS },
    { provide: PASSWORD_RESET_COOLDOWN_MS, useValue: DEFAULT_PASSWORD_RESET_COOLDOWN_MS },
    { provide: TERMS_VERSION, useValue: CURRENT_TERMS_VERSION },

    AuthService,
    SessionGuard,
    OrganizationGuard,
    PlatformGuard,
    CsrfGuard,
    CsrfTokenMiddleware,
    // Bound with `APP_FILTER`, not merely listed in `providers`. A `@Catch()`
    // class sitting in the provider array is never applied by Nest: it has to be
    // bound to the filter slot, or the exception reaches the default handler and
    // every `AuthError` returns 500 instead of the 401 or 403 it declared.
    { provide: APP_FILTER, useClass: AuthExceptionFilter },
  ],
  exports: [
    AuthService,
    SessionGuard,
    OrganizationGuard,
    PlatformGuard,
    CsrfGuard,
    AUTH_STORE,
    ORGANIZATION_STORE,
    PLATFORM_ROLE_STORE,
    AUDIT_STORE,
    PROVISIONING_STORE,
    TERMS_VERSION,
  ],
})
export class AuthModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(CsrfTokenMiddleware).forRoutes({ path: '*path', method: RequestMethod.ALL });
  }
}
