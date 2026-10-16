/**
 * Unauthenticated endpoints: sign in, sign out, password reset, terms.
 *
 * These are the only routes that do not require a session, which is why each one
 * carries an explicit note about what it does *not* leak. Together they are the
 * entire account-recovery surface, and it is small on purpose: there is no
 * public registration and no way to create an account from outside. The first
 * Organization Owner is provisioned by an operator script, because a public
 * sign-up endpoint would let anybody become the owner of a new tenant.
 *
 * Controllers here own HTTP only: routing, status codes, cookies and
 * serialisation. Every decision lives in `AuthService`.
 */

import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  Post,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
// From `express`, NOT from `@nestjs/common`: `@nestjs/common` does not export
// these, and importing them from there silently falls back to the global
// `Request`/`Response` that @types/node declares, which have no `.ip` and no
// `.cookie`. The symptom is a wall of "Property 'ip' does not exist" that looks
// like a missing dependency rather than a missing import.
import type { Request, Response } from 'express';

import { AuthService } from './auth.service.js';
import { CsrfGuard } from './csrf.guard.js';
import {
  CSRF_COOKIE,
  CSRF_COOKIE_OPTIONS,
  SESSION_COOKIE,
  SESSION_COOKIE_OPTIONS,
  clearedCookieOptions,
  hashUserAgent,
  ipPrefixOf,
} from './cookies.js';
import { CurrentPrincipal } from './permission.decorators.js';
import type { Principal } from './principal.js';
import { SessionGuard } from './session.guard.js';
import { TERMS_VERSION } from './tokens.js';
import { ORGANIZATION_ROLES, isValidEmail, type OrganizationRole } from '@truevine/auth';

/** Request bodies, validated here so the service can assume well-formed input. */
interface SignInBody {
  readonly email?: unknown;
  readonly password?: unknown;
}

interface PasswordResetBody {
  readonly email?: unknown;
}

interface PasswordResetCompleteBody {
  readonly token?: unknown;
  readonly newPassword?: unknown;
}

/** Runs the same cheap checks the service needs, without leaking which failed. */
function readString(body: { [key: string]: unknown }, key: string): string {
  const value = body[key];
  return typeof value === 'string' ? value : '';
}

@Controller('auth')
export class AuthController {
  constructor(
    @Inject(AuthService) private readonly authService: AuthService,
    @Inject(TERMS_VERSION) private readonly termsVersion: string,
  ) {}

  /**
   * `POST /auth/sign-in`
   *
   * On success the session token is set as an HTTP-only cookie and the CSRF token
   * as a readable one. The raw session token is never in the response body: a
   * body is readable by script, and an HTTP-only cookie is not.
   */
  @Post('sign-in')
  @HttpCode(HttpStatus.OK)
  @UseGuards(CsrfGuard)
  async signIn(
    @Body() body: SignInBody,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<{ readonly ok: true }> {
    const result = await this.authService.signIn(
      readString(body as Record<string, unknown>, 'email'),
      readString(body as Record<string, unknown>, 'password'),
      {
        ipPrefix: ipPrefixOf(request.ip),
        userAgentHash: hashUserAgent(request.headers['user-agent']),
      },
    );

    response.cookie(SESSION_COOKIE, result.sessionToken, SESSION_COOKIE_OPTIONS);
    response.cookie(CSRF_COOKIE, result.csrfToken, CSRF_COOKIE_OPTIONS);

    return { ok: true };
  }

  /**
   * `POST /auth/sign-out`
   *
   * Always 204, whether or not a session existed. Reporting "you were not signed
   * in" would confirm which cookies are live.
   */
  @Post('sign-out')
  @HttpCode(HttpStatus.NO_CONTENT)
  @UseGuards(CsrfGuard)
  async signOut(
    @CurrentPrincipal() principal: Principal,
    @Res({ passthrough: true }) response: Response,
  ): Promise<void> {
    await this.authService.signOut(principal.sessionId);

    // Clear both cookies. A signed-out browser holding a valid-looking session
    // cookie is the state that produces confusing "am I logged in?" behaviour.
    response.clearCookie(SESSION_COOKIE, clearedCookieOptions(SESSION_COOKIE_OPTIONS));
    response.clearCookie(CSRF_COOKIE, clearedCookieOptions(CSRF_COOKIE_OPTIONS));
  }

  /**
   * `POST /auth/password-reset/request`
   *
   * Always 202 with the same body, whether or not the address exists. A 404 here
   * would be an account-existence oracle, and this endpoint is unauthenticated.
   */
  @Post('password-reset/request')
  @HttpCode(HttpStatus.ACCEPTED)
  @UseGuards(CsrfGuard)
  async requestPasswordReset(
    @Body() body: PasswordResetBody,
    @Req() request: Request,
  ): Promise<{ readonly accepted: true }> {
    await this.authService.requestPasswordReset(
      readString(body as Record<string, unknown>, 'email'),
      { ipPrefix: ipPrefixOf(request.ip), userAgentHash: null },
    );

    return { accepted: true };
  }

  /** `POST /auth/password-reset/complete` */
  @Post('password-reset/complete')
  @HttpCode(HttpStatus.OK)
  @UseGuards(CsrfGuard)
  async completePasswordReset(
    @Body() body: PasswordResetCompleteBody,
    @Res({ passthrough: true }) response: Response,
  ): Promise<{ readonly ok: true }> {
    await this.authService.completePasswordReset(
      readString(body as Record<string, unknown>, 'token'),
      readString(body as Record<string, unknown>, 'newPassword'),
    );

    // Every session was destroyed by the reset, so the browser is signed out and
    // needs a fresh CSRF token for its next mutation.
    response.clearCookie(SESSION_COOKIE, clearedCookieOptions(SESSION_COOKIE_OPTIONS));

    return { ok: true };
  }

  /**
   * `POST /auth/terms/accept`
   *
   * Requires a session but not membership: terms apply to the person, not to a
   * tenant, and a user with no organization still has to accept them.
   */
  @Post('terms/accept')
  @HttpCode(HttpStatus.NO_CONTENT)
  @UseGuards(SessionGuard, CsrfGuard)
  async acceptTerms(
    @CurrentPrincipal() principal: Principal,
    @Req() request: Request,
  ): Promise<void> {
    await this.authService.acceptTerms(principal.userId, this.termsVersion, ipPrefixOf(request.ip));
  }

  /**
   * `GET /auth/terms`
   *
   * Unauthenticated on purpose: the terms must be readable by somebody who has
   * not signed in, which is the point of asking somebody to accept them.
   */
  @Get('terms')
  async currentTerms(): Promise<{ readonly version: string; readonly url: string }> {
    return {
      version: this.termsVersion,
      // No document exists yet. Reporting a version without a URL to read is
      // honest; inventing a link to a page that is not there is not.
      url: '',
    };
  }
}

/** Roles the sign-in screen may present. Exposed so the client cannot drift. */
export const ASSIGNABLE_ORGANIZATION_ROLES: readonly OrganizationRole[] = ORGANIZATION_ROLES;

export { isValidEmail };
