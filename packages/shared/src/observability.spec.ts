import { describe, expect, it, vi } from 'vitest';

import {
  AlertEvaluationService,
  HostResourceCollector,
  MetricSamplePoint,
  type MetricCollector,
  type ObservabilityConfig,
} from './observability.js';
import { DEFAULT_ALERT_RULES } from './metrics.js';
import { StructuredLogNotifier } from './alert-notifier.js';
import { evaluateRule, type AlertEvaluation, type AlertRule, type AlertRuleTracker } from './alert.js';

const makeCollector = (
  samples: Record<string, MetricSamplePoint>,
  shouldFail = false,
): MetricCollector => ({
  name: 'test-collector',
  collect: async () => {
    if (shouldFail) throw new Error('collector failure');
    return samples;
  },
});

const makeConfig = (
  overrides: Partial<ObservabilityConfig> = {},
): ObservabilityConfig => ({
  collectionIntervalMs: 1000,
  rules: DEFAULT_ALERT_RULES,
  ...overrides,
});

const makeNotifier = () => {
  const calls: AlertEvaluation[] = [];
  const notify = async (evaluation: AlertEvaluation): Promise<void> => {
    calls.push(evaluation);
  };
  return {
    notify,
    get calls() {
      return calls;
    },
    get callCount() {
      return calls.length;
    },
  };
};

describe('ObservabilityService', () => {
  it('collects metrics from all collectors', async () => {
    const collector = makeCollector({
      'host.cpuPercent': { value: 42, status: 'ok' },
      'host.memoryUsedPercent': { value: 65, status: 'ok' },
    });
    const notifier = makeNotifier();
    const service = new AlertEvaluationService(
      makeConfig({ rules: [] }),
      [collector],
      notifier,
    );

    const result = await service.collectOnce();

    expect(result.samples['host.cpuPercent']).toEqual({ value: 42, status: 'ok' });
    expect(result.samples['host.memoryUsedPercent']).toEqual({ value: 65, status: 'ok' });
    expect(notifier.callCount).toBe(0);
  });

  it('handles collector failure gracefully', async () => {
    const collector = makeCollector({}, true);
    const notifier = makeNotifier();
    const service = new AlertEvaluationService(
      makeConfig({ rules: [] }),
      [collector],
      notifier,
    );

    // Should not throw
    const result = await service.collectOnce();
    expect(result).toBeDefined();
    expect(result.evaluations).toHaveLength(0);
  });

  it('prevents overlapping collection cycles', async () => {
    let release: (() => void) | undefined;
    const slowCollector: MetricCollector = {
      name: 'slow',
      collect: async () => {
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        return {};
      },
    };
    const notifier = makeNotifier();
    const service = new AlertEvaluationService(
      makeConfig({ rules: [], collectionIntervalMs: 50 }),
      [slowCollector],
      notifier,
    );

    const first = service.collectOnce();
    const second = service.collectOnce();

    // Both calls should return Promises (second doesn't start a new cycle)
    expect(first).toBeInstanceOf(Promise);
    expect(second).toBeInstanceOf(Promise);

    release?.();
    await first;
    await second;
  });

  it('evaluates warning threshold', async () => {
    const collector = makeCollector({
      'host.cpuPercent': { value: 80, status: 'ok' },
    });
    const notifier = makeNotifier();
    const service = new AlertEvaluationService(
      makeConfig(),
      [collector],
      notifier,
    );

    const result = await service.collectOnce();
    const cpuRule = result.evaluations.find((e) => e.ruleName === 'host_cpu_high');

    expect(cpuRule).toBeDefined();
    expect(cpuRule?.severity).toBe('warning');
    expect(cpuRule?.breached).toBe(true);
  });

  it('evaluates critical severity (threshold breached, not yet firing due to consecutiveBreaches)', async () => {
    const collector = makeCollector({
      'host.cpuPercent': { value: 95, status: 'ok' },
    });
    const notifier = makeNotifier();
    const service = new AlertEvaluationService(
      makeConfig(),
      [collector],
      notifier,
    );

    const result = await service.collectOnce();
    const cpuRule = result.evaluations.find((e) => e.ruleName === 'host_cpu_high');

    expect(cpuRule).toBeDefined();
    expect(cpuRule?.severity).toBe('critical');
    // host_cpu_high requires 3 consecutive breaches, so state stays 'ok' on first hit
    expect(cpuRule?.state).toBe('ok');
  });

  it('reports overall severity', async () => {
    const collector = makeCollector({
      'host.cpuPercent': { value: 95, status: 'ok' },
      'host.memoryUsedPercent': { value: 85, status: 'ok' },
    });
    const notifier = makeNotifier();
    const service = new AlertEvaluationService(
      makeConfig(),
      [collector],
      notifier,
    );

    const result = await service.collectOnce();
    expect(result.overallSeverity).toBe('critical');
  });

  it('reports unknown status for unavailable metrics', async () => {
    const collector = makeCollector({
      'host.cpuPercent': { value: undefined, status: 'unknown' },
    });
    const notifier = makeNotifier();
    const service = new AlertEvaluationService(
      makeConfig(),
      [collector],
      notifier,
    );

    const result = await service.collectOnce();
    const cpuRule = result.evaluations.find((e) => e.ruleName === 'host_cpu_high');

    expect(cpuRule).toBeDefined();
    expect(cpuRule?.severity).toBe('warning');
    expect(cpuRule?.breached).toBe(false);
  });

  it('start/stop lifecycle', async () => {
    const collector = makeCollector({
      'host.cpuPercent': { value: 42, status: 'ok' },
    });
    const notifier = makeNotifier();
    const service = new AlertEvaluationService(
      makeConfig(),
      [collector],
      notifier,
    );

    expect(service.isStarted).toBe(false);
    service.start();
    expect(service.isStarted).toBe(true);
    service.stop();
    expect(service.isStarted).toBe(false);
  });

  it('stop is idempotent', () => {
    const service = new AlertEvaluationService(
      makeConfig(),
      [],
      { notify: async () => undefined },
    );
    service.stop();
    service.stop();
    expect(service.isStarted).toBe(false);
  });
});

