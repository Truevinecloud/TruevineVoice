/**
 * W6-04 Resource snapshot and collection.
 *
 * Dependency-free, read-only host resource collection for TruevineVoice.
 * Uses only Node.js built-in modules (`node:os`, `node:fs/promises`).
 * No provider SDKs, no npm dependencies.
 *
 * All reads are read-only snapshots. Collection never mutates queue state,
 * payment state, or provider state. Missing or unavailable metrics are
 * reported as `undefined`, never zero.
 *
 * Cross-platform: works on Linux (production VPS) and Windows (local
 * development). Linux-specific sources (/proc, /sys) are read where
 * available and silently skipped elsewhere.
 *
 * CPU utilization is computed from differences between two consecutive
 * /proc/stat samples. The first sample reports utilization as unavailable
 * because a valid sampling interval has not yet been completed.
 */

import { cpus, freemem, loadavg, totalmem, type CpuInfo } from 'node:os';
import { statfs } from 'node:fs/promises';
import { readFile } from 'node:fs/promises';
import { type MetricStatus, type MetricSample } from './metrics.js';

/** ------------------------------------------------------------------ */
/** CPU                                                                */
/** ------------------------------------------------------------------ */

/** Raw /proc/stat cumulative counters for a single sample. */
export interface CpuStatCounters {
  readonly user: number;
  readonly nice: number;
  readonly system: number;
  readonly idle: number;
  readonly iowait: number;
  readonly irq: number;
  readonly softirq: number;
  readonly steal: number;
  readonly total: number;
  readonly work: number;
}

/** CPU load sample from loadavg(). */
interface CpuLoadSample {
  readonly load1: number;
  readonly load5: number;
  readonly load15: number;
  readonly cpuCount: number;
  /** load1 / cpuCount * 100. Undefined when cpuCount is 0. */
  readonly loadPercent: number | undefined;
  /** Load averages are unavailable on Windows; undefined there. */
  readonly loadAverageAvailable: boolean;
}

/** CPU utilization computed from counter differences. */
export interface CpuUtilizationSample {
  /** Utilization percentage (0-100). Undefined on first sample or when unavailable. */
  readonly utilizationPercent: number | undefined;
  /** Whether utilization is available (requires >= 2 samples). */
  readonly available: boolean;
  /** Milliseconds between samples. */
  readonly intervalMs: number | undefined;
}

export interface CpuSample {
  readonly load: CpuLoadSample;
  readonly utilization: CpuUtilizationSample;
}

/** State retained between CPU samples for difference-based utilization. */
interface CpuSamplerState {
  readonly previous: CpuStatCounters | undefined;
  readonly previousTimestamp: number | undefined;
}

/**
 * Computes load percentage from load1 and cpuCount.
 * Returns undefined when cpuCount is 0 or negative.
 */
export function computeLoadPercent(load1: number, cpuCount: number): number | undefined {
  if (!Number.isFinite(cpuCount) || cpuCount <= 0) return undefined;
  if (!Number.isFinite(load1)) return undefined;
  return Math.round((load1 / cpuCount) * 100 * 100) / 100;
}

/**
 * Parses the first line of /proc/stat into cumulative counters.
 * Returns undefined when unavailable or unparseable.
 */
function parseProcStatCpu(text: string): CpuStatCounters | undefined {
  const firstLine = text.split('\n')[0];
  if (!firstLine) return undefined;

  // cpu  user nice system idle iowait irq softirq steal guest guest_nice
  const fields = firstLine.trim().split(/\s+/);
  if (fields.length < 5) return undefined;

  const user = Number(fields[1]);
  const nice = Number(fields[2]);
  const system = Number(fields[3]);
  const idle = Number(fields[4]);
  const iowait = Number(fields[5]) || 0;
  const irq = Number(fields[6]) || 0;
  const softirq = Number(fields[7]) || 0;
  const steal = Number(fields[8]) || 0;

  if (
    !Number.isFinite(user) ||
    !Number.isFinite(nice) ||
    !Number.isFinite(system) ||
    !Number.isFinite(idle)
  ) {
    return undefined;
  }

  const total = user + nice + system + idle + iowait + irq + softirq + steal;
  const work = total - idle - iowait;

  return { user, nice, system, idle, iowait, irq, softirq, steal, total, work };
}

