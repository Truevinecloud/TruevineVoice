/**
 * Host resource monitoring using existing operating-system facilities.
 *
 * Reads CPU load, memory, and filesystem usage from Node's built-in `os` and
 * `fs/promises` modules. `fs.statfs()` is used for disk statistics because it
 * is available cross-platform (Node.js 22.12+) without shelling out to `df`,
 * which is not available on Windows.
 *
 * All values are read-only snapshots. Unavailable metrics are `undefined`,
 * never zero.
 */

import { cpus, freemem, loadavg, totalmem } from 'node:os';
import { statfs } from 'node:fs/promises';

/**
 * Represents a sampled CPU load average over 1, 5, and 15 minutes.
 */
export interface CpuLoadSample {
  readonly load1: number;
  readonly load5: number;
  readonly load15: number;
  readonly cpuCount: number;
  /** Load1 divided by CPU count, as a percentage (0-100+). Undefined when CPU count is 0. */
  readonly loadPercent: number | undefined;
}

/**
 * Represents sampled host memory usage.
 */
export interface MemorySample {
  readonly totalBytes: number;
  readonly freeBytes: number;
  readonly usedBytes: number;
  /** Used memory as a percentage (0-100). */
  readonly usedPercent: number;
}

/**
 * Represents sampled filesystem usage for a single mount point.
 */
export interface DiskSample {
  readonly mount: string;
  readonly totalBytes: number;
  readonly freeBytes: number;
  readonly usedBytes: number;
  /** Free space as a percentage (0-100). */
  readonly freePercent: number;
}

/**
 * Samples host CPU load average.
 */
export function sampleCpuLoad(): CpuLoadSample {
  const [load1, load5, load15] = loadavg();
  const cpuInfos = cpus();
  const cpuCount = cpuInfos.length;
  const load1Value = load1 ?? 0;
  const loadPercent =
    cpuCount > 0 ? Math.round((load1Value / cpuCount) * 100 * 100) / 100 : undefined;
  return { load1: load1Value, load5: load5 ?? 0, load15: load15 ?? 0, cpuCount, loadPercent };
}

/**
 * Samples host memory usage.
 */
export function sampleMemory(): MemorySample {
  const totalBytes = totalmem();
  const freeBytes = freemem();
  const usedBytes = totalBytes - freeBytes;
  const usedPercent = Math.round((usedBytes / totalBytes) * 100 * 100) / 100;
  return { totalBytes, freeBytes, usedBytes, usedPercent };
}

/**
 * Samples filesystem usage for the given mount point (default `/`).
 *
 * Uses `fs.statfs()` which is available cross-platform on Node.js 22.12+.
 * Returns `undefined` when filesystem statistics cannot be read.
 */
export async function sampleDisk(mount = '/'): Promise<DiskSample | undefined> {
  try {
    const stats = await statfs(mount);
    const blockSize = Number(stats.bsize);
    const totalBlocks = Number(stats.blocks);
    const freeBlocks = Number(stats.bavail);

    if (!Number.isFinite(blockSize) || !Number.isFinite(totalBlocks)) {
      return undefined;
    }

    const totalBytes = blockSize * totalBlocks;
    // bavail is blocks available to unprivileged users; fall back to 0 when unavailable.
    const freeBytes = Number.isFinite(freeBlocks) ? blockSize * freeBlocks : 0;
    const usedBytes = totalBytes - freeBytes;
    const freePercent =
      totalBytes > 0 ? Math.round((freeBytes / totalBytes) * 100 * 100) / 100 : 0;

    return { mount, totalBytes, freeBytes, usedBytes, freePercent };
  } catch {
    return undefined;
  }
}

/**
 * Samples all host resources at once.
 */
export interface HostResourceSample {
  readonly cpu: CpuLoadSample;
  readonly memory: MemorySample;
  readonly disk: DiskSample | undefined;
}

export async function sampleHostResources(mount = '/'): Promise<HostResourceSample> {
  return {
    cpu: sampleCpuLoad(),
    memory: sampleMemory(),
    disk: await sampleDisk(mount),
  };
}
