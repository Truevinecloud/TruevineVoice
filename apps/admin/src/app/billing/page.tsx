'use client';

import { useEffect, useState, type FormEvent } from 'react';

import { api } from '../../lib/api';
import {
  AccessNotice,
  BillingAuditTable,
  BillingHeader,
  BillingNav,
  OrganizationsTable,
  OverviewPanels,
  PaymentsTable,
  ReconciliationPanel,
  type AuditEventRow,
  type OrganizationBilling,
  type OverviewView,
  type PaymentRow,
  type ReconciliationView,
} from './billing-ui';

type OrganizationSearch = { organizations: OrganizationBilling[]; nextCursor: string | null };

export default function BillingAdminPage() {
  const [access, setAccess] = useState<number | null | 'checking'>('checking');
  const [overview, setOverview] = useState<OverviewView | null>(null);
  const [organizations, setOrganizations] = useState<OrganizationBilling[]>([]);
  const [payments, setPayments] = useState<PaymentRow[]>([]);
  const [reconciliation, setReconciliation] = useState<ReconciliationView | null>(null);
  const [auditEvents, setAuditEvents] = useState<AuditEventRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [orgSearch, setOrgSearch] = useState('');
  const [orgStatus, setOrgStatus] = useState('');
  const [busy, setBusy] = useState(false);

  const load = async () => {
    setLoading(true);
    setError('');
    try {
      await api('/platform/billing/me');
      setAccess(null);
      const [overviewResult, orgResult, paymentResult, reconciliationResult, auditResult] = await Promise.all([
        api<OverviewView>('/platform/billing/overview'),
        api<OrganizationSearch>('/platform/billing/organizations'),
        api<{ payments: PaymentRow[] }>('/platform/billing/payments'),
        api<ReconciliationView>('/platform/billing/reconciliation'),
        api<{ events: AuditEventRow[] }>('/platform/billing/audit'),
      ]);
      setOverview(overviewResult);
      setOrganizations(orgResult.organizations);
      setPayments(paymentResult.payments);
      setReconciliation(reconciliationResult);
      setAuditEvents(auditResult.events);
    } catch (caught) {
      const status = (caught as Error & { status?: number }).status;
      setAccess(typeof status === 'number' ? status : 500);
      setError(status === 401 ? 'Sign in with an approved billing account.' : status === 403 ? 'This account does not have Billing Admin access.' : 'Billing data is temporarily unavailable.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void load();
    }, 0);
    return () => window.clearTimeout(timer);
  }, []);

  async function searchOrganizations(event?: FormEvent) {
    event?.preventDefault();
    setBusy(true);
    try {
      const parameters = new URLSearchParams();
      if (orgSearch.trim()) parameters.set('q', orgSearch.trim());
      if (orgStatus) parameters.set('status', orgStatus);
      const result = await api<OrganizationSearch>(`/platform/billing/organizations${parameters.size > 0 ? `?${parameters.toString()}` : ''}`);
      setOrganizations(result.organizations);
    } catch {
      setError('Organization search failed.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="operations-shell platform-admin-shell">
      <BillingHeader title="Billing Admin" />
      <BillingNav current="overview" />
      <AccessNotice status={typeof access === 'number' ? access : null} />
      {access === null && (
        <>
          {error && <p className="notice form-error" role="alert">{error}</p>}
          {loading ? (
            <p>Loading billing data…</p>
          ) : (
            <>
              {overview && <OverviewPanels overview={overview} />}
              <section className="card" id="wallets">
                <div className="section-heading">
                  <h2>Wallets by organization</h2>
                  <span>{organizations.length} shown</span>
                </div>
                <form className="search-bar" onSubmit={(event) => void searchOrganizations(event)}>
                  <label>
                    Search
                    <input value={orgSearch} onChange={(event) => setOrgSearch(event.target.value)} placeholder="Name or slug" />
                  </label>
                  <label>
                    Status
                    <select value={orgStatus} onChange={(event) => setOrgStatus(event.target.value)}>
                      <option value="">All</option>
                      <option value="ACTIVE">Active</option>
                      <option value="SUSPENDED">Suspended</option>
                    </select>
                  </label>
                  <button disabled={busy} type="submit">
                    {busy ? 'Searching…' : 'Search'}
                  </button>
                </form>
                <OrganizationsTable organizations={organizations} />
              </section>
              <section className="card" id="payments">
                <div className="section-heading">
                  <h2>Payments and top-up requests</h2>
                  <span>{payments.length} shown</span>
                </div>
                <PaymentsTable payments={payments} />
              </section>
              <section id="reconciliation">
                {reconciliation && <ReconciliationPanel reconciliation={reconciliation} />}
              </section>
              <section className="card" id="audit">
                <div className="section-heading">
                  <h2>Financial audit history</h2>
                  <span>{auditEvents.length} shown</span>
                </div>
                <BillingAuditTable events={auditEvents} />
              </section>
            </>
          )}
        </>
      )}
    </main>
  );
}