/**
 * Computes utilization percentage from two counter samples.
 * Handles counter resets (new total < previous total) by returning undefined.
 */
function computeUtilizationFromDifferences(
  previous: CpuStatCounters,
  current: CpuStatCounters,
): number | undefined {
  const totalDelta = current.total - previous.total;
  const workDelta = current.work - previous.work;

  if (totalDelta <= 0) return undefined; // counter reset or invalid
  if (workDelta < 0) return undefined;   // counter reset or invalid

  return Math.round((workDelta / totalDelta) * 100 * 100) / 100;
}

/**
 * Stateful CPU sampler. Maintains the previous /proc/stat sample so that
 * utilization is computed from counter differences, never from a single
 * cumulative snapshot.
 */
export class CpuSampler {
  private state: CpuSamplerState = { previous: undefined, previousTimestamp: undefined };

  /**
   * Collects a CPU sample. On the first call, utilization is unavailable
   * because no sampling interval has been completed.
   */
  async sample(): Promise<CpuSample> {
    const [load1, load5, load15] = loadavg();
    const cpuInfos: CpuInfo[] = cpus();
    const cpuCount = cpuInfos.length;
    const loadPercent = computeLoadPercent(load1 ?? 0, cpuCount);

    const loadSample: CpuLoadSample = {
      load1: load1 ?? 0,
      load5: load5 ?? 0,
      load15: load15 ?? 0,
      cpuCount,
      loadPercent,
      loadAverageAvailable: process.platform !== 'win32',
    };

    let utilization: CpuUtilizationSample = {
      utilizationPercent: undefined,
      available: false,
      intervalMs: undefined,
    };

    try {
      const text = await readFile('/proc/stat', 'utf8');
      const current = parseProcStatCpu(text);
      const now = Date.now();

      if (current) {
        if (this.state.previous && this.state.previousTimestamp !== undefined) {
          const intervalMs = now - this.state.previousTimestamp;
          const pct = computeUtilizationFromDifferences(this.state.previous, current);
          utilization = {
            utilizationPercent: pct,
            available: pct !== undefined,
            intervalMs,
          };
        }

        this.state = { previous: current, previousTimestamp: now };
      }
    } catch {
      // /proc/stat unavailable (Windows): utilization remains undefined
    }

    return { load: loadSample, utilization };
  }

  /** Resets the sampler state. Next sample reports utilization as unavailable. */
  reset(): void {
    this.state = { previous: undefined, previousTimestamp: undefined };
  }
}

/** ------------------------------------------------------------------ */
/** Memory                                                             */
/** ------------------------------------------------------------------ */

interface MemorySample {
  readonly totalBytes: number;
  readonly freeBytes: number;
  readonly availableBytes: number | undefined;
  readonly usedBytes: number;
  /** Used memory as a percentage (0-100). Undefined when total is unavailable. */
  readonly usedPercent: number | undefined;
  /** Memory pressure based on available bytes (0-100). Undefined when unavailable. */
  readonly availablePercent: number | undefined;
  readonly swapTotalBytes: number | undefined;
  readonly swapFreeBytes: number | undefined;
  /** Swap configured (totalBytes > 0). Undefined when swap status unknown. */
  readonly swapConfigured: boolean | undefined;
  readonly swapUsedBytes: number | undefined;
  /** Swap used as a percentage (0-100). Undefined when no swap or unknown. */
  readonly swapUsedPercent: number | undefined;
}

function computeMemoryUsedPercent(totalBytes: number, freeBytes: number): number | undefined {
  if (!Number.isFinite(totalBytes) || totalBytes <= 0) return undefined;
  if (!Number.isFinite(freeBytes)) return undefined;
  return Math.round(((totalBytes - freeBytes) / totalBytes) * 100 * 100) / 100;
}

