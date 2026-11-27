/**
 * Operational metric types shared by the API and worker.
 *
 * These types are dependency-free so any package can reference them without
 * pulling in BullMQ, NestJS, or an HTTP framework.
 *
 * All metrics are read-only snapshots: they are collected for observability,
 * never used to make business decisions. Unavailable metrics are represented
 * as `unknown`, never as zero.
 */

/** Status of a single metric sample. */
export type MetricStatus = 'ok' | 'degraded' | 'unknown';

/** Base shape for every metric sample. */
export interface MetricSample {
  readonly status: MetricStatus;
  /** ISO-8601 timestamp when the sample was taken. */
  readonly timestamp: string;
  /** Human-readable error when status is not `ok`. Safe to log. */
  readonly error?: string;
}

/** Queue depth sample from BullMQ. */
export interface QueueDepthSample extends MetricSample {
  readonly queueName: string;
  /** Number of jobs waiting to be processed. */
  readonly waiting: number | undefined;
  /** Number of jobs currently being processed. */
  readonly active: number | undefined;
  /** Number of jobs delayed for future processing. */
  readonly delayed: number | undefined;
  /** Number of jobs that have failed all retry attempts. */
  readonly failed: number | undefined;
  /** Age in milliseconds of the oldest waiting job, when supported. */
  readonly oldestWaitingAgeMs: number | undefined;
}

/** A snapshot of all queue metrics collected at one moment. */
export interface QueueMetricsSnapshot {
  readonly timestamp: string;
  readonly queues: Readonly<Record<string, QueueDepthSample>>;
}

/** A snapshot of host resource metrics collected at one moment. */
export interface HostResourceSnapshot {
  readonly timestamp: string;
  readonly cpuPercent: number | undefined;
  readonly memoryTotalBytes: number | undefined;
  readonly memoryFreeBytes: number | undefined;
  readonly memoryUsedBytes: number | undefined;
  readonly diskTotalBytes: number | undefined;
  readonly diskFreeBytes: number | undefined;
}

/** Result of evaluating a metric against a threshold. */
export interface ThresholdResult {
  readonly metric: string;
  readonly value: number | undefined;
  readonly status: MetricStatus;
  readonly severity: 'ok' | 'warning' | 'critical';
  readonly breached: boolean;
}

/** Severity classification for an alert. */
export type AlertSeverity = 'ok' | 'warning' | 'critical';

/** Current state of an alert rule. */
export type AlertState = 'ok' | 'firing' | 'recovering';

/**
 * An alert rule definition. Thresholds are evaluated sequentially: if a value
 * breaches `critical`, severity is `critical`; otherwise if it breaches
 * `warning`, severity is `warning`.
 */
export interface AlertRule {
  readonly name: string;
  readonly metric: string;
  /** Threshold above which a warning is raised. */
  readonly warningThreshold?: number;
  /** Threshold above which a critical alert is raised. */
  readonly criticalThreshold?: number;
  /** Number of consecutive breaches required before firing. */
  readonly consecutiveBreaches?: number;
  /** Minimum duration in ms the breach must be sustained before firing. */
  readonly sustainedForMs?: number;
  /** Cooldown in ms between repeated notifications for the same alert. */
  readonly cooldownMs?: number;
}

/** The result of evaluating a single alert rule against a metric sample. */
export interface AlertEvaluation {
  readonly ruleName: string;
  readonly severity: AlertSeverity;
  readonly state: AlertState;
  readonly value: number | undefined;
  readonly threshold: number | undefined;
  readonly breached: boolean;
  readonly consecutiveBreaches: number;
  readonly suppressed: boolean;
  readonly reason?: string;
}

/**
 * Default alert rules for observability.
 *
 * These thresholds are starting points for an isolated MVP deployment. They
 * are not activated by default: notification delivery is a no-op until
 * explicitly configured.
 */
export const DEFAULT_ALERT_RULES: Readonly<AlertRule[]> = Object.freeze([
  {
    name: 'queue_depth_high',
    metric: 'queue.waiting',
    warningThreshold: 50,
    criticalThreshold: 100,
    consecutiveBreaches: 2,
    sustainedForMs: 60_000,
    cooldownMs: 300_000,
  },
  {
    name: 'queue_depth_critical',
    // Evaluates queue.failed (failed jobs), NOT queue.waiting (backlog).
    // Failed jobs are evaluated independently of queue depth: a queue can be
    // empty (waiting=0) while still having failed jobs that need attention.
    metric: 'queue.failed',
    warningThreshold: 5,
    criticalThreshold: 10,
    consecutiveBreaches: 1,
    sustainedForMs: 0,
    cooldownMs: 600_000,
  },
  {
    name: 'host_cpu_high',
    metric: 'host.cpuPercent',
    warningThreshold: 75,
    criticalThreshold: 90,
    consecutiveBreaches: 3,
    sustainedForMs: 120_000,
    cooldownMs: 300_000,
  },
  {
    name: 'host_memory_high',
    metric: 'host.memoryUsedPercent',
    warningThreshold: 80,
    criticalThreshold: 90,
    consecutiveBreaches: 3,
    sustainedForMs: 120_000,
    cooldownMs: 300_000,
  },
  {
    name: 'host_disk_low',
    metric: 'host.diskFreePercent',
    warningThreshold: 20,
    criticalThreshold: 10,
    consecutiveBreaches: 2,
    sustainedForMs: 300_000,
    cooldownMs: 600_000,
  },
  {
    name: 'queue_oldest_waiting_age',
    metric: 'queue.oldestWaitingAgeMs',
    warningThreshold: 300_000,
    criticalThreshold: 900_000,
    consecutiveBreaches: 2,
    sustainedForMs: 60_000,
    cooldownMs: 300_000,
  },
  {
    name: 'provider_failures',
    metric: 'provider.failures',
    warningThreshold: 1,
    criticalThreshold: 5,
    consecutiveBreaches: 1,
    sustainedForMs: 0,
    cooldownMs: 300_000,
  },
  {
    name: 'payment_failures',
    metric: 'payment.failures',
    warningThreshold: 1,
    criticalThreshold: 5,
    consecutiveBreaches: 1,
    sustainedForMs: 0,
    cooldownMs: 300_000,
  },
] as const);

/**
 * Computes memory used percentage from total and free bytes.
 */
export function memoryUsedPercent(
  totalBytes: number | undefined,
  freeBytes: number | undefined,
): number | undefined {
  if (totalBytes === undefined || freeBytes === undefined || totalBytes <= 0) return undefined;
  return Math.round(((totalBytes - freeBytes) / totalBytes) * 100);
}

/**
 * Computes disk free percentage from total and free bytes.
 */
export function diskFreePercent(
  totalBytes: number | undefined,
  freeBytes: number | undefined,
): number | undefined {
  if (totalBytes === undefined || freeBytes === undefined || totalBytes <= 0) return undefined;
  return Math.round((freeBytes / totalBytes) * 100);
}
