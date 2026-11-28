'use client';

import {
  ANALYTICS_CALL_STATES,
  callStateLabel,
  callStateTone,
  describeAnalyticsError,
  formatAnalyticsMoney,
  type AnalyticsStatusCounts,
  type AnalyticsTotals,
} from '../../../lib/analytics';
import { StatusBadge } from '../AppUI';

/** A single error surface for every analytics fetch. Never renders stale data. */
export function AnalyticsNotice({ error }: { readonly error: unknown }): React.JSX.Element {
  const described = describeAnalyticsError(error);
  return (
    <div className="notice notice-error" role="alert" data-analytics-error={described.kind}>
      <p>{described.message}</p>
      {described.kind === 'auth' && (
        <p>
          <a className="button-primary" href="/sign-in">
            Sign in again
          </a>
        </p>
      )}
    </div>
  );
}

/** Metrics derived only from API values, with exact minor-unit money. */
export function AnalyticsMetrics({ totals }: { readonly totals: AnalyticsTotals }): React.JSX.Element {
  return (
    <>
      <dl className="report-metrics" data-testid="analytics-metrics">
        <div>
          <dt>Total attempts</dt>
          <dd>{totals.attempts}</dd>
        </div>
        <div>
          <dt>Answered (current state)</dt>
          <dd>{totals.answered}</dd>
        </div>
        <div>
          <dt>Completed</dt>
          <dd>{totals.statusCounts.COMPLETED ?? 0}</dd>
        </div>
        <div>
          <dt>Failed</dt>
          <dd>{totals.statusCounts.FAILED ?? 0}</dd>
        </div>
        <div>
          <dt>Customer spend</dt>
          <dd className="analytics-money">{formatAnalyticsMoney(totals.spend)}</dd>
        </div>
      </dl>
      <p className="field-hint">
        “Answered” counts attempts currently in ANSWERED or COMPLETED. It is not a provider answer
        rate; no answer-rate denominator is defined by the available contract.
      </p>
    </>
  );
}

/** Full ten-state breakdown; zero counts are shown because they are real API values. */
export function AnalyticsStatusBreakdown({
  counts,
}: {
  readonly counts: AnalyticsStatusCounts;
}): React.JSX.Element {
  return (
    <div className="analytics-status-grid">
      {ANALYTICS_CALL_STATES.map((state) => (
        <div className="analytics-status-cell" key={state}>
          <StatusBadge tone={callStateTone(state)}>{callStateLabel(state)}</StatusBadge>
          <strong>{counts[state] ?? 0}</strong>
        </div>
      ))}
    </div>
  );
}

export function AnalyticsPager({
  page,
  pageSize,
  total,
  totalPages,
  onPage,
}: {
  readonly page: number;
  readonly pageSize: number;
  readonly total: number;
  readonly totalPages: number;
  readonly onPage: (page: number) => void;
}): React.JSX.Element {
  const first = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const last = Math.min(page * pageSize, total);

  return (
    <div className="pagination" data-testid="analytics-pagination">
      <span>
        Showing {first}–{last} of {total}
      </span>
      <div className="pagination__controls">
        <button
          className="button-secondary"
          type="button"
          disabled={page <= 1}
          onClick={() => onPage(page - 1)}
        >
          Previous
        </button>
        <span aria-live="polite">
          Page {page} of {totalPages === 0 ? 0 : totalPages}
        </span>
        <button
          className="button-secondary"
          type="button"
          disabled={page >= totalPages}
          onClick={() => onPage(page + 1)}
        >
          Next
        </button>
      </div>
    </div>
  );
}