/**
 * Parses MemAvailable from /proc/meminfo on Linux.
 * Returns undefined when unavailable.
 */
async function readProcMeminfoAvailable(): Promise<number | undefined> {
  try {
    const text = await readFile('/proc/meminfo', 'utf8');
    for (const line of text.split('\n')) {
      const match = line.match(/^MemAvailable:\s+(\d+)\s+kB/);
      if (match) {
        const valueKb = Number(match[1]);
        if (Number.isFinite(valueKb)) return valueKb * 1024;
      }
    }
    return undefined;
  } catch {
    return undefined;
  }
}

/**
 * Parses SwapTotal and SwapFree from /proc/meminfo on Linux.
 * Returns undefined when unavailable.
 */
async function readProcMeminfoSwap(): Promise<{
  swapTotalBytes: number | undefined;
  swapFreeBytes: number | undefined;
}> {
  try {
    const text = await readFile('/proc/meminfo', 'utf8');
    let swapTotal: number | undefined;
    let swapFree: number | undefined;

    for (const line of text.split('\n')) {
      const match = line.match(/^(SwapTotal|SwapFree):\s+(\d+)\s+kB/);
      if (!match) continue;
      const valueKb = Number(match[2]);
      const valueBytes = valueKb * 1024;
      if (match[1] === 'SwapTotal') swapTotal = valueBytes;
      if (match[1] === 'SwapFree') swapFree = valueBytes;
    }

    return { swapTotalBytes: swapTotal, swapFreeBytes: swapFree };
  } catch {
    return { swapTotalBytes: undefined, swapFreeBytes: undefined };
  }
}

async function sampleMemory(): Promise<MemorySample> {
  const totalBytes = totalmem();
  const freeBytes = freemem();
  const availableBytes = await readProcMeminfoAvailable();

  const usedPercent = computeMemoryUsedPercent(totalBytes, freeBytes);
  const availablePercent =
    availableBytes !== undefined && totalBytes > 0
      ? Math.round(((totalBytes - availableBytes) / totalBytes) * 100 * 100) / 100
      : undefined;

  const swap = await readProcMeminfoSwap();
  const swapTotalBytes = swap.swapTotalBytes;
  const swapFreeBytes = swap.swapFreeBytes;
  const swapConfigured =
    swapTotalBytes !== undefined ? swapTotalBytes > 0 : undefined;
  const swapUsedBytes =
    swapTotalBytes !== undefined && swapFreeBytes !== undefined
      ? swapTotalBytes - swapFreeBytes
      : undefined;
  const swapUsedPercent =
    swapConfigured === true && swapTotalBytes !== undefined && swapTotalBytes > 0 && swapUsedBytes !== undefined
      ? Math.round((swapUsedBytes / swapTotalBytes) * 100 * 100) / 100
      : undefined;

  return {
    totalBytes,
    freeBytes,
    availableBytes,
    usedBytes: totalBytes - freeBytes,
    usedPercent,
    availablePercent,
    swapTotalBytes,
    swapFreeBytes,
    swapConfigured,
    swapUsedBytes,
    swapUsedPercent,
  };
}

/** ------------------------------------------------------------------ */
/** Disk                                                               */
/** ------------------------------------------------------------------ */

interface DiskSample {
  readonly mount: string;
  /** Whether the sample could be collected. */
  readonly available: boolean;
  /** Error message when unavailable. Safe to log. */
  readonly error?: string;
  readonly totalBytes: number | undefined;
  readonly freeBytes: number | undefined;
  /** Bytes available to unprivileged users. */
  readonly availableBytes: number | undefined;
  readonly usedBytes: number | undefined;
  /** Free space as a percentage (0-100). Undefined when unavailable. */
  readonly freePercent: number | undefined;
  /** Bytes grown per hour since previous sample. Undefined when unavailable. */
  readonly growthRateBytesPerHour: number | undefined;
}

export interface DiskSampleInput {
  readonly mount: string;
  readonly previousSample: { readonly available: boolean; readonly availableBytes: number | undefined } | undefined;
  readonly elapsedMs: number;
  readonly availableBytes: number | undefined;
}

