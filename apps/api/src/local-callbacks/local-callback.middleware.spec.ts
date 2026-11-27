import express, { type RequestHandler } from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';

import type { ApiConfig } from '../config/api.config.js';
import { localCallbackMiddleware } from './local-callback.middleware.js';

function config(localSyntheticCallback: ApiConfig['localSyntheticCallback']) {
  return { localSyntheticCallback } as ApiConfig;
}

function appFor(middlewareConfig: ApiConfig, before?: RequestHandler) {
  const app = express();
  if (before) app.use(before);
  app.use(...localCallbackMiddleware(middlewareConfig));
  app.use((_request, response) => {
    response.status(200).json({ passed: true });
  });
  return app;
}

const enabled = config({ keyFile: 'unused-in-this-layer', bodyLimitBytes: 256 });

describe('local callback route guards', () => {
  it('returns 404 for the exact route when synthetic ingress is disabled', async () => {
    const response = await request(appFor(config(null)))
      .post('/local/callbacks/synthetic')
      .set('content-type', 'application/json')
      .send('{}');

    expect(response.status).toBe(404);
    expect(response.body).toEqual({
      error: { code: 'not_found', message: 'Not found.' },
    });
  });

  it('returns 404 for a non-loopback socket before any body is parsed', async () => {
    const app = appFor(enabled, (req, _response, next) => {
      Object.defineProperty(req.socket, 'remoteAddress', {
        value: '203.0.113.10',
        configurable: true,
      });
      next();
    });

    const response = await request(app)
      .post('/local/callbacks/synthetic')
      .set('content-type', 'application/json')
      .send('{}');

    expect(response.status).toBe(404);
    expect(response.body.error.code).toBe('not_found');
  });

  it('accepts IPv4-mapped loopback and exact application/json only', async () => {
    const app = appFor(enabled, (req, _response, next) => {
      Object.defineProperty(req.socket, 'remoteAddress', {
        value: '::ffff:127.0.0.1',
        configurable: true,
      });
      next();
    });

    const accepted = await request(app)
      .post('/local/callbacks/synthetic')
      .set('content-type', 'application/json')
      .send('{}');
    expect(accepted.status).toBe(200);
    expect(accepted.body).toEqual({ passed: true });

    const parameterized = await request(app)
      .post('/local/callbacks/synthetic')
      .set('content-type', 'application/json; charset=utf-8')
      .send('{}');
    expect(parameterized.status).toBe(415);
    expect(parameterized.body.error.code).toBe('unsupported_media_type');
  });

  it('maps the raw parser size ceiling to a 413 without reaching the handler', async () => {
    const app = appFor(config({ keyFile: 'unused', bodyLimitBytes: 16 }));

    const response = await request(app)
      .post('/local/callbacks/synthetic')
      .set('content-type', 'application/json')
      .send('{"sessionId":"0123456789abcdefghijklmnop"}');

    expect(response.status).toBe(413);
    expect(response.body.error.code).toBe('payload_too_large');
  });
});
