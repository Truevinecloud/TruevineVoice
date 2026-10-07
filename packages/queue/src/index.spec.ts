import { describe, expect, it, vi } from 'vitest';

import {
  BULLMQ_MAX_RETRIES_PER_REQUEST,
  createBullConnection,
  createBullConnectionOptions,
  createRedisConnectionOptions,
  probeRedis,
} from './index.js';

describe('createRedisConnectionOptions', () => {
  it('sets the BullMQ-required maxRetriesPerRequest', () => {
    expect(createRedisConnectionOptions().maxRetriesPerRequest).toBe(
      BULLMQ_MAX_RETRIES_PER_REQUEST,
    );
  });

  it('connects lazily so that constructing a client cannot throw', () => {
    expect(createRedisConnectionOptions().lazyConnect).toBe(true);
  });

  it('caps the reconnect backoff', () => {
    const { retryStrategy } = createRedisConnectionOptions();

    expect(retryStrategy).toBeTypeOf('function');
    expect(retryStrategy?.(1)).toBe(200);
    expect(retryStrategy?.(1_000)).toBe(5_000);
  });
});

describe('createBullConnection', () => {
  it('reuses the supplied client instead of opening a second connection', () => {
    const client = { ping: vi.fn() } as never;

    expect(createBullConnection(client)).toEqual({ connection: client });
  });
});

describe('createBullConnectionOptions', () => {
  it('carries the url alongside the shared connection settings', () => {
    const { connection } = createBullConnectionOptions('redis://localhost:6379');

    expect(connection.url).toBe('redis://localhost:6379');
    expect(connection.maxRetriesPerRequest).toBe(null);
  });
});

describe('probeRedis', () => {
  it('reports "up" when PING succeeds', async () => {
    const client = { ping: vi.fn().mockResolvedValue('PONG') };

    const health = await probeRedis(client, 1_000);

    expect(health.status).toBe('up');
    expect(health.error).toBeUndefined();
  });

  it('reports "down" with a log-safe message when PING fails', async () => {
    const client = { ping: vi.fn().mockRejectedValue(new Error('READONLY replica')) };

    const health = await probeRedis(client, 1_000);

    expect(health.status).toBe('down');
    expect(health.error).toBe('READONLY replica');
  });

  it('reports "down" when the probe exceeds its timeout', async () => {
    const client = { ping: vi.fn().mockReturnValue(new Promise(() => {})) };

    const health = await probeRedis(client, 5);

    expect(health.status).toBe('down');
    expect(health.error).toContain('timed out');
  });
});