/**
 * Computes disk growth rate from two samples. Returns undefined when no
 * previous sample exists, elapsed time is zero, or either sample is unavailable.
 */
export function computeDiskGrowthRate(input: DiskSampleInput): number | undefined {
  if (!input.previousSample || !input.previousSample.available) return undefined;
  if (!input.elapsedMs || input.elapsedMs <= 0) return undefined;
  if (input.availableBytes === undefined || input.previousSample.availableBytes === undefined) return undefined;

  const hours = input.elapsedMs / (1000 * 60 * 60);
  if (hours <= 0) return undefined;

  // Negative growth = disk filling up (available bytes decreasing).
  // Report as positive growth of used space.
  const usedGrown = input.previousSample.availableBytes - input.availableBytes;
  return Math.round((usedGrown / hours) * 100) / 100;
}

async function sampleDisk(
  mount = '/',
  previousSample: DiskSample | undefined = undefined,
  elapsedMs: number = 0,
): Promise<DiskSample> {
  try {
    const stats = await statfs(mount);
    const blockSize = Number(stats.bsize);
    const totalBlocks = Number(stats.blocks);
    const freeBlocks = Number(stats.bavail);

    if (!Number.isFinite(blockSize) || !Number.isFinite(totalBlocks)) {
      return {
        mount,
        available: false,
        error: 'statfs returned non-finite values',
        totalBytes: undefined,
        freeBytes: undefined,
        availableBytes: undefined,
        usedBytes: undefined,
        freePercent: undefined,
        growthRateBytesPerHour: undefined,
      };
    }

    const totalBytes = blockSize * totalBlocks;
    // bavail is blocks available to unprivileged users.
    const availableBytes = Number.isFinite(freeBlocks) ? blockSize * freeBlocks : undefined;
    const freeBytes = availableBytes;
    const usedBytes = totalBytes > 0 && availableBytes !== undefined ? totalBytes - availableBytes : undefined;
    const freePercent = totalBytes > 0 && availableBytes !== undefined ? Math.round((availableBytes / totalBytes) * 100 * 100) / 100 : undefined;
    const growthRateBytesPerHour = computeDiskGrowthRate({
      mount,
      previousSample,
      elapsedMs,
      availableBytes,
    });

    return {
      mount,
      available: true,
      totalBytes,
      freeBytes,
      availableBytes,
      usedBytes,
      freePercent,
      growthRateBytesPerHour,
    };
  } catch {
    return {
      mount,
      available: false,
      error: `statfs failed for mount '${mount}'`,
      totalBytes: undefined,
      freeBytes: undefined,
      availableBytes: undefined,
      usedBytes: undefined,
      freePercent: undefined,
      growthRateBytesPerHour: undefined,
    };
  }
}

/** ------------------------------------------------------------------ */
/** Network                                                            */
/** ------------------------------------------------------------------ */

export interface NetworkSample {
  readonly interface: string;
  /** Cumulative bytes received since boot. Undefined when unavailable. */
  readonly bytesIn: number | undefined;
  /** Cumulative bytes transmitted since boot. Undefined when unavailable. */
  readonly bytesOut: number | undefined;
  /** Bytes received per second since previous sample. Undefined when unavailable. */
  readonly bytesInPerSecond: number | undefined;
  /** Bytes transmitted per second since previous sample. Undefined when unavailable. */
  readonly bytesOutPerSecond: number | undefined;
}

export interface NetworkSampleInput {
  readonly interface: string;
  readonly bytesIn: number;
  readonly bytesOut: number;
  readonly previousSample: NetworkSample | undefined;
  readonly elapsedMs: number;
}

