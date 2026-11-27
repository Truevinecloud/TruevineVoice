/**
 * Alert evaluation engine.
 *
 * Evaluates metric samples against alert rules, tracks state transitions
 * (ok → firing → recovering), enforces consecutive-breach and sustained-breach
 * requirements, suppresses duplicate notifications during cooldown, and detects
 * recovery.
 *
 * No notifications are sent by this module: it returns evaluation results that
 * callers can act on. Notification delivery is intentionally a no-op until
 * explicitly configured.
 */

import type {
  AlertRule,
  AlertEvaluation,
  AlertSeverity,
  AlertState,
  MetricStatus,
} from './metrics.js';

export type { AlertRule, AlertEvaluation } from './metrics.js';

/**
 * Tracks the running state of a single alert rule across evaluations.
 */
/**
 * Tracker for a single alert rule's evaluation state across cycles.
 */
export interface AlertRuleTracker {
  readonly name: string;
  consecutiveBreaches: number;
  breachStartTime: number | undefined;
  lastNotificationTime: number | undefined;
  state: AlertState;
  lastValue: number | undefined;
}

/**
 * Creates a tracker for an alert rule.
 */
function createTracker(rule: AlertRule): AlertRuleTracker {
  return {
    name: rule.name,
    consecutiveBreaches: 0,
    breachStartTime: undefined,
    lastNotificationTime: undefined,
    state: 'ok',
    lastValue: undefined,
  };
}

/**
 * Evaluates a single metric sample against an alert rule.
 *
 * Returns an `AlertEvaluation` and the updated tracker. The caller is
 * responsible for persisting the tracker across evaluations (e.g., in memory
 * or Redis).
 */
export function evaluateRule(
  rule: AlertRule,
  tracker: AlertRuleTracker,
  value: number | undefined,
  status: MetricStatus,
  now: number = Date.now(),
): { evaluation: AlertEvaluation; tracker: AlertRuleTracker } {
  const criticalThreshold = rule.criticalThreshold;
  const warningThreshold = rule.warningThreshold;

  let severity: AlertSeverity = 'ok';
  let threshold: number | undefined;
  let breached = false;

  if (status !== 'ok' || value === undefined) {
    // Unknown or degraded metric: treat as warning but not a breach.
    severity = 'warning';
    breached = false;
  } else if (criticalThreshold !== undefined && value >= criticalThreshold) {
    severity = 'critical';
    threshold = criticalThreshold;
    breached = true;
  } else if (warningThreshold !== undefined && value >= warningThreshold) {
    severity = 'warning';
    threshold = warningThreshold;
    breached = true;
  }

  const consecutiveBreaches = breached
    ? tracker.consecutiveBreaches + 1
    : 0;

  let breachStartTime = tracker.breachStartTime;
  if (breached && tracker.breachStartTime === undefined) {
    breachStartTime = now;
  } else if (!breached) {
    breachStartTime = undefined;
  }

  const sustainedForMs = rule.sustainedForMs ?? 0;
  const sustainedMet =
    sustainedForMs === 0 ||
    (breachStartTime !== undefined && now - breachStartTime >= sustainedForMs);

  const consecutiveMet =
    consecutiveBreaches >= (rule.consecutiveBreaches ?? 1);

  const shouldFire = breached && sustainedMet && consecutiveMet;
  const shouldRecover = !breached && tracker.state === 'firing';

  let state: AlertState;
  let shouldNotify = false;
  let suppressed = false;
  let reason: string | undefined;

  if (shouldFire) {
    state = 'firing';
    shouldNotify = true;
  } else if (shouldRecover) {
    state = 'recovering';
  } else {
    state = tracker.state;
  }

  if (shouldNotify) {
    const cooldownMs = rule.cooldownMs ?? 0;
    const inCooldown =
      cooldownMs > 0 &&
      tracker.lastNotificationTime !== undefined &&
      now - tracker.lastNotificationTime < cooldownMs;
    if (inCooldown) {
      suppressed = true;
      reason = 'cooldown';
    } else {
      tracker.lastNotificationTime = now;
    }
  }

  const evaluation: AlertEvaluation = {
    ruleName: rule.name,
    severity,
    state,
    value,
    threshold,
    breached,
    consecutiveBreaches,
    suppressed,
    reason,
  };

  const updatedTracker: AlertRuleTracker = {
    ...tracker,
    consecutiveBreaches,
    breachStartTime,
    state,
    lastValue: value,
  };

  return { evaluation, tracker: updatedTracker };
}

/**
 * Evaluates a set of metric samples against a set of alert rules.
 *
 * Trackers are keyed by rule name and mutated in place. Returns all
 * evaluations plus the updated trackers.
 */
export function evaluateAll(
  rules: Readonly<AlertRule> | Readonly<AlertRule[]>,
  trackers: Map<string, AlertRuleTracker>,
  samples: Readonly<Record<string, { value: number | undefined; status: MetricStatus }>>,
  now: number = Date.now(),
): { evaluations: AlertEvaluation[]; trackers: Map<string, AlertRuleTracker> } {
  const ruleArray = Array.isArray(rules) ? rules : [rules];
  const evaluations: AlertEvaluation[] = [];

  for (const rule of ruleArray) {
    const existing = trackers.get(rule.name);
    const tracker = existing ?? createTracker(rule);
    const sample = samples[rule.metric];
    const value = sample?.value;
    const status = sample?.status ?? 'unknown';

    const { evaluation, tracker: updated } = evaluateRule(
      rule,
      tracker,
      value,
      status,
      now,
    );
    evaluations.push(evaluation);
    trackers.set(rule.name, updated);
  }

  return { evaluations, trackers };
}

/**
 * Returns the highest severity across a list of evaluations.
 */
export function highestSeverity(
  evaluations: Readonly<AlertEvaluation[]>,
): AlertSeverity {
  let highest: AlertSeverity = 'ok';
  for (const evaluation of evaluations) {
    if (
      (evaluation.severity === 'critical') ||
      (evaluation.severity === 'warning' && highest !== 'critical')
    ) {
      highest = evaluation.severity;
    }
  }
  return highest;
}

/**
 * Returns only evaluations that are firing (not ok or recovering).
 */
export function firingEvaluations(
  evaluations: Readonly<AlertEvaluation[]>,
): AlertEvaluation[] {
  return evaluations.filter((e) => e.state === 'firing');
}

/**
 * Returns only evaluations that are recovering.
 */
export function recoveringEvaluations(
  evaluations: Readonly<AlertEvaluation[]>,
): AlertEvaluation[] {
  return evaluations.filter((e) => e.state === 'recovering');
}

/**
 * Notification delivery interface for alert evaluations.
 *
 * Implementations deliver notifications (email, webhook, pager, etc.). The
 * default implementation is a no-op: alerts are evaluated but never dispatched
 * until an implementation is explicitly configured.
 */
export interface AlertNotifier {
  readonly name: string;
  notify(evaluation: AlertEvaluation): Promise<void>;
}

/**
 * No-op alert notifier: evaluates alerts but never sends notifications.
 *
 * Use this until a real notification mechanism is configured.
 */
export class NoopAlertNotifier implements AlertNotifier {
  readonly name = 'noop';

  async notify(_evaluation: AlertEvaluation): Promise<void> {
    // Intentionally no-op: no live notifications until explicitly configured.
  }
}
