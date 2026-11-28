/**
 * Observability integration layer.
 *
 * Collects metrics from multiple sources, evaluates them against alert rules,
 * and notifies on state changes. Framework-agnostic: no NestJS, no BullMQ,
 * no HTTP framework. All reads are read-only: collection never mutates
 * queue state, payment state, or provider state.
 *
 * Alert state is held in memory only. It does not survive process restarts,
 * and multiple application instances running this service independently may
 * each emit notifications for the same condition. A production deployment
 * should externalize alert state (e.g., Redis) and deduplicate notifications
 * before delivery.
 */

import type {
  AlertRule,
  AlertEvaluation,
  AlertSeverity,
  MetricStatus,
  QueueDepthSample,
} from './metrics.js';
import { evaluateAll, type AlertRuleTracker } from './alert.js';
import { sampleHostResources } from './resources.js';

/** A single metric sample in the flat namespace used by alert rules. */
export interface MetricSamplePoint {
  readonly value: number | undefined;
  readonly status: MetricStatus;
}

/** Result of a single collection cycle. */
export interface CollectionResult {
  readonly timestamp: string;
  readonly samples: Readonly<Record<string, MetricSamplePoint>>;
  readonly evaluations: Readonly<AlertEvaluation[]>;
  readonly firing: Readonly<AlertEvaluation[]>;
  readonly recovering: Readonly<AlertEvaluation[]>;
  readonly overallSeverity: AlertSeverity;
}

/** A collector produces metric samples from a specific source. */
export interface MetricCollector {
  readonly name: string;
  collect(): Promise<Readonly<Record<string, MetricSamplePoint>>>;
}

/** Configuration for the observability service. */
export interface ObservabilityConfig {
  readonly collectionIntervalMs: number;
  readonly rules: Readonly<AlertRule[]>;
}

/**
 * Collects host resource metrics (CPU, memory, disk).
 *
 * Unavailable metrics are reported as `undefined` with `unknown` status,
 * never as zero or healthy.
 */
export class HostResourceCollector implements MetricCollector {
  readonly name = 'host-resources';

  async collect(): Promise<Readonly<Record<string, MetricSamplePoint>>> {
    const resources = await sampleHostResources();
    const samples: Record<string, MetricSamplePoint> = {};

    const cpuPercent = resources.cpu.loadPercent;
    samples['host.cpuPercent'] = {
      value: cpuPercent,
      status: cpuPercent === undefined ? 'unknown' : 'ok',
    };

    samples['host.memoryUsedPercent'] = {
      value: resources.memory.usedPercent,
      status: 'ok',
    };

    const diskFreePercent = resources.disk?.freePercent;
    samples['host.diskFreePercent'] = {
      value: diskFreePercent,
      status: diskFreePercent === undefined ? 'unknown' : 'ok',
    };

    return samples;
  }
}

/**
 * Collects queue depth metrics from BullMQ queues.
 */
export class QueueMetricCollector implements MetricCollector {
  readonly name: string;

  constructor(
    readonly queueName: string,
    readonly collectQueueDepth: () => Promise<QueueDepthSample>,
  ) {
    this.name = `queue:${queueName}`;
  }

  async collect(): Promise<Readonly<Record<string, MetricSamplePoint>>> {
    let sample: QueueDepthSample;
    try {
      sample = await this.collectQueueDepth();
    } catch {
      return {
        'queue.waiting': { value: undefined, status: 'unknown' },
        'queue.failed': { value: undefined, status: 'unknown' },
        'queue.oldestWaitingAgeMs': { value: undefined, status: 'unknown' },
      };
    }

    return {
      'queue.waiting': {
        value: sample.waiting,
        status: sample.status,
      },
      'queue.failed': {
        value: sample.failed,
        status: sample.status,
      },
      'queue.oldestWaitingAgeMs': {
        value: sample.oldestWaitingAgeMs,
        status: sample.status,
      },
    };
  }
}

/**
 * Accumulator for provider failure counts.
 *
 * Call `record()` when a provider failure is observed. `snapshot()` returns
 * the current count and resets it to zero for the next collection window.
 */
export class ProviderFailureCounter {
  private count = 0;

  /** Records a provider failure observation. Safe to call from any context. */
  record(): void {
    this.count += 1;
  }

  /** Returns the current failure count and resets the accumulator. */
  snapshot(): number {
    const current = this.count;
    this.count = 0;
    return current;
  }

  /** Returns the current count without resetting. */
  get current(): number {
    return this.count;
  }
}

/**
 * Accumulator for payment failure counts.
 *
 * Call `record()` when a payment failure is observed. `snapshot()` returns
 * the current count and resets it to zero for the next collection window.
 */
export class PaymentFailureCounter {
  private count = 0;

  /** Records a payment failure observation. Safe to call from any context. */
  record(): void {
    this.count += 1;
  }

  /** Returns the current failure count and resets the accumulator. */
  snapshot(): number {
    const current = this.count;
    this.count = 0;
    return current;
  }