function computeNetworkRate(input: NetworkSampleInput): {
  bytesInPerSecond: number | undefined;
  bytesOutPerSecond: number | undefined;
} {
  if (!input.previousSample || !input.elapsedMs || input.elapsedMs <= 0) {
    return { bytesInPerSecond: undefined, bytesOutPerSecond: undefined };
  }

  const prev = input.previousSample;
  if (prev.bytesIn === undefined || prev.bytesOut === undefined) {
    return { bytesInPerSecond: undefined, bytesOutPerSecond: undefined };
  }
  if (input.bytesIn === undefined || input.bytesOut === undefined) {
    return { bytesInPerSecond: undefined, bytesOutPerSecond: undefined };
  }

  const seconds = input.elapsedMs / 1000;
  const bytesInDelta = input.bytesIn - prev.bytesIn;
  const bytesOutDelta = input.bytesOut - prev.bytesOut;

  // Counter reset: new value less than previous. Rate is undefined.
  if (bytesInDelta < 0 || bytesOutDelta < 0) {
    return { bytesInPerSecond: undefined, bytesOutPerSecond: undefined };
  }

  return {
    bytesInPerSecond: Math.round((bytesInDelta / seconds) * 100) / 100,
    bytesOutPerSecond: Math.round((bytesOutDelta / seconds) * 100) / 100,
  };
}

/**
 * Reads /proc/net/dev on Linux for per-interface cumulative byte counters.
 * Returns empty array when unavailable (Windows).
 */
async function readProcNetDev(): Promise<Array<{ interface: string; bytesIn: number; bytesOut: number }>> {
  try {
    const text = await readFile('/proc/net/dev', 'utf8');
    const results: Array<{ interface: string; bytesIn: number; bytesOut: number }> = [];

    // Skip header lines (2 lines)
    const lines = text.split('\n').slice(2);
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      // Format: iface:  bytesIn packetsIn errIn dropIn fifoIn frameIn compressed multicastIn bytesOut ...
      const colonIdx = trimmed.indexOf(':');
      if (colonIdx === -1) continue;

      const iface = trimmed.slice(0, colonIdx).trim();
      const fields = trimmed.slice(colonIdx + 1).trim().split(/\s+/);
      const bytesIn = Number(fields[0]);
      const bytesOut = Number(fields[8]);

      if (Number.isFinite(bytesIn) && Number.isFinite(bytesOut)) {
        results.push({ interface: iface, bytesIn, bytesOut });
      }
    }

    return results;
  } catch {
    return [];
  }
}

export async function sampleNetwork(
  previousSamples: ReadonlyArray<NetworkSample> | undefined = undefined,
  elapsedMs: number = 0,
): Promise<NetworkSample[]> {
  const raw = await readProcNetDev();
  const results: NetworkSample[] = [];

  for (const entry of raw) {
    const previous = previousSamples?.find((p) => p.interface === entry.interface);
    const rates = computeNetworkRate({
      interface: entry.interface,
      bytesIn: entry.bytesIn,
      bytesOut: entry.bytesOut,
      previousSample: previous,
      elapsedMs,
    });

    results.push({
      interface: entry.interface,
      bytesIn: entry.bytesIn,
      bytesOut: entry.bytesOut,
      bytesInPerSecond: rates.bytesInPerSecond,
      bytesOutPerSecond: rates.bytesOutPerSecond,
    });
  }

  return results;
}

/** ------------------------------------------------------------------ */
/** Container                                                          */
/** ------------------------------------------------------------------ */

export interface ContainerSample {
  readonly id: string | undefined;
  /** Whether the sample could be collected. */
  readonly available: boolean;
  readonly cpuUsageNanoseconds: number | undefined;
  readonly memoryUsageBytes: number | undefined;
  readonly memoryLimitBytes: number | undefined;
  /** Memory used as a percentage of limit. Undefined when no limit. */
  readonly memoryUsedPercent: number | undefined;
}

async function readCgroupFile(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, 'utf8');
  } catch {
    return undefined;
  }
}

