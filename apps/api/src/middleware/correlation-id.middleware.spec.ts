import type { Request, Response } from 'express';
import { describe, expect, it } from 'vitest';

import { correlationIdMiddleware, CORRELATION_ID_HEADER } from './correlation-id.middleware.js';

describe('correlation ID middleware', () => {
  it('generates a correlation ID when none is provided', async () => {
    const middleware = correlationIdMiddleware();
    const req = {
      headers: {},
    } as unknown as Request;
    const res = {
      setHeader: () => undefined,
      on: () => undefined,
    } as unknown as Response;
    let nextCalled = false;
    const next = () => {
      nextCalled = true;
    };

    await new Promise<void>((resolve) => {
      middleware(req, res, next as () => void);
      resolve();
    });

    expect(nextCalled).toBe(true);
  });

  it('propagates an incoming correlation ID', () => {
    const middleware = correlationIdMiddleware();
    const incomingId = 'existing-correlation-id-123';
    const req = {
      headers: { [CORRELATION_ID_HEADER]: incomingId },
    } as unknown as Request;
    let capturedHeader: string | undefined;
    const res = {
      setHeader: (name: string, value: string) => {
        if (name === CORRELATION_ID_HEADER) capturedHeader = value;
      },
      on: () => undefined,
    } as unknown as Response;
    let nextCalled = false;

    middleware(req, res, () => {
      nextCalled = true;
    });

    expect(nextCalled).toBe(true);
    expect(capturedHeader).toBe(incomingId);
  });

  it('sets the correlation ID response header', () => {
    const middleware = correlationIdMiddleware();
    const req = { headers: {} } as unknown as Request;
    let capturedHeader: string | undefined;
    const res = {
      setHeader: (name: string, value: string) => {
        if (name === CORRELATION_ID_HEADER) capturedHeader = value;
      },
      on: () => undefined,
    } as unknown as Response;

    middleware(req, res, () => {});

    expect(capturedHeader).toBeDefined();
    expect(capturedHeader).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });

  it('clears context after response finishes', () => {
    const middleware = correlationIdMiddleware();
    const req = { headers: {} } as unknown as Request;
    let finishHandler: (() => void) | undefined;
    const res = {
      setHeader: () => undefined,
      on: (event: string, handler: () => void) => {
        if (event === 'finish') finishHandler = handler;
      },
    } as unknown as Response;

    middleware(req, res, () => {});

    expect(finishHandler).toBeDefined();
    finishHandler!();
  });
});
