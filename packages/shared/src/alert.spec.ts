import { describe, expect, it } from 'vitest';

import {
  evaluateAll,
  evaluateRule,
  firingEvaluations,
  highestSeverity,
  NoopAlertNotifier,
  recoveringEvaluations,
  type AlertEvaluation,
  type AlertRule,
} from './alert.js';
import { DEFAULT_ALERT_RULES, type MetricStatus } from './metrics.js';

describe('alert evaluation', () => {
  const now = 1_000_000_000_000;

  function makeTracker(rule: AlertRule) {
    return {
      name: rule.name,
      consecutiveBreaches: 0,
      breachStartTime: undefined as number | undefined,
      lastNotificationTime: undefined as number | undefined,
      state: 'ok' as const,
      lastValue: undefined as number | undefined,
    };
  }

  it('evaluates ok when below warning threshold', () => {
    const rule: AlertRule = {
      name: 'test-rule',
      metric: 'test.metric',
      warningThreshold: 50,
      criticalThreshold: 100,
    };
    const tracker = makeTracker(rule);

    const { evaluation, tracker: updated } = evaluateRule(
      rule,
      tracker,
      25,
      'ok',
      now,
    );

    expect(evaluation.severity).toBe('ok');
    expect(evaluation.breached).toBe(false);
    expect(evaluation.state).toBe('ok');
    expect(updated.state).toBe('ok');
  });

  it('evaluates warning when above warning but below critical', () => {
    const rule: AlertRule = {
      name: 'test-rule',
      metric: 'test.metric',
      warningThreshold: 50,
      criticalThreshold: 100,
    };
    const tracker = makeTracker(rule);

    const { evaluation, tracker: updated } = evaluateRule(
      rule,
      tracker,
      75,
      'ok',
      now,
    );

    expect(evaluation.severity).toBe('warning');
    expect(evaluation.breached).toBe(true);
    expect(evaluation.threshold).toBe(50);
    expect(updated.consecutiveBreaches).toBe(1);
  });

  it('evaluates critical when above critical threshold', () => {
    const rule: AlertRule = {
      name: 'test-rule',
      metric: 'test.metric',
      warningThreshold: 50,
      criticalThreshold: 100,
    };
    const tracker = makeTracker(rule);

    const { evaluation, tracker: updated } = evaluateRule(
      rule,
      tracker,
      150,
      'ok',
      now,
    );

    expect(evaluation.severity).toBe('critical');
    expect(evaluation.breached).toBe(true);
    expect(evaluation.threshold).toBe(100);
    expect(updated.state).toBe('firing');
  });

  it('requires consecutive breaches before firing', () => {
    const rule: AlertRule = {
      name: 'test-rule',
      metric: 'test.metric',
      warningThreshold: 50,
      criticalThreshold: 100,
      consecutiveBreaches: 3,
    };
    const tracker = makeTracker(rule);

    // First two breaches should not fire
    let result = evaluateRule(rule, tracker, 150, 'ok', now);
    expect(result.evaluation.state).toBe('ok');
    expect(result.tracker.consecutiveBreaches).toBe(1);

    result = evaluateRule(rule, result.tracker, 150, 'ok', now + 1000);
    expect(result.evaluation.state).toBe('ok');
    expect(result.tracker.consecutiveBreaches).toBe(2);

    // Third breach fires
    result = evaluateRule(rule, result.tracker, 150, 'ok', now + 2000);
    expect(result.evaluation.state).toBe('firing');
    expect(result.tracker.consecutiveBreaches).toBe(3);
  });

  it('requires sustained breach duration before firing', () => {
    const rule: AlertRule = {
      name: 'test-rule',
      metric: 'test.metric',
      warningThreshold: 50,
      criticalThreshold: 100,
      sustainedForMs: 60_000,
    };
    const tracker = makeTracker(rule);

    // Breach starts but not sustained long enough
    let result = evaluateRule(rule, tracker, 150, 'ok', now);
    expect(result.evaluation.state).toBe('ok');

    // Still not sustained
    result = evaluateRule(rule, result.tracker, 150, 'ok', now + 30_000);
    expect(result.evaluation.state).toBe('ok');

    // Now sustained
    result = evaluateRule(rule, result.tracker, 150, 'ok', now + 70_000);
    expect(result.evaluation.state).toBe('firing');
  });

  it('suppresses notifications during cooldown', () => {
    const rule: AlertRule = {
      name: 'test-rule',
      metric: 'test.metric',
      criticalThreshold: 100,
      cooldownMs: 300_000,
    };
    const tracker = makeTracker(rule);

    // First breach fires and sets notification time
    let result = evaluateRule(rule, tracker, 150, 'ok', now);
    expect(result.evaluation.suppressed).toBe(false);
    expect(result.tracker.lastNotificationTime).toBe(now);

    // Immediate re-evaluation is suppressed
    result = evaluateRule(rule, result.tracker, 150, 'ok', now + 10_000);
    expect(result.evaluation.suppressed).toBe(true);
    expect(result.evaluation.reason).toBe('cooldown');

    // After cooldown, not suppressed
    result = evaluateRule(rule, result.tracker, 150, 'ok', now + 400_000);
    expect(result.evaluation.suppressed).toBe(false);
  });

  it('detects recovery after firing', () => {
    const rule: AlertRule = {
      name: 'test-rule',
      metric: 'test.metric',
      criticalThreshold: 100,
    };
    const tracker = makeTracker(rule);

    // Fire
    let result = evaluateRule(rule, tracker, 150, 'ok', now);
    expect(result.evaluation.state).toBe('firing');

    // Recover: value drops below threshold
    result = evaluateRule(rule, result.tracker, 25, 'ok', now + 1000);
    expect(result.evaluation.state).toBe('recovering');
  });

  it('represents unknown metrics as warning but not breached', () => {
    const rule: AlertRule = {
      name: 'test-rule',
      metric: 'test.metric',
      warningThreshold: 50,
      criticalThreshold: 100,
    };
    const tracker = makeTracker(rule);

    const { evaluation } = evaluateRule(rule, tracker, undefined, 'unknown', now);
    expect(evaluation.severity).toBe('warning');
    expect(evaluation.breached).toBe(false);
    expect(evaluation.state).toBe('ok');
  });

  it('evaluateAll processes multiple rules', () => {
    const rules: AlertRule[] = [
      { name: 'rule-a', metric: 'metric-a', warningThreshold: 50 },
      { name: 'rule-b', metric: 'metric-b', criticalThreshold: 100 },
    ];
    const trackers = new Map<string, ReturnType<typeof makeTracker>>();
    const samples: Record<string, { value: number | undefined; status: MetricStatus }> = {
      'metric-a': { value: 75, status: 'ok' },
      'metric-b': { value: 150, status: 'ok' },
    };

    const { evaluations } = evaluateAll(rules, trackers, samples, now);

    expect(evaluations).toHaveLength(2);
    const ruleA = evaluations.find((e) => e.ruleName === 'rule-a');
    const ruleB = evaluations.find((e) => e.ruleName === 'rule-b');
    expect(ruleA?.severity).toBe('warning');
    expect(ruleB?.severity).toBe('critical');
  });

  it('highestSeverity returns the worst severity', () => {
    expect(
      highestSeverity([
        { ruleName: 'a', severity: 'ok', state: 'ok', value: 1, threshold: undefined, breached: false, consecutiveBreaches: 0, suppressed: false },
        { ruleName: 'b', severity: 'warning', state: 'firing', value: 2, threshold: 50, breached: true, consecutiveBreaches: 1, suppressed: false },
      ]),
    ).toBe('warning');

    expect(
      highestSeverity([
        { ruleName: 'a', severity: 'ok', state: 'ok', value: 1, threshold: undefined, breached: false, consecutiveBreaches: 0, suppressed: false },
        { ruleName: 'b', severity: 'critical', state: 'firing', value: 2, threshold: 100, breached: true, consecutiveBreaches: 1, suppressed: false },
      ]),
    ).toBe('critical');
  });

  it('firingEvaluations returns only firing evaluations', () => {
    const evaluations: AlertEvaluation[] = [
      { ruleName: 'a', severity: 'ok', state: 'ok', value: 1, threshold: undefined, breached: false, consecutiveBreaches: 0, suppressed: false },
      { ruleName: 'b', severity: 'critical', state: 'firing', value: 2, threshold: 100, breached: true, consecutiveBreaches: 1, suppressed: false },
      { ruleName: 'c', severity: 'warning', state: 'recovering', value: 3, threshold: 50, breached: true, consecutiveBreaches: 0, suppressed: false },
    ];

    expect(firingEvaluations(evaluations)).toHaveLength(1);
    expect(firingEvaluations(evaluations)[0]?.ruleName).toBe('b');
  });

  it('recoveringEvaluations returns only recovering evaluations', () => {
    const evaluations: AlertEvaluation[] = [
      { ruleName: 'a', severity: 'ok', state: 'ok', value: 1, threshold: undefined, breached: false, consecutiveBreaches: 0, suppressed: false },
      { ruleName: 'b', severity: 'critical', state: 'firing', value: 2, threshold: 100, breached: true, consecutiveBreaches: 1, suppressed: false },
      { ruleName: 'c', severity: 'warning', state: 'recovering', value: 3, threshold: 50, breached: true, consecutiveBreaches: 0, suppressed: false },
    ];

    expect(recoveringEvaluations(evaluations)).toHaveLength(1);
    expect(recoveringEvaluations(evaluations)[0]?.ruleName).toBe('c');
  });

  it('NoopAlertNotifier does nothing', async () => {
    const notifier = new NoopAlertNotifier();
    expect(notifier.name).toBe('noop');

    const evaluation: AlertEvaluation = {
      ruleName: 'test',
      severity: 'critical',
      state: 'firing',
      value: 999,
      threshold: undefined,
      breached: true,
      consecutiveBreaches: 1,
      suppressed: false,
    };

    await expect(notifier.notify(evaluation)).resolves.toBeUndefined();
  });

  it('DEFAULT_ALERT_RULES are used by evaluateAll', () => {
    const trackers = new Map<string, ReturnType<typeof makeTracker>>();
    const samples: Record<string, { value: number | undefined; status: MetricStatus }> = {
      'queue.waiting': { value: 200, status: 'ok' },
    };

    const { evaluations } = evaluateAll(
      DEFAULT_ALERT_RULES,
      trackers,
      samples,
      now,
    );

    const queueRule = evaluations.find((e) => e.ruleName === 'queue_depth_high');
    expect(queueRule).toBeDefined();
    expect(queueRule?.breached).toBe(true);
    expect(queueRule?.severity).toBe('critical');
  });

  it('failed jobs fire independently of waiting queue depth', () => {
    const trackers = new Map<string, ReturnType<typeof makeTracker>>();
    const samples: Record<string, { value: number | undefined; status: MetricStatus }> = {
      // No jobs waiting, but 15 jobs have failed (above critical threshold of 10)
      'queue.waiting': { value: 0, status: 'ok' },
      'queue.failed': { value: 15, status: 'ok' },
    };

    const { evaluations } = evaluateAll(
      DEFAULT_ALERT_RULES,
      trackers,
      samples,
      now,
    );

    // queue_depth_critical fires on queue.failed=15 (critical threshold=10)
    const failedRule = evaluations.find((e) => e.ruleName === 'queue_depth_critical');
    expect(failedRule).toBeDefined();
    expect(failedRule?.breached).toBe(true);
    expect(failedRule?.severity).toBe('critical');
    expect(failedRule?.value).toBe(15);

    // queue_depth_high does NOT fire (queue.waiting=0, below warning threshold of 50)
    const depthRule = evaluations.find((e) => e.ruleName === 'queue_depth_high');
    expect(depthRule).toBeDefined();
    expect(depthRule?.breached).toBe(false);
    expect(depthRule?.severity).toBe('ok');
  });
});
