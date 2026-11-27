import { describe, expect, it } from 'vitest';

import {
  DEFAULT_ALERT_RULES,
  diskFreePercent,
  memoryUsedPercent,
  type QueueDepthSample,
} from './metrics.js';

describe('metrics types and helpers', () => {
  it('memoryUsedPercent computes correctly', () => {
    expect(memoryUsedPercent(1000, 300)).toBe(70);
    expect(memoryUsedPercent(1000, 1000)).toBe(0);
    expect(memoryUsedPercent(1000, 0)).toBe(100);
    expect(memoryUsedPercent(undefined, 300)).toBeUndefined();
    expect(memoryUsedPercent(1000, undefined)).toBeUndefined();
    expect(memoryUsedPercent(0, 300)).toBeUndefined();
  });

  it('diskFreePercent computes correctly', () => {
    expect(diskFreePercent(1000, 200)).toBe(20);
    expect(diskFreePercent(1000, 1000)).toBe(100);
    expect(diskFreePercent(1000, 0)).toBe(0);
    expect(diskFreePercent(undefined, 200)).toBeUndefined();
    expect(diskFreePercent(1000, undefined)).toBeUndefined();
  });

  it('DEFAULT_ALERT_RULES are defined with expected rules', () => {
    expect(DEFAULT_ALERT_RULES.length).toBeGreaterThan(0);
    const names = DEFAULT_ALERT_RULES.map((r) => r.name);
    expect(names).toContain('queue_depth_high');
    expect(names).toContain('host_cpu_high');
    expect(names).toContain('host_memory_high');
    expect(names).toContain('host_disk_low');
  });

  it('queue depth rule has warning and critical thresholds', () => {
    const rule = DEFAULT_ALERT_RULES.find((r) => r.name === 'queue_depth_high');
    expect(rule).toBeDefined();
    expect(rule?.warningThreshold).toBe(50);
    expect(rule?.criticalThreshold).toBe(100);
    expect(rule?.consecutiveBreaches).toBe(2);
    expect(rule?.sustainedForMs).toBe(60_000);
  });

  it('failed queue rule fires on first breach', () => {
    const rule = DEFAULT_ALERT_RULES.find((r) => r.name === 'queue_depth_critical');
    expect(rule).toBeDefined();
    expect(rule?.warningThreshold).toBe(5);
    expect(rule?.criticalThreshold).toBe(10);
    expect(rule?.consecutiveBreaches).toBe(1);
    expect(rule?.sustainedForMs).toBe(0);
  });
});

describe('QueueDepthSample type shape', () => {
  it('represents unavailable metrics as undefined', () => {
    const sample: QueueDepthSample = {
      status: 'unknown',
      timestamp: '2026-01-01T00:00:00.000Z',
      queueName: 'test-queue',
      waiting: undefined,
      active: undefined,
      delayed: undefined,
      failed: undefined,
      oldestWaitingAgeMs: undefined,
      error: 'queue unavailable',
    };

    expect(sample.waiting).toBeUndefined();
    expect(sample.active).toBeUndefined();
    expect(sample.delayed).toBeUndefined();
    expect(sample.failed).toBeUndefined();
    expect(sample.oldestWaitingAgeMs).toBeUndefined();
    expect(sample.status).toBe('unknown');
    expect(sample.error).toBe('queue unavailable');
  });
});