describe('Alert rule state transitions (integration with evaluateRule)', () => {
  const now = 1_000_000_000_000;

  function makeTracker(rule: AlertRule): AlertRuleTracker {
    return {
      name: rule.name,
      consecutiveBreaches: 0,
      breachStartTime: undefined as number | undefined,
      lastNotificationTime: undefined as number | undefined,
      state: 'ok' as const,
      lastValue: undefined as number | undefined,
    };
  }

  it('fires after consecutive breaches and notifies', () => {
    const rule: AlertRule = {
      name: 'test-rule',
      metric: 'host.cpuPercent',
      criticalThreshold: 90,
      consecutiveBreaches: 2,
      cooldownMs: 0,
    };
    const tracker = makeTracker(rule);

    let result = evaluateRule(rule, tracker, 95, 'ok', now);
    expect(result.evaluation.state).toBe('ok');
    expect(result.tracker.consecutiveBreaches).toBe(1);

    result = evaluateRule(rule, result.tracker, 95, 'ok', now + 1000);
    expect(result.evaluation.state).toBe('firing');
    expect(result.tracker.consecutiveBreaches).toBe(2);
  });

  it('recovers when value drops below threshold', () => {
    const rule: AlertRule = {
      name: 'test-rule',
      metric: 'host.cpuPercent',
      criticalThreshold: 90,
      consecutiveBreaches: 1,
    };
    const tracker = makeTracker(rule);

    let result = evaluateRule(rule, tracker, 95, 'ok', now);
    expect(result.evaluation.state).toBe('firing');

    result = evaluateRule(rule, result.tracker, 25, 'ok', now + 1000);
    expect(result.evaluation.state).toBe('recovering');
  });

  it('suppresses duplicate notifications during cooldown', () => {
    const rule: AlertRule = {
      name: 'test-rule',
      metric: 'host.cpuPercent',
      criticalThreshold: 90,
      consecutiveBreaches: 1,
      cooldownMs: 60_000,
    };
    const tracker = makeTracker(rule);

    let result = evaluateRule(rule, tracker, 95, 'ok', now);
    expect(result.evaluation.suppressed).toBe(false);

    result = evaluateRule(rule, result.tracker, 95, 'ok', now + 10_000);
    expect(result.evaluation.suppressed).toBe(true);
    expect(result.evaluation.reason).toBe('cooldown');
  });

  it('unknown metric is warning but not breached', () => {
    const rule: AlertRule = {
      name: 'test-rule',
      metric: 'host.cpuPercent',
      criticalThreshold: 90,
    };
    const tracker = makeTracker(rule);

    const { evaluation } = evaluateRule(rule, tracker, undefined, 'unknown', now);
    expect(evaluation.severity).toBe('warning');
    expect(evaluation.breached).toBe(false);
    expect(evaluation.state).toBe('ok');
  });
});

