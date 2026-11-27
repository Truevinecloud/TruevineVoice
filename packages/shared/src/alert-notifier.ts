/**
 * Structured-log alert notifier.
 *
 * Implements the `AlertNotifier` interface by writing alert evaluations as
 * single-line structured JSON to stdout. Suitable for local development and
 * verification. External notification delivery (email, webhook, pager) is
 * intentionally disabled by default.
 *
 * All alert payloads are run through the shared redaction layer so that no
 * credentials, tokens, or sensitive operational data are ever logged.
 */

import type { AlertEvaluation } from './alert.js';
import type { AlertNotifier } from './alert.js';
import {
  buildLogEntry,
  generateCorrelationId,
  serializeLogEntry,
} from './logging.js';

/** Service name used in structured log output. */
const SERVICE_NAME = 'truevine-voice-observability';

/**
 * Structured-log notifier: writes alert evaluations as JSON log lines.
 *
 * Firing and recovery notifications are both emitted. Each entry includes
 * severity, rule identifier, metric name, measured value, threshold, timestamp,
 * and a correlation identifier. Values are redacted through the shared
 * safe-field allowlist before output.
 */
export class StructuredLogNotifier implements AlertNotifier {
  readonly name = 'structured-log';

  async notify(evaluation: AlertEvaluation): Promise<void> {
    try {
      const correlationId = generateCorrelationId();
      const entry = buildLogEntry(
        SERVICE_NAME,
        evaluation.state === 'recovering' ? 'log' : 'warn',
        `alert ${evaluation.state}: ${evaluation.ruleName}`,
        correlationId,
        {
          event: 'alert_evaluation',
          ruleName: evaluation.ruleName,
          state: evaluation.state,
          severity: evaluation.severity,
          metric: evaluation.ruleName,
          value: evaluation.value,
          threshold: evaluation.threshold,
          breached: evaluation.breached,
          consecutiveBreaches: evaluation.consecutiveBreaches,
          suppressed: evaluation.suppressed,
          reason: evaluation.reason,
          correlationId,
        },
      );
      // eslint-disable-next-line no-console
      console.log(serializeLogEntry(entry));
    } catch {
      // Notifier failures must not interrupt alert evaluation
    }
  }
}
