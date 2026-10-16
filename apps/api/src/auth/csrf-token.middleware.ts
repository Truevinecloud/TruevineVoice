/**
 * Issues the CSRF cookie.
 *
 * The token has to exist BEFORE the first mutation, and the first mutation for
 * an anonymous visitor is sign-in. So it cannot be handed out by the sign-in
 * response - by then it is needed. This middleware sets one on any request that
 * arrives without it.
 *
 * The cookie is deliberately readable by script (`httpOnly: false`). That is what
 * makes the double-submit pattern work: the client reads the value and echoes it
 * in a header. A cross-site attacker can cause the browser to send the cookie but
 * cannot read it, so it cannot construct the header.
 *
 * Applied as module middleware rather than in `main.ts` so that it is active in
 * the end-to-end suite too. Middleware wired only in the bootstrap file is
 * middleware the tests do not exercise, which is middleware that can silently
 * stop being applied.
 */

import { Injectable, type NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';

import { CSRF_COOKIE, CSRF_COOKIE_OPTIONS, generateCsrfToken, readCsrfToken } from './cookies.js';

@Injectable()
export class CsrfTokenMiddleware implements NestMiddleware {
  use(request: Request, response: Response, next: NextFunction): void {
    if (!readCsrfToken(request)) {
      response.cookie(CSRF_COOKIE, generateCsrfToken(), CSRF_COOKIE_OPTIONS);
    }

    next();
  }
}