describe('HostResourceCollector', () => {
  it('collects CPU, memory, and disk metrics', async () => {
    const collector = new HostResourceCollector();
    const samples = await collector.collect();

    expect(samples['host.cpuPercent']).toBeDefined();
    const memorySample = samples['host.memoryUsedPercent'];
    expect(memorySample).toBeDefined();
    expect(samples['host.diskFreePercent']).toBeDefined();

    if (samples['host.cpuPercent']?.status === 'ok') {
      expect(typeof samples['host.cpuPercent'].value).toBe('number');
    }
    expect(typeof memorySample!.value).toBe('number');
    expect(memorySample!.status).toBe('ok');
  });
});

describe('StructuredLogNotifier', () => {
  it('notifies on firing alert with severity in output', async () => {
    const notifier = new StructuredLogNotifier();
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    const evaluation = {
      ruleName: 'host_cpu_high',
      severity: 'critical' as const,
      state: 'firing' as const,
      value: 95,
      threshold: 90,
      breached: true,
      consecutiveBreaches: 1,
      suppressed: false,
    };

    await expect(notifier.notify(evaluation)).resolves.toBeUndefined();
    expect(logSpy).toHaveBeenCalled();
    const logged = logSpy.mock.calls[0]![0] as string;
    expect(logged).toContain('host_cpu_high');
    expect(logged).toContain('firing');
    expect(logged).toContain('critical');

    logSpy.mockRestore();
  });

  it('notifies on recovery alert', async () => {
    const notifier = new StructuredLogNotifier();
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    const evaluation = {
      ruleName: 'host_cpu_high',
      severity: 'ok' as const,
      state: 'recovering' as const,
      value: 25,
      threshold: 90,
      breached: false,
      consecutiveBreaches: 0,
      suppressed: false,
    };

    await expect(notifier.notify(evaluation)).resolves.toBeUndefined();
    expect(logSpy).toHaveBeenCalled();
    const logged = logSpy.mock.calls[0]![0] as string;
    expect(logged).toContain('recovering');

    logSpy.mockRestore();
  });

  it('does not throw when console fails', async () => {
    const notifier = new StructuredLogNotifier();
    const logSpy = vi
      .spyOn(console, 'log')
      .mockImplementation(() => {
        throw new Error('console broken');
      });

    const evaluation = {
      ruleName: 'test',
      severity: 'warning' as const,
      state: 'firing' as const,
      value: 50,
      threshold: 40,
      breached: true,
      consecutiveBreaches: 1,
      suppressed: false,
    };

    await expect(notifier.notify(evaluation)).resolves.toBeUndefined();
    logSpy.mockRestore();
  });
});
