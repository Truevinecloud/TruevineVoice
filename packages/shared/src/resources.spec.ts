import { describe, expect, it } from 'vitest';

import {
  sampleCpuLoad,
  sampleHostResources,
  sampleMemory,
  sampleDisk,
  type CpuLoadSample,
  type DiskSample,
  type HostResourceSample,
  type MemorySample,
} from './resources.js';

import { diskFreePercent, memoryUsedPercent } from './metrics.js';

describe('host resource monitoring', () => {
  describe('sampleCpuLoad', () => {
    it('returns a valid CpuLoadSample', () => {
      const sample = sampleCpuLoad();

      expect(sample.load1).toBeGreaterThanOrEqual(0);
      expect(sample.load5).toBeGreaterThanOrEqual(0);
      expect(sample.load15).toBeGreaterThanOrEqual(0);
      expect(sample.cpuCount).toBeGreaterThan(0);
      if (sample.loadPercent !== undefined) {
        expect(sample.loadPercent).toBeGreaterThanOrEqual(0);
      }
    });

    it('has correct type shape', () => {
      const sample: CpuLoadSample = sampleCpuLoad();
      expect(typeof sample.load1).toBe('number');
      expect(typeof sample.cpuCount).toBe('number');
    });
  });

  describe('sampleMemory', () => {
    it('returns a valid MemorySample', () => {
      const sample = sampleMemory();

      expect(sample.totalBytes).toBeGreaterThan(0);
      expect(sample.freeBytes).toBeGreaterThanOrEqual(0);
      expect(sample.usedBytes).toBeGreaterThanOrEqual(0);
      expect(sample.usedPercent).toBeGreaterThanOrEqual(0);
      expect(sample.usedPercent).toBeLessThanOrEqual(100);
      expect(sample.totalBytes).toBe(sample.freeBytes + sample.usedBytes);
    });

    it('has correct type shape', () => {
      const sample: MemorySample = sampleMemory();
      expect(typeof sample.totalBytes).toBe('number');
      expect(typeof sample.usedPercent).toBe('number');
    });
  });

  describe('sampleDisk', () => {
    it('returns undefined or a valid DiskSample', async () => {
      const result = await sampleDisk('/');

      // fs.statfs may be unavailable in some environments, so disk may be undefined.
      // On supported platforms, it should return a valid sample.
      if (result !== undefined) {
        expect(result.mount).toBe('/');
        expect(result.totalBytes).toBeGreaterThan(0);
        expect(result.freeBytes).toBeGreaterThanOrEqual(0);
        expect(result.usedBytes).toBeGreaterThanOrEqual(0);
        expect(result.freePercent).toBeGreaterThanOrEqual(0);
        expect(result.freePercent).toBeLessThanOrEqual(100);
      }
    });

    it('has correct type shape when defined', async () => {
      const result: DiskSample | undefined = await sampleDisk('/');
      if (result !== undefined) {
        expect(typeof result.totalBytes).toBe('number');
        expect(typeof result.freePercent).toBe('number');
      }
    });

    it('returns undefined for unavailable mount', async () => {
      const result = await sampleDisk('/nonexistent-mount-xyz');
      expect(result).toBeUndefined();
    });
  });

  describe('sampleHostResources', () => {
    it('returns a complete HostResourceSample', async () => {
      const sample = await sampleHostResources('/');

      expect(sample.cpu).toBeDefined();
      expect(sample.memory).toBeDefined();
      // Disk may be undefined in constrained environments.
      if (sample.disk !== undefined) {
        expect(sample.disk.mount).toBe('/');
      }
    });

    it('has correct type shape', async () => {
      const sample: HostResourceSample = await sampleHostResources('/');
      expect(typeof sample.cpu.load1).toBe('number');
      expect(typeof sample.memory.totalBytes).toBe('number');
    });
  });

  describe('memoryUsedPercent', () => {
    it('computes correctly', () => {
      expect(memoryUsedPercent(1000, 300)).toBe(70);
      expect(memoryUsedPercent(1000, 1000)).toBe(0);
      expect(memoryUsedPercent(undefined, 300)).toBeUndefined();
      expect(memoryUsedPercent(1000, undefined)).toBeUndefined();
    });
  });

  describe('diskFreePercent', () => {
    it('computes correctly', () => {
      expect(diskFreePercent(1000, 200)).toBe(20);
      expect(diskFreePercent(1000, 1000)).toBe(100);
      expect(diskFreePercent(undefined, 200)).toBeUndefined();
      expect(diskFreePercent(1000, undefined)).toBeUndefined();
    });
  });
});
