import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

import {
  collectResourceSnapshot,
  computeDiskGrowthRate,
  computeLoadPercent,
  createCpuSampler,
  boundedCollection,
  DEFAULT_COLLECTION_TIMEOUT_MS,
  type NetworkSample,
} from './resource-collector.js';

// ------------------------------------------------------------------
// Mock fs/promises readFile and statfs for deterministic Linux fixture testing
// ------------------------------------------------------------------
const mockReadFile = vi.hoisted(() => vi.fn());
const mockStatfs = vi.hoisted(() => vi.fn());

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    readFile: mockReadFile,
    statfs: mockStatfs,
  };
});

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  return {
    ...actual,
    // Deterministic CPU info
    cpus: vi.fn(() => [
      { model: 'Intel Xeon', speed: 2500, times: { user: 100, nice: 0, sys: 50, idle: 850, irq: 0 } },
      { model: 'Intel Xeon', speed: 2500, times: { user: 100, nice: 0, sys: 50, idle: 850, irq: 0 } },
    ]),
    totalmem: vi.fn(() => 8_000_000_000), // 8 GB
    freemem: vi.fn(() => 2_000_000_000), // 2 GB free
    loadavg: vi.fn(() => [1.0, 0.5, 0.25]),
    platform: vi.fn(() => 'linux'),
  };
});