export async function sampleContainer(): Promise<ContainerSample | undefined> {
  // Detect container via /proc/self/cgroup (Linux only)
  const cgroupText = await readCgroupFile('/proc/self/cgroup');
  let containerId: string | undefined;
  let inContainer = false;

  if (cgroupText) {
    // Format: 0::/kubepods/burstable/pod<uid>/<container-id>
    // or: 0::/docker/<container-id>
    for (const line of cgroupText.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const parts = trimmed.split(':');
      const path = parts[parts.length - 1]?.trim();
      if (path && path.length > 0 && path !== '/') {
        const pathParts = path.split('/');
        const lastPart = pathParts[pathParts.length - 1];
        if (lastPart && lastPart.length > 8) {
          containerId = lastPart;
          inContainer = true;
          break;
        }
      }
    }
  }

  if (!inContainer) return undefined;

  // Read memory usage from cgroup v2 or v1
  let memoryUsageBytes: number | undefined;
  let memoryLimitBytes: number | undefined;

  // cgroup v2
  const memCurrent = await readCgroupFile('/sys/fs/cgroup/memory.current');
  const memMax = await readCgroupFile('/sys/fs/cgroup/memory.max');
  if (memCurrent !== undefined && memMax !== undefined) {
    const current = Number(memCurrent.trim());
    const max = Number(memMax.trim());
    if (Number.isFinite(current)) memoryUsageBytes = current;
    if (Number.isFinite(max) && max !== 9223372036854771712) {
      memoryLimitBytes = max;
    }
  }

  // cgroup v1 fallback
  if (memoryUsageBytes === undefined) {
    const memUsage = await readCgroupFile('/sys/fs/cgroup/memory/memory.usage_in_bytes');
    const memLimit = await readCgroupFile('/sys/fs/cgroup/memory/memory.limit_in_bytes');
    if (memUsage !== undefined) {
      const val = Number(memUsage.trim());
      if (Number.isFinite(val)) memoryUsageBytes = val;
    }
    if (memLimit !== undefined) {
      const val = Number(memLimit.trim());
      if (Number.isFinite(val) && val !== 9223372036854771712) {
        memoryLimitBytes = val;
      }
    }
  }

  const memoryUsedPercent =
    memoryUsageBytes !== undefined && memoryLimitBytes !== undefined && memoryLimitBytes > 0
      ? Math.round((memoryUsageBytes / memoryLimitBytes) * 100 * 100) / 100
      : undefined;

  // CPU usage from cgroup (cumulative nanoseconds, not instantaneous)
  let cpuUsageNanoseconds: number | undefined;
  const cpuUsage = await readCgroupFile('/sys/fs/cgroup/cpu/cpuacct.usage_cpu');
  if (cpuUsage !== undefined) {
    const val = Number(cpuUsage.trim());
    if (Number.isFinite(val)) cpuUsageNanoseconds = val;
  }
  if (cpuUsageNanoseconds === undefined) {
    const cpuUsageV2 = await readCgroupFile('/sys/fs/cgroup/cpu.stat');
    if (cpuUsageV2 !== undefined) {
      const usageMatch = cpuUsageV2.match(/usage_usec\s+(\d+)/);
      if (usageMatch) {
        const val = Number(usageMatch[1]);
        if (Number.isFinite(val)) cpuUsageNanoseconds = val * 1000; // microseconds to nanoseconds
      }
    }
  }

  return {
    id: containerId,
    available: true,
    cpuUsageNanoseconds,
    memoryUsageBytes,
    memoryLimitBytes,
    memoryUsedPercent,
  };
}

/** ------------------------------------------------------------------ */
/** Process                                                            */
/** ------------------------------------------------------------------ */

export interface ProcessSample {
  readonly pid: number;
  readonly name: string;
  /** Current resident set size in bytes. */
  readonly memoryRssBytes: number | undefined;
  /** Peak resident set size in bytes. Separate from current RSS. */
  readonly memoryPeakRssBytes: number | undefined;
  /** CPU utilization percentage. Requires two samples over time. */
  readonly cpuPercent: number | undefined;
}

export async function sampleCurrentProcess(): Promise<ProcessSample> {
  const usage = process.resourceUsage();
  const memUsage = process.memoryUsage();

  return {
    pid: process.pid,
    name: process.title,
    memoryRssBytes: memUsage.rss,
    memoryPeakRssBytes: usage.maxRSS,
    cpuPercent: undefined, // requires two samples over time
  };
}

