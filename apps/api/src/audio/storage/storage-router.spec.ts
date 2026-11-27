import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { StorageRouter } from './storage-router.js';

describe('StorageRouter', () => {
  const originalBackend = process.env.AUDIO_STORAGE_BACKEND;

  beforeEach(() => {
    delete process.env.AUDIO_STORAGE_BACKEND;
  });

  afterEach(() => {
    if (originalBackend === undefined) delete process.env.AUDIO_STORAGE_BACKEND;
    else process.env.AUDIO_STORAGE_BACKEND = originalBackend;
  });

  it('defaults to PostgreSQL when backend is unset', () => {
    const router = new StorageRouter({} as never, null, {} as never);
    expect(router.isAvailable()).toBe(true);
  });

  it('selects PostgreSQL explicitly', () => {
    process.env.AUDIO_STORAGE_BACKEND = 'POSTGRESQL';
    const router = new StorageRouter({} as never, null, {} as never);
    expect(router.isAvailable()).toBe(true);
  });

  it('selects S3 explicitly', () => {
    process.env.AUDIO_STORAGE_BACKEND = 'S3';
    const router = new StorageRouter({} as never, { putObject: vi.fn() } as never, {} as never);
    expect(router.isAvailable()).toBe(true);
  });

  it('rejects invalid backend values', () => {
    process.env.AUDIO_STORAGE_BACKEND = 'FOO';
    const router = new StorageRouter({} as never, null, {} as never);
    expect(router.isAvailable()).toBe(false);
  });

  it('routes a nested storage key by the final path segment', async () => {
    const getObject = vi
      .fn()
      .mockResolvedValue({ body: new Uint8Array([1]), contentType: 'audio/wav' });
    const findUnique = vi.fn().mockResolvedValue({ storageBackend: 'POSTGRESQL' });
    const router = new StorageRouter(
      { getObject } as never,
      null,
      { audioAsset: { findUnique } } as never,
    );

    const result = await router.getObject('org-id/audio/asset-id.wav');

    expect(findUnique).toHaveBeenCalledWith({
      where: { organizationId_id: { organizationId: 'org-id', id: 'asset-id' } },
      select: { storageBackend: true },
    });
    expect(getObject).toHaveBeenCalledWith('org-id/audio/asset-id.wav');
    expect(result.body.byteLength).toBe(1);
  });

  it('reports unavailable when selected backend is missing', async () => {
    process.env.AUDIO_STORAGE_BACKEND = 'S3';
    const router = new StorageRouter({} as never, null, {} as never);
    await expect(router.putObject({ key: 'org/asset.mp3', body: new Uint8Array([1]), contentType: 'audio/mpeg' })).rejects.toThrow('S3 storage not configured');
  });
});