  /** Returns the current count without resetting. */
  get current(): number {
    return this.count;
  }
}

/**
 * Evaluates alert rules against collected metrics on a timer.
 *
 * Prevents overlapping collection cycles. Handles unavailable metrics safely.
 * Maintains alert evaluation state across cycles. Notifies on state changes
 * (firing, recovering) through the provided notifier.
 */
export class AlertEvaluationService {
  private readonly trackers = new Map<string, AlertRuleTracker>();
  private timer: NodeJS.Timeout | undefined;
  private collecting = false;
  private lastEvaluations: AlertEvaluation[] = [];
  private lastSamples: Record<string, MetricSamplePoint> = {};
  private readonly config: ObservabilityConfig;
  private readonly collectors: MetricCollector[];
  private readonly notifier: { notify(evaluation: AlertEvaluation): Promise<void> };
  private started = false;

  constructor(
    config: ObservabilityConfig,
    collectors: MetricCollector[],
    notifier: { notify(evaluation: AlertEvaluation): Promise<void> },
  ) {
    this.config = config;
    this.collectors = collectors;
    this.notifier = notifier;
  }

  /** Start periodic collection and alert evaluation. */
  start(): void {
    if (this.started) return;
    this.started = true;
    this.scheduleNext();
  }

  /** Stop collection and clear timers. Safe to call multiple times. */
  stop(): void {
    if (this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    this.started = false;
    this.collecting = false;
  }

  /** Whether the service has been started. */
  get isStarted(): boolean {
    return this.started;
  }

  /** Whether a collection cycle is currently in progress. */
  get isCollecting(): boolean {
    return this.collecting;
  }

  /** Current alert state for dashboard consumers. */
  get state(): CollectionResult {
    return {
      timestamp: new Date().toISOString(),
      samples: { ...this.lastSamples },
      evaluations: this.lastEvaluations,
      firing: this.lastEvaluations.filter((e) => e.state === 'firing'),
      recovering: this.lastEvaluations.filter((e) => e.state === 'recovering'),
      overallSeverity: this.overallSeverity(this.lastEvaluations),
    };
  }

  /** Perform one collection + evaluation cycle on demand. */
  async collectOnce(): Promise<CollectionResult> {
    if (this.collecting) {
      // Prevent overlapping cycles: return last known state
      return this.state;
    }

    this.collecting = true;
    try {
      return await this.runCycle();
    } finally {
      this.collecting = false;
    }
  }

  private scheduleNext(): void {
    this.timer = setInterval(async () => {
      try {
        await this.collectOnce();
      } catch {
        // Collection failures must not interrupt the service
      }
    }, this.config.collectionIntervalMs);

    // Do not keep the process alive if this is the only outstanding handle
    this.timer.unref?.();
  }

  private async runCycle(): Promise<CollectionResult> {
    const samples: Record<string, MetricSamplePoint> = {};

    for (const collector of this.collectors) {
      try {
        const collectorSamples = await collector.collect();
        for (const [key, value] of Object.entries(collectorSamples)) {
          samples[key] = value;
        }
      } catch {
        // Individual collector failures are safe: metrics remain unavailable
      }
    }

    const { evaluations, trackers } = evaluateAll(
      this.config.rules,
      this.trackers,
      samples as Record<string, { value: number | undefined; status: MetricStatus }>,
    );

    this.trackers.clear();
    for (const [key, value] of trackers) {
      this.trackers.set(key, value);
    }

    const firing = evaluations.filter((e) => e.state === 'firing');
    const recovering = evaluations.filter((e) => e.state === 'recovering');
    const overallSeverity = this.overallSeverity(evaluations);

    // Keep the most recent complete cycle available to read-only consumers
    // such as the worker observability controller. A copy prevents callers
    // from mutating the service's internal snapshot.
    this.lastSamples = { ...samples };

    const result: CollectionResult = {
      timestamp: new Date().toISOString(),
      samples,
      evaluations,
      firing,
      recovering,
      overallSeverity,
    };

    await this.notifyChanges(result);
    return result;
  }

  private overallSeverity(evaluations: Readonly<AlertEvaluation[]>): AlertSeverity {
    let highest: AlertSeverity = 'ok';
    for (const e of evaluations) {
      if (e.severity === 'critical') return 'critical';
      if (e.severity === 'warning') highest = 'warning';
    }
    return highest;
  }

  private async notifyChanges(result: CollectionResult): Promise<void> {
    const previousByRule = new Map(this.lastEvaluations.map((e) => [e.ruleName, e]));

    for (const evaluation of result.evaluations) {
      const previous = previousByRule.get(evaluation.ruleName);

      // Notify on transition into firing or into recovering
      if (evaluation.state === 'firing' && previous?.state !== 'firing') {
        await this.notifier.notify(evaluation).catch(() => undefined);
      } else if (
        evaluation.state === 'recovering' &&
        previous?.state === 'firing'
      ) {
        await this.notifier.notify(evaluation).catch(() => undefined);
      }
    }

    this.lastEvaluations = [...result.evaluations];
  }
}
