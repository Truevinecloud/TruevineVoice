import express, { type ErrorRequestHandler, type RequestHandler } from 'express';

import type { ApiConfig } from '../config/api.config.js';
import { hasJsonContentType, isLoopbackAddress } from './local-callback.shared.js';

function jsonError(status: number, code: string, message: string) {
  return { error: { code, message } };
}

/**
 * Route-specific parse guards, installed before the application's global JSON
 * body parser. Credential verification stays in the service/controller; this
 * layer only enforces loopback, media type, and the 16 KiB default size ceiling.
 */
export function localCallbackMiddleware(config: ApiConfig): ReadonlyArray<RequestHandler | ErrorRequestHandler> {
  const settings = config.localSyntheticCallback;
  if (!settings) {
    const disabled: RequestHandler = (_request, response) => {
      response.status(404).json(jsonError(404, 'not_found', 'Not found.'));
    };
    return [disabled];
  }

  const raw = express.raw({ type: () => true, limit: `${settings.bodyLimitBytes}b` });

  const guard: RequestHandler = (request, response, next) => {
    if (!isLoopbackAddress(request.socket?.remoteAddress)) {
      response.status(404).json(jsonError(404, 'not_found', 'Not found.'));
      return;
    }
    if (!hasJsonContentType(request.headers['content-type'])) {
      response.status(415).json(jsonError(415, 'unsupported_media_type', 'Unsupported content type.'));
      return;
    }
    next();
  };

  const tooLarge: ErrorRequestHandler = (error, _request, response, next) => {
    const status = (error as { status?: number; type?: string } | undefined)?.status;
    const type = (error as { type?: string } | undefined)?.type;
    if (status === 413 || type === 'entity.too.large') {
      response.status(413).json(jsonError(413, 'payload_too_large', 'Payload too large.'));
      return;
    }
    next(error);
  };

  return [guard, raw, tooLarge];
}