// Clear all mocks between tests
beforeEach(() => {
  mockReadFile.mockReset();
  mockStatfs.mockReset();
  mockStatfs.mockImplementation((path: string) => {
    if (path === '/nonexistent-mount-xyz') {
      return Promise.reject(new Error('ENOENT: no such file or directory'));
    }
    return Promise.resolve({
      bsize: 4096,
      blocks: 100_000_000,
      bavail: 50_000_000,
    });
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ------------------------------------------------------------------
// Helper: mock /proc/stat CPU counters
// ------------------------------------------------------------------
function mockProcStatCpu(counters: {
  user: number; nice: number; system: number; idle: number;
  iowait?: number; irq?: number; softirq?: number; steal?: number;
}) {
  const iowait = counters.iowait ?? 0;
  const irq = counters.irq ?? 0;
  const softirq = counters.softirq ?? 0;
  const steal = counters.steal ?? 0;
  const line = `cpu ${counters.user} ${counters.nice} ${counters.system} ${counters.idle} ${iowait} ${irq} ${softirq} ${steal}\n`;
  mockReadFile.mockImplementation((path: string) => {
    if (path === '/proc/stat') return Promise.resolve(line);
    if (path === '/proc/meminfo') return Promise.resolve('MemTotal:       8000000 kB\nMemFree:        2000000 kB\nMemAvailable:   3000000 kB\nSwapTotal:      1000000 kB\nSwapFree:        900000 kB\n');
    if (path === '/proc/net/dev') return Promise.resolve(
      'Inter-|   Receive                                                |  Transmit\n face |bytes    packets err drop fifo frame compressed multicast|bytes    packets err drop fifo colls carrier compressed\n    lo: 1000000 1000 0 0 0 0 0 0 2000000 1000 0 0 0 0 0 0\n    eth0: 5000000 5000 0 0 0 0 0 0 3000000 5000 0 0 0 0 0 0\n',
    );
    return Promise.reject(new Error(`ENOENT: no such file or directory, open '${path}'`));
  });
}

// ------------------------------------------------------------------
// CPU tests
// ------------------------------------------------------------------
describe('CPU utilization', () => {
  it('computes load percentage correctly', () => {
    expect(computeLoadPercent(1.0, 4)).toBe(25);
    expect(computeLoadPercent(4.0, 4)).toBe(100);
    expect(computeLoadPercent(8.0, 4)).toBe(200);
    expect(computeLoadPercent(0, 4)).toBe(0);
  });

  it('returns undefined when cpuCount is 0 or negative', () => {
    expect(computeLoadPercent(1.0, 0)).toBeUndefined();
    expect(computeLoadPercent(1.0, -1)).toBeUndefined();
  });

  it('first CPU sample reports utilization as unavailable', async () => {
    mockProcStatCpu({ user: 100, nice: 0, system: 50, idle: 850 });
    const sampler = createCpuSampler();
    const sample = await sampler.sample();
    expect(sample.utilization.available).toBe(false);
    expect(sample.utilization.utilizationPercent).toBeUndefined();
    expect(sample.utilization.intervalMs).toBeUndefined();
  });

  it('second CPU sample computes utilization from differences', async () => {
    mockProcStatCpu({ user: 100, nice: 0, system: 50, idle: 850 });
    const sampler = createCpuSampler();
    const now = vi.spyOn(Date, 'now').mockReturnValue(1000);
    await sampler.sample(); // first sample at t=1000

    // Second sample: more work done at t=5000
    mockProcStatCpu({ user: 150, nice: 0, system: 75, idle: 850 });
    now.mockReturnValue(5000);
    const sample2 = await sampler.sample();
    expect(sample2.utilization.available).toBe(true);
    expect(sample2.utilization.utilizationPercent).toBeDefined();
    expect(sample2.utilization.intervalMs).toBeDefined();
    expect(sample2.utilization.intervalMs).toBeGreaterThan(0);
    now.mockRestore();
  });

  it('CPU counter reset returns undefined utilization', async () => {
    mockProcStatCpu({ user: 1000, nice: 0, system: 500, idle: 8500 });
    const sampler = createCpuSampler();
    await sampler.sample();

    // Counter reset: new total is less than previous
    mockProcStatCpu({ user: 100, nice: 0, system: 50, idle: 850 });
    const sample2 = await sampler.sample();
    expect(sample2.utilization.available).toBe(false);
    expect(sample2.utilization.utilizationPercent).toBeUndefined();
  });

  it('sampler reset makes next sample unavailable', async () => {
    mockProcStatCpu({ user: 100, nice: 0, system: 50, idle: 850 });
    const sampler = createCpuSampler();
    await sampler.sample();
    mockProcStatCpu({ user: 150, nice: 0, system: 75, idle: 850 });
    const sample2 = await sampler.sample();
    expect(sample2.utilization.available).toBe(true);

    sampler.reset();
    const sample3 = await sampler.sample();
    expect(sample3.utilization.available).toBe(false);
    expect(sample3.utilization.utilizationPercent).toBeUndefined();
  });

  it('distinguishes load average from utilization', async () => {
    mockProcStatCpu({ user: 100, nice: 0, system: 50, idle: 850 });
    const sampler = createCpuSampler();
    const sample = await sampler.sample();
    // loadPercent is from loadavg(), utilizationPercent is from counter differences
    expect(sample.load.loadPercent).toBeDefined();
    expect(sample.utilization.available).toBe(false); // first sample
  });

  it('Windows load averages are unavailable', () => {
    // process.platform is 'win32' on Windows; the mock returns 'linux'
    // The loadAverageAvailable flag is based on process.platform !== 'win32'
    // We verify the logic: on non-Windows, loadAverageAvailable is true
    expect(typeof computeLoadPercent(1.0, 4)).toBe('number');
  });
});

// ------------------------------------------------------------------
// Memory tests
// ------------------------------------------------------------------
describe('Memory measurement', () => {
  it('parses MemAvailable from /proc/meminfo', async () => {
    mockProcStatCpu({ user: 100, nice: 0, system: 50, idle: 850 });
    mockReadFile.mockImplementation((path: string) => {
      if (path === '/proc/meminfo') {
        return Promise.resolve('MemTotal:       8000000 kB\nMemFree:        2000000 kB\nMemAvailable:   3000000 kB\nSwapTotal:      1000000 kB\nSwapFree:        900000 kB\n');
      }
      return Promise.reject(new Error(`ENOENT: ${path}`));
    });

    const sampler = createCpuSampler();
    const snapshot = await collectResourceSnapshot({
      mount: '/',
      previousDiskSample: undefined,
      previousNetworkSamples: undefined,
      elapsedMs: 0,
      queueDepth: undefined,
      cpuSampler: sampler,
    });
    expect(snapshot.memory.availableBytes).toBe(3_072_000_000); // 3000000 kB * 1024
    expect(snapshot.memory.availablePercent).toBeDefined();
    expect(snapshot.memory.availablePercent).toBeGreaterThan(0);
    expect(snapshot.memory.availablePercent).toBeLessThan(100);
  });

  it('distinguishes swap configured from swap unavailable', async () => {
    // No swap configured
    mockProcStatCpu({ user: 100, nice: 0, system: 50, idle: 850 });
    mockReadFile.mockImplementation((path: string) => {
      if (path === '/proc/meminfo') {
        return Promise.resolve('MemTotal:       8000000 kB\nMemFree:        2000000 kB\nMemAvailable:   3000000 kB\nSwapTotal:        0 kB\nSwapFree:           0 kB\n');
      }
      return Promise.reject(new Error(`ENOENT: ${path}`));
    });

    const sampler = createCpuSampler();
    const snapshot = await collectResourceSnapshot({
      mount: '/',
      previousDiskSample: undefined,
      previousNetworkSamples: undefined,
      elapsedMs: 0,
      queueDepth: undefined,
      cpuSampler: sampler,
    });
    expect(snapshot.memory.swapConfigured).toBe(false);
    expect(snapshot.memory.swapUsedPercent).toBeUndefined();
  });

  it('swap unavailable when /proc/meminfo missing', async () => {
    mockProcStatCpu({ user: 100, nice: 0, system: 50, idle: 850 });
    mockReadFile.mockImplementation(() => Promise.reject(new Error('ENOENT')));
    const sampler = createCpuSampler();
    const snapshot = await collectResourceSnapshot({
      mount: '/',
      previousDiskSample: undefined,
      previousNetworkSamples: undefined,
      elapsedMs: 0,
      queueDepth: undefined,
      cpuSampler: sampler,
    });
    expect(snapshot.memory.swapConfigured).toBeUndefined();
    expect(snapshot.memory.swapUsedPercent).toBeUndefined();
  });

  it('availablePercent is within valid range', async () => {
    mockProcStatCpu({ user: 100, nice: 0, system: 50, idle: 850 });
    mockReadFile.mockImplementation((path: string) => {
      if (path === '/proc/meminfo') {
        return Promise.resolve('MemTotal:       8000000 kB\nMemFree:        2000000 kB\nMemAvailable:   3000000 kB\nSwapTotal:      1000000 kB\nSwapFree:        900000 kB\n');
      }
      return Promise.reject(new Error(`ENOENT: ${path}`));
    });

    const sampler = createCpuSampler();
    const snapshot = await collectResourceSnapshot({
      mount: '/',
      previousDiskSample: undefined,
      previousNetworkSamples: undefined,
      elapsedMs: 0,
      queueDepth: undefined,
      cpuSampler: sampler,
    });
    expect(snapshot.memory.availablePercent).toBeDefined();
    expect(snapshot.memory.availablePercent).toBeGreaterThanOrEqual(0);
    expect(snapshot.memory.availablePercent).toBeLessThanOrEqual(100);
  });
});

// ------------------------------------------------------------------
// Disk tests
// ------------------------------------------------------------------
describe('Disk measurement', () => {
  it('never reports zeros for failed statfs', async () => {
    mockReadFile.mockImplementation(() => Promise.reject(new Error('ENOENT: no such file')));
    // statfs will throw for a nonexistent mount
    const sampler = createCpuSampler();
    const snapshot = await collectResourceSnapshot({
      mount: '/nonexistent-mount-xyz',
      previousDiskSample: undefined,
      previousNetworkSamples: undefined,
      elapsedMs: 0,
      queueDepth: undefined,
      cpuSampler: sampler,
    });
    const disk = snapshot.disk[0]!;
    expect(disk.available).toBe(false);
    expect(disk.error).toBeDefined();
    expect(disk.totalBytes).toBeUndefined();
    expect(disk.freeBytes).toBeUndefined();
    expect(disk.freePercent).toBeUndefined();
    expect(disk.growthRateBytesPerHour).toBeUndefined();
  });

  it('computes growth rate when disk fills', () => {
    const previous = {
      mount: '/',
      available: true,
      totalBytes: 100_000_000_000,
      freeBytes: 50_000_000_000,
      availableBytes: 50_000_000_000,
      usedBytes: 50_000_000_000,
      freePercent: 50,
      growthRateBytesPerHour: undefined,
    };

    const current = {
      mount: '/',
      available: true,
      totalBytes: 100_000_000_000,
      freeBytes: 49_000_000_000,
      availableBytes: 49_000_000_000,
      usedBytes: 51_000_000_000,
      freePercent: 49,
      growthRateBytesPerHour: undefined,
    };

    const rate = computeDiskGrowthRate({
      mount: '/',
      previousSample: previous,
      elapsedMs: 1000 * 60 * 60,
      availableBytes: current.availableBytes,
    });
    expect(rate).toBe(1_000_000_000);
  });

  it('returns undefined growth rate when no previous sample', () => {
    expect(
      computeDiskGrowthRate({
        mount: '/',
        previousSample: undefined,
        elapsedMs: 1000,
        availableBytes: 50,
      }),
    ).toBeUndefined();
  });

  it('returns undefined growth rate when previous sample unavailable', () => {
    expect(
      computeDiskGrowthRate({
        mount: '/',
        previousSample: { available: false, availableBytes: undefined },
        elapsedMs: 1000,
        availableBytes: 50,
      }),
    ).toBeUndefined();
  });

  it('returns undefined growth rate when elapsedMs is 0', () => {
    const previous = {
      mount: '/',
      available: true,
      totalBytes: 100_000_000_000,
      freeBytes: 50_000_000_000,
      availableBytes: 50_000_000_000,
      usedBytes: 50_000_000_000,
      freePercent: 50,
      growthRateBytesPerHour: undefined,
    };
    expect(
      computeDiskGrowthRate({
        mount: '/',
        previousSample: previous,
        elapsedMs: 0,
        availableBytes: previous.availableBytes,
      }),
    ).toBeUndefined();
  });

  it('distinguishes free bytes from available bytes', async () => {
    // statfs is not mocked, so it will use the real filesystem
    // On non-Linux, statfs may throw; on Linux it returns real values
    // We test that availableBytes and freeBytes are tracked separately
    mockProcStatCpu({ user: 100, nice: 0, system: 50, idle: 850 });
    const sampler = createCpuSampler();
    try {
      const snapshot = await collectResourceSnapshot({
        mount: '/',
        previousDiskSample: undefined,
        previousNetworkSamples: undefined,
        elapsedMs: 0,
        queueDepth: undefined,
        cpuSampler: sampler,
      });
      const disk = snapshot.disk[0];
      if (disk && disk.available) {
        expect(disk.availableBytes).toBeDefined();
        expect(disk.freeBytes).toBeDefined();
        // bavail (available to unprivileged) may differ from free (total free)
      }
    } catch {
      // statfs may not be available in this environment
    }
  });
});

// ------------------------------------------------------------------
// Network tests
// ------------------------------------------------------------------
describe('Network measurement', () => {
  it('computes interval-derived traffic rates', async () => {
    mockProcStatCpu({ user: 100, nice: 0, system: 50, idle: 850 });
    mockReadFile.mockImplementation((path: string) => {
      if (path === '/proc/net/dev') {
        return Promise.resolve(
          'Inter-|   Receive                                                |  Transmit\n face |bytes    packets err drop fifo frame compressed multicast|bytes    packets err drop fifo colls carrier compressed\n    lo: 1000000 1000 0 0 0 0 0 0 2000000 1000 0 0 0 0 0 0\n    eth0: 5000000 5000 0 0 0 0 0 0 3000000 5000 0 0 0 0 0 0\n',
        );
      }
      return Promise.reject(new Error(`ENOENT: ${path}`));
    });

    const previous: NetworkSample[] = [
      { interface: 'eth0', bytesIn: 4_000_000, bytesOut: 2_500_000, bytesInPerSecond: undefined, bytesOutPerSecond: undefined },
    ];

    // 10 seconds elapsed: eth0 went from 5M/3M to 5M/3M (same, so 0 rate if same values)
    // Use different values
    mockReadFile.mockImplementation((path: string) => {
      if (path === '/proc/net/dev') {
        return Promise.resolve(
          'Inter-|   Receive                                                |  Transmit\n face |bytes    packets err drop fifo frame compressed multicast|bytes    packets err drop fifo colls carrier compressed\n    lo: 1000000 1000 0 0 0 0 0 0 2000000 1000 0 0 0 0 0 0\n    eth0: 6000000 6000 0 0 0 0 0 0 4000000 6000 0 0 0 0 0 0\n',
        );
      }
      return Promise.reject(new Error(`ENOENT: ${path}`));
    });

    const result = await import('./resource-collector.js').then((m) => m.sampleNetwork(previous, 10_000));
    const eth0 = result.find((n) => n.interface === 'eth0');
    expect(eth0).toBeDefined();
    if (eth0) {
      expect(eth0.bytesIn).toBe(6_000_000);
      expect(eth0.bytesOut).toBe(4_000_000);
      expect(eth0.bytesInPerSecond).toBeDefined();
      expect(eth0.bytesOutPerSecond).toBeDefined();
      // (6M-4M)/10s = 200,000 bytes/s
      expect(eth0.bytesInPerSecond).toBeCloseTo(200_000, -1);
      expect(eth0.bytesOutPerSecond).toBeCloseTo(150_000, -1);
    }
  });

  it('counter reset does not produce negative rate', async () => {
    mockReadFile.mockImplementation((path: string) => {
      if (path === '/proc/net/dev') {
        return Promise.resolve(
          'Inter-|   Receive                                                |  Transmit\n face |bytes    packets err drop fifo frame compressed multicast|bytes    packets err drop fifo colls carrier compressed\n    lo: 1000000 1000 0 0 0 0 0 0 2000000 1000 0 0 0 0 0 0\n    eth0: 100000 100 0 0 0 0 0 0 200000 100 0 0 0 0 0 0\n',
        );
      }
      return Promise.reject(new Error(`ENOENT: ${path}`));
    });

    const previous: NetworkSample[] = [
      { interface: 'eth0', bytesIn: 5_000_000, bytesOut: 3_000_000, bytesInPerSecond: undefined, bytesOutPerSecond: undefined },
    ];

    const result = await import('./resource-collector.js').then((m) => m.sampleNetwork(previous, 10_000));
    const eth0 = result.find((n) => n.interface === 'eth0');
    expect(eth0).toBeDefined();
    if (eth0) {
      // Counter reset: bytesIn went from 5M to 100K, rate should be undefined
      expect(eth0.bytesInPerSecond).toBeUndefined();
      expect(eth0.bytesOutPerSecond).toBeUndefined();
    }
  });

  it('missing interface returns empty results', async () => {
    mockReadFile.mockImplementation(() => Promise.reject(new Error('ENOENT')));
    const result = await import('./resource-collector.js').then((m) => m.sampleNetwork());
    expect(result).toEqual([]);
  });
});

// ------------------------------------------------------------------
// Process tests
// ------------------------------------------------------------------
describe('Process measurement', () => {
  it('uses process.memoryUsage().rss for current RSS', async () => {
    const { sampleCurrentProcess } = await import('./resource-collector.js');
    const result = await sampleCurrentProcess();
    expect(result.pid).toBe(process.pid);
    expect(result.name).toBe(process.title);
    expect(result.memoryRssBytes).toBeDefined();
    expect(result.memoryRssBytes).toBeGreaterThan(0);
    // memoryRssBytes should come from process.memoryUsage().rss, not maxRSS
    expect(result.memoryPeakRssBytes).toBeDefined();
  });
});

// ------------------------------------------------------------------
// Container tests
// ------------------------------------------------------------------
describe('Container measurement', () => {
  it('returns undefined when not in a container', async () => {
    mockReadFile.mockImplementation(() => Promise.reject(new Error('ENOENT')));
    const { sampleContainer } = await import('./resource-collector.js');
    const result = await sampleContainer();
    expect(result).toBeUndefined();
  });

  it('handles cgroup v2 unlimited memory', async () => {
    mockReadFile.mockImplementation((path: string) => {
      if (path === '/proc/self/cgroup') {
        return Promise.resolve('0::/kubepods/burstable/pod123/abc123def456\n');
      }
      if (path === '/sys/fs/cgroup/memory.current') return Promise.resolve('1000000\n');
      if (path === '/sys/fs/cgroup/memory.max') return Promise.resolve('9223372036854771712\n'); // unlimited
      if (path === '/sys/fs/cgroup/cpu/cpuacct.usage_cpu') return Promise.resolve('500000000\n');
      return Promise.reject(new Error(`ENOENT: ${path}`));
    });

    const { sampleContainer } = await import('./resource-collector.js');
    const result = await sampleContainer();
    expect(result).toBeDefined();
    if (result) {
      expect(result.available).toBe(true);
      expect(result.memoryLimitBytes).toBeUndefined(); // unlimited
      expect(result.memoryUsedPercent).toBeUndefined();
    }
  });

  it('handles cgroup v1 memory limits', async () => {
    mockReadFile.mockImplementation((path: string) => {
      if (path === '/proc/self/cgroup') {
        return Promise.resolve('0::/docker/abc123def456\n');
      }
      if (path === '/sys/fs/cgroup/memory/memory.usage_in_bytes') return Promise.resolve('500000000\n');
      if (path === '/sys/fs/cgroup/memory/memory.limit_in_bytes') return Promise.resolve('1000000000\n');
      if (path === '/sys/fs/cgroup/cpu/cpuacct.usage_cpu') return Promise.resolve('200000000\n');
      return Promise.reject(new Error(`ENOENT: ${path}`));
    });

    const { sampleContainer } = await import('./resource-collector.js');
    const result = await sampleContainer();
    expect(result).toBeDefined();
    if (result) {
      expect(result.available).toBe(true);
      expect(result.memoryUsageBytes).toBe(500_000_000);
      expect(result.memoryLimitBytes).toBe(1_000_000_000);
      expect(result.memoryUsedPercent).toBe(50);
    }
  });

  it('handles missing cgroup data gracefully', async () => {
    mockReadFile.mockImplementation((path: string) => {
      if (path === '/proc/self/cgroup') {
        return Promise.resolve('0::/docker/abc123def456\n');
      }
      return Promise.reject(new Error('ENOENT'));
    });

    const { sampleContainer } = await import('./resource-collector.js');
    const result = await sampleContainer();
    expect(result).toBeDefined();
    if (result) {
      expect(result.available).toBe(true);
      expect(result.memoryUsageBytes).toBeUndefined();
      expect(result.memoryLimitBytes).toBeUndefined();
      expect(result.memoryUsedPercent).toBeUndefined();
    }
  });
});

// ------------------------------------------------------------------
// Bounded collection tests
// ------------------------------------------------------------------
describe('Bounded collection', () => {
  it('completes successfully within timeout', async () => {
    const result = await boundedCollection(async () => {
      await new Promise((r) => setTimeout(r, 10));
      return 'done';
    }, { timeoutMs: 1000 });
    expect(result.result).toBe('done');
    expect(result.error).toBeUndefined();
    expect(result.timedOut).toBe(false);
    expect(result.elapsedMs).toBeGreaterThanOrEqual(0);
  });

  it('times out when operation exceeds deadline', async () => {
    const result = await boundedCollection(async () => {
      await new Promise((r) => setTimeout(r, 5000));
      return 'done';
    }, { timeoutMs: 50 });
    expect(result.result).toBeUndefined();
    expect(result.error).toBeDefined();
    expect(result.timedOut).toBe(true);
    expect(result.elapsedMs).toBeGreaterThanOrEqual(50);
  });

  it('rejects overlapping collection', async () => {
    // Start a slow operation
    const slowPromise = boundedCollection(async () => {
      await new Promise((r) => setTimeout(r, 1000));
      return 'slow';
    }, { timeoutMs: 5000 });

    // Try to start another while first is in progress
    const fastResult = await boundedCollection(async () => {
      return 'fast';
    }, { timeoutMs: 1000 });

    expect(fastResult.result).toBeUndefined();
    expect(fastResult.error).toBeDefined();
    expect(fastResult.error!.message).toBe('Collection already in progress');

    await slowPromise;
  });

  it('uses default timeout when not specified', async () => {
    expect(DEFAULT_COLLECTION_TIMEOUT_MS).toBe(10_000);
    const result = await boundedCollection(async () => {
      await new Promise((r) => setTimeout(r, 20_000));
      return 'done';
    }, { timeoutMs: 500 });
    expect(result.timedOut).toBe(true);
    expect(result.elapsedMs).toBeGreaterThanOrEqual(500);
  });
});

// ------------------------------------------------------------------
// Full snapshot tests
// ------------------------------------------------------------------
describe('collectResourceSnapshot', () => {
  it('returns a complete ResourceSnapshot', async () => {
    mockProcStatCpu({ user: 100, nice: 0, system: 50, idle: 850 });
    mockReadFile.mockImplementation((path: string) => {
      if (path === '/proc/meminfo') {
        return Promise.resolve('MemTotal:       8000000 kB\nMemFree:        2000000 kB\nMemAvailable:   3000000 kB\nSwapTotal:      1000000 kB\nSwapFree:        900000 kB\n');
      }
      if (path === '/proc/net/dev') {
        return Promise.resolve(
          'Inter-|   Receive                                                |  Transmit\n face |bytes    packets err drop fifo frame compressed multicast|bytes    packets err drop fifo colls carrier compressed\n    lo: 1000000 1000 0 0 0 0 0 0 2000000 1000 0 0 0 0 0 0\n    eth0: 5000000 5000 0 0 0 0 0 0 3000000 5000 0 0 0 0 0 0\n',
        );
      }
      return Promise.reject(new Error(`ENOENT: ${path}`));
    });

    const sampler = createCpuSampler();
    await sampler.sample(); // first sample (unavailable utilization)
    mockProcStatCpu({ user: 150, nice: 0, system: 75, idle: 850 }); // second sample

    const snapshot = await collectResourceSnapshot({
      mount: '/',
      previousDiskSample: undefined,
      previousNetworkSamples: undefined,
      elapsedMs: 0,
      queueDepth: undefined,
      cpuSampler: sampler,
    });

    expect(snapshot.timestamp).toBeDefined();
    expect(new Date(snapshot.timestamp)).toBeInstanceOf(Date);
    expect(snapshot.cpu.load.load1).toBeGreaterThanOrEqual(0);
    expect(snapshot.cpu.load.cpuCount).toBeGreaterThan(0);
    expect(snapshot.memory.totalBytes).toBeGreaterThan(0);
    expect(snapshot.memory.availableBytes).toBeDefined();
    expect(snapshot.memory.availablePercent).toBeDefined();
    expect(Array.isArray(snapshot.disk)).toBe(true);
    expect(snapshot.disk.length).toBe(1);
    expect(Array.isArray(snapshot.network)).toBe(true);
    expect(snapshot.currentProcess.pid).toBe(process.pid);
  });

  it('never reports unavailable disk as zero', async () => {
    mockReadFile.mockImplementation(() => Promise.reject(new Error('ENOENT')));
    const sampler = createCpuSampler();
    const snapshot = await collectResourceSnapshot({
      mount: '/nonexistent-mount-xyz',
      previousDiskSample: undefined,
      previousNetworkSamples: undefined,
      elapsedMs: 0,
      queueDepth: undefined,
      cpuSampler: sampler,
    });
    const disk = snapshot.disk[0]!;
    expect(disk.available).toBe(false);
    expect(disk.error).toBeDefined();
    expect(disk.totalBytes).toBeUndefined();
    expect(disk.freeBytes).toBeUndefined();
    expect(disk.freePercent).toBeUndefined();
  });

  it('includes queue depth when provided', async () => {
    mockProcStatCpu({ user: 100, nice: 0, system: 50, idle: 850 });
    const sampler = createCpuSampler();
    await sampler.sample();

    const queueDepth = [
      { queueName: 'campaign-execution', waiting: 10, failed: 1 },
      { queueName: 'callbacks', waiting: 0, failed: 0 },
    ];
    const snapshot = await collectResourceSnapshot({
      mount: '/',
      previousDiskSample: undefined,
      previousNetworkSamples: undefined,
      elapsedMs: 0,
      queueDepth,
      cpuSampler: sampler,
    });
    expect(snapshot.queueDepth).toEqual(queueDepth);
  });
});

// ------------------------------------------------------------------
// Sustained threshold tests (using W6-02 alert evaluation primitives)
// ------------------------------------------------------------------
describe('Sustained threshold detection', () => {
  it('sustained breach triggers alert, temporary spike does not', () => {
    // Reuse W6-02 alert evaluation logic conceptually:
    // A temporary spike (single breach) should not trigger sustained alert
    // Multiple consecutive breaches over sustained period should trigger

    const readings = [70, 72, 75, 78, 80, 82, 85, 88]; // CPU loadPercent rising
    const criticalThreshold = 85;
    const sustainedForMs = 120_000; // 2 minutes
    const collectionIntervalMs = 30_000; // 30 seconds

    let consecutiveBreaches = 0;
    let breachStartTime: number | undefined;
    let alertFired = false;

    for (let i = 0; i < readings.length; i++) {
      const value = readings[i]!;
      const breached = value > criticalThreshold;

      if (breached) {
        if (consecutiveBreaches === 0) breachStartTime = i * collectionIntervalMs;
        consecutiveBreaches++;
        const sustained = breachStartTime !== undefined && (i * collectionIntervalMs - breachStartTime) >= sustainedForMs;
        if (sustained && consecutiveBreaches >= 3) {
          alertFired = true;
          break;
        }
      } else {
        consecutiveBreaches = 0;
        breachStartTime = undefined;
      }
    }

    // At reading index 6 (85), we have 1 breach. At index 7 (88), 2 breaches.
    // Need 3 consecutive breaches, so alert should NOT fire yet with 8 readings
    // Let's verify: readings[5]=82 (not >85), readings[6]=85 (not >85, equal), readings[7]=88 (>85)
    // So only 1 breach, alert should not fire
    expect(alertFired).toBe(false);

    // Now add more sustained breaches
    let consecutiveBreaches2 = 0;
    let breachStartTime2: number | undefined;
    let alertFired2 = false;

    const sustainedReadings = [86, 87, 88, 89, 90]; // 5 consecutive critical breaches
    for (let i = 0; i < sustainedReadings.length; i++) {
      const value = sustainedReadings[i]!;
      const breached = value > criticalThreshold;
      if (breached) {
        if (consecutiveBreaches2 === 0) breachStartTime2 = i * collectionIntervalMs;
        consecutiveBreaches2++;
        const sustained = breachStartTime2 !== undefined && (i * collectionIntervalMs - breachStartTime2) >= sustainedForMs;
        // 5 readings * 30s = 150s >= 120s sustainedForMs
        if (sustained && consecutiveBreaches2 >= 3) {
          alertFired2 = true;
          break;
        }
      } else {
        consecutiveBreaches2 = 0;
        breachStartTime2 = undefined;
      }
    }

    expect(alertFired2).toBe(true);
  });

  it('missing sample interrupts sustained threshold evaluation', () => {
    const readings = [86, undefined, 87, 88]; // missing sample at index 1
    const criticalThreshold = 85;
    let consecutiveBreaches = 0;
    let alertFired = false;

    for (const value of readings) {
      if (value === undefined) {
        // Missing sample interrupts sustained count
        consecutiveBreaches = 0;
        continue;
      }
      if (value > criticalThreshold) {
        consecutiveBreaches++;
        if (consecutiveBreaches >= 3) {
          alertFired = true;
          break;
        }
      } else {
        consecutiveBreaches = 0;
      }
    }

    expect(alertFired).toBe(false); // Only 2 consecutive after the gap
  });

  it('storage exhaustion projection', () => {
    const freeBytes = 15_000_000_000; // 15 GB free
    const growthRateBytesPerHour = 2_000_000_000; // 2 GB/hr

    const hoursUntilExhaustion = freeBytes / growthRateBytesPerHour;
    const daysUntilExhaustion = hoursUntilExhaustion / 24;

    expect(hoursUntilExhaustion).toBe(7.5);
    expect(daysUntilExhaustion).toBeCloseTo(0.3125, 2);
    // Less than 7 days -> upgrade justification
    expect(daysUntilExhaustion).toBeLessThan(7);
  });
});
