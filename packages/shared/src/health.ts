/**
 * Health reporting primitives shared by the API and the worker.
 *
 * These types are intentionally dependency-free so that any package (domain,
 * telephony, ...) can reference them without pulling in an HTTP framework.
 */

/** Result of probing a single infrastructure dependency. */
export type DependencyStatus = 'up' | 'down';

/** Outcome of a single dependency probe. */
export interface DependencyHealth {
  readonly status: DependencyStatus;
  /** Wall-clock duration of the probe, in milliseconds. */
  readonly latencyMs: number;
  /** Present only when `status` is `down`. Safe to log; must never contain credentials. */
  readonly error?: string;
}

/**
 * Overall service health.
 *
 * `ok`       - every probed dependency answered successfully.
 * `degraded` - at least one dependency failed; the service cannot be trusted
 *              to serve traffic even though the process is alive.
 */
export type OverallHealthStatus = 'ok' | 'degraded';

/** Structured health payload returned by `GET /health`. */
export interface HealthReport {
  readonly status: OverallHealthStatus;
  readonly service: string;
  readonly version: string;
  readonly environment: string;
  readonly uptimeSeconds: number;
  /** ISO-8601 timestamp of the moment the report was produced. */
  readonly timestamp: string;
  readonly dependencies: Readonly<Record<string, DependencyHealth>>;
}

/** HTTP status code to return for each overall health status. */
export const HEALTH_STATUS_HTTP_CODE: Readonly<Record<OverallHealthStatus, number>> = {
  ok: 200,
  degraded: 503,
};

/**
 * Derives the overall status from a set of dependency probes.
 *
 * An empty dependency map resolves to `ok`: a process that declares no
 * dependencies cannot be degraded by them.
 */
export function overallStatusFrom(
  dependencies: Readonly<Record<string, DependencyHealth>>,
): OverallHealthStatus {
  return Object.values(dependencies).every((dependency) => dependency.status === 'up')
    ? 'ok'
    : 'degraded';
}