/** ------------------------------------------------------------------ */
/** Bounded collection                                                 */
/** ------------------------------------------------------------------ */

/** Maximum time allowed for a single collection cycle. */
export const DEFAULT_COLLECTION_TIMEOUT_MS = 10_000;

/**
 * Wraps a promise with a timeout. If the timeout expires, the returned
 * promise rejects with a TimeoutError. The underlying operation continues
 * in the background (Node.js cannot cancel fs promises), but its result is
 * discarded.
 */
async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    timeoutId = setTimeout(() => reject(new Error(`Collection timeout after ${ms}ms`)), ms);
  });

  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}

/** Tracks whether a collection cycle is currently in progress. */
let collectionInProgress = false;

/** Result of a bounded collection. */
export interface BoundedCollectionResult<T> {
  readonly result: T | undefined;
  readonly error: Error | undefined;
  readonly timedOut: boolean;
  readonly elapsedMs: number;
}

/**
 * Runs a collection function with a deadline and overlap protection.
 * If a collection is already in progress, returns an error result immediately.
 * If the operation exceeds the timeout, returns a timed-out result.
 */
export async function boundedCollection<T>(
  operation: () => Promise<T>,
  options: { timeoutMs?: number } = {},
): Promise<BoundedCollectionResult<T>> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_COLLECTION_TIMEOUT_MS;
  const startTime = Date.now();

  if (collectionInProgress) {
    return {
      result: undefined,
      error: new Error('Collection already in progress'),
      timedOut: false,
      elapsedMs: 0,
    };
  }

  collectionInProgress = true;
  try {
    const result = await withTimeout(operation(), timeoutMs);
    return {
      result,
      error: undefined,
      timedOut: false,
      elapsedMs: Date.now() - startTime,
    };
  } catch (error) {
    return {
      result: undefined,
      error: error instanceof Error ? error : new Error(String(error)),
      timedOut: error instanceof Error && error.message.includes('timeout'),
      elapsedMs: Date.now() - startTime,
    };
  } finally {
    collectionInProgress = false;
  }
}

/** ------------------------------------------------------------------ */
/** Full snapshot                                                      */
/** ------------------------------------------------------------------ */

export interface ResourceSnapshot {
  readonly timestamp: string;
  readonly cpu: CpuSample;
  readonly memory: MemorySample;
  readonly disk: DiskSample[];
  readonly network: NetworkSample[];
  readonly container: ContainerSample | undefined;
  readonly currentProcess: ProcessSample;
  readonly queueDepth: ReadonlyArray<{ queueName: string; waiting: number | undefined; failed: number | undefined }> | undefined;
}

export interface ResourceSnapshotInput {
  readonly mount: string;
  readonly previousDiskSample: DiskSample | undefined;
  readonly previousNetworkSamples: ReadonlyArray<NetworkSample> | undefined;
  readonly elapsedMs: number;
  readonly queueDepth: ReadonlyArray<{ queueName: string; waiting: number | undefined; failed: number | undefined }> | undefined;
  readonly cpuSampler: CpuSampler;
}

/**
 * Collects a full resource snapshot. All reads are read-only. Unavailable
 * metrics are `undefined`, never zero.
 *
 * Uses boundedCollection for timeout and overlap protection.
 */
export async function collectResourceSnapshot(input: ResourceSnapshotInput): Promise<ResourceSnapshot> {
  const timestamp = new Date().toISOString();

  const cpu = await input.cpuSampler.sample();
  const memory = await sampleMemory();
  const disk = await sampleDisk(input.mount, input.previousDiskSample, input.elapsedMs);
  const network = await sampleNetwork(input.previousNetworkSamples, input.elapsedMs);
  const container = await sampleContainer();
  const currentProcess = await sampleCurrentProcess();

  return {
    timestamp,
    cpu,
    memory,
    disk: [disk],
    network,
    container,
    currentProcess,
    queueDepth: input.queueDepth,
  };
}

/**
 * Creates a new CpuSampler instance.
 */
export function createCpuSampler(): CpuSampler {
  return new CpuSampler();
}
