/**
 * Translates {@link AuthError} into an HTTP response.
 *
 * The status lives on the error rather than at each call site, because "is this
 * 401 or 403?" is a security decision and scattering it across a dozen services
 * is how the same failure starts answering differently depending on which
 * controller happened to reach it first.
 *
 * The body shape is stable: `{ error: { code, message } }`. `code` is what
 * clients branch on. `message` is written for a human and, by the discipline in
 * `@truevine/auth`, contains no SQL, no stack and no information about whether
 * an account exists.
 */

import {
  Catch,
  HttpException,
  HttpStatus,
  type ArgumentsHost,
  type ExceptionFilter,
} from '@nestjs/common';
import { AuthError } from '@truevine/auth';
import type { Response } from 'express';

interface ErrorBody {
  readonly error: {
    readonly code: string;
    readonly message: string;
  };
}

/** Maps every {@link AuthError} onto its declared status. */
@Catch(AuthError)
export class AuthExceptionFilter implements ExceptionFilter {
  catch(exception: AuthError, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<Response>();
    const body: ErrorBody = {
      error: { code: exception.code, message: exception.message },
    };

    response.status(exception.status as HttpStatus).json(body);
  }
}

/**
 * Converts an `AuthError` for `throw` sites outside the filter's reach.
 *
 * Used by the guards, which run inside the Nest pipeline but throw before any
 * controller, so the filter still catches them.
 */
export function toHttpException(error: AuthError): HttpException {
  return new HttpException(
    { error: { code: error.code, message: error.message } },
    error.status as HttpStatus,
  );
}
