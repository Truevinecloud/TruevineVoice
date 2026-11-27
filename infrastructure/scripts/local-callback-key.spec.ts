import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { generateLocalCallbackKey, localCallbackKeyPath } from './local-callback-key.mjs';

const directories: string[] = [];

afterEach(() => {
  while (directories.length) rmSync(directories.pop() as string, { recursive: true, force: true });
});

describe('local callback credential generator', () => {
  it('generates a 32-byte credential without hardcoding its value', () => {
    const directory = mkdtempSync(join(tmpdir(), 'tv-local-callback-key-'));
    directories.push(directory);

    const path = localCallbackKeyPath(directory);
    expect(generateLocalCallbackKey(directory)).toBe(path);

    const first = readFileSync(path, 'utf8').trim();
    expect(first).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(Buffer.from(first, 'base64url')).toHaveLength(32);
  });

  it('preserves an existing credential unless explicitly forced', () => {
    const directory = mkdtempSync(join(tmpdir(), 'tv-local-callback-key-'));
    directories.push(directory);

    const path = generateLocalCallbackKey(directory);
    const first = readFileSync(path, 'utf8');
    expect(generateLocalCallbackKey(directory)).toBe(path);
    expect(readFileSync(path, 'utf8')).toBe(first);

    generateLocalCallbackKey(directory, { force: true });
    expect(readFileSync(path, 'utf8')).not.toBe(first);
  });
});
