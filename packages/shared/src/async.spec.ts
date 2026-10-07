import { describe, expect, it } from 'vitest';

import { describeError, elapsedMs, withTimeout } from './async.js';

describe('describeError', () => {
  it('uses the message of an Error', () => {
    expect(describeError(new Error('connection refused'))).toBe('connection refused');
  });

  it('falls back to the error name when the message is empty', () => {
    expect(describeError(new TypeError())).toBe('TypeError');
  });

  it('passes strings through unchanged', () => {
    expect(describeError('boom')).toBe('boom');
  });

  it('serialises plain objects', () => {
    expect(describeError({ code: 'ECONNREFUSED' })).toBe('{"code":"ECONNREFUSED"}');
  });
});

describe('elapsedMs', () => {
  it('returns a non-negative rounded duration', () => {
    expect(elapsedMs(1_000, 1_250)).toBe(250);
    expect(elapsedMs(1_000, 999)).toBe(0);
  });
});

describe('withTimeout', () => {
  it('resolves when the promise settles in time', async () => {
    await expect(withTimeout(Promise.resolve('ok'), 50)).resolves.toBe('ok');
  });

  it('rejects with a timeout error when the promise is too slow', async () => {
    const slow = new Promise<string>((resolve) => setTimeout(() => resolve('late'), 5_000));
    await expect(withTimeout(slow, 10)).rejects.toThrow('Operation timed out after 10ms');
  });
});
