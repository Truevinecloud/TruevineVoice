'use client';

import { useEffect, useState } from 'react';

import { request } from '../../lib/api';
import { analyticsPath, formatAnalyticsMoney, type AnalyticsSummaryResponse } from '../../lib/analytics';
import { SectionCard } from './AppUI';
import { AnalyticsMetrics, AnalyticsNotice } from './reports/analytics-parts';

/** Compact live analytics card for the organization dashboard. */
export function AnalyticsSummaryCard({
  organizationId,
}: {
  readonly organizationId: string;
}): React.JSX.Element {
  const [summary, setSummary] = useState<AnalyticsSummaryResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadedOrganizationId, setLoadedOrganizationId] = useState('');
  const [errorState, setErrorState] = useState<{
    readonly organizationId: string;
    readonly cause: unknown;
  } | null>(null);

  const error = errorState?.organizationId === organizationId ? errorState.cause : null;
  const current = loadedOrganizationId === organizationId;
  const showingLoading = loading || (!current && error === null);

  useEffect(() => {
    let active = true;
    const controller = new AbortController();

    request<AnalyticsSummaryResponse>(analyticsPath(organizationId, 'summary'), {
      signal: controller.signal,
    })
      .then((result) => {
        if (!active) return;
        setSummary(result);
        setLoadedOrganizationId(organizationId);
        setErrorState(null);
      })
      .catch((cause: unknown) => {
        if (!active || controller.signal.aborted) return;
        // Never show a previous organization's totals or fabricated zeroes.
        setSummary(null);
        setLoadedOrganizationId('');
        setErrorState({ organizationId, cause });
      })
      .finally(() => {
        if (active) setLoading(false);
      });

    return () => {
      active = false;
      controller.abort();
    };
  }, [organizationId]);

  const organizationParam = `organization=${encodeURIComponent(organizationId)}`;

  return (
    <SectionCard
      title="Call analytics"
      description="Live call outcomes and exact customer spend from the authenticated analytics API."
      actions={
        <a className="button-secondary" href={`/app/reports?${organizationParam}#call-analytics`}>
          Open analytics
        </a>
      }
    >
      {error !== null ? (
        <AnalyticsNotice error={error} />
      ) : showingLoading ? (
        <p className="notice notice-info" role="status" aria-busy="true">
          Loading call analytics…
        </p>
      ) : current && summary !== null ? (
        <>
          <AnalyticsMetrics totals={summary.totals} />
          {summary.reconciliation.status === 'RECONCILED' && (
            <p className="field-hint">
              Reconciled against {summary.reconciliation.usageEvents} voice-usage event(s) and{' '}
              {summary.reconciliation.ledgerEntries} ledger entr(y/ies). Spend:{' '}
              {formatAnalyticsMoney(summary.totals.spend)}.
            </p>
          )}
        </>
      ) : null}
    </SectionCard>
  );
}
