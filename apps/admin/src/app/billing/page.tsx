'use client';

import { useEffect, useState, type FormEvent } from 'react';

import { ApiError, api } from '../../lib/api';
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
  WalletEntriesTable,
  type PaymentRow,
  type WalletEntryRow,
  type ReconciliationView,
} from './billing-ui';

type OrganizationSearch = { organizations: OrganizationBilling[]; nextCursor: string | null };

function messageFor(error: unknown, fallback: string): string {
  if (error instanceof ApiError) {
    if (error.status === 401) return 'Your session has expired. Sign in again.';
    if (error.status === 403) return 'This account does not have Billing Admin access.';
    if (error.status === 404) return 'Billing endpoint not found. Contact support if this persists.';
    if (error.status >= 500) return 'Billing service is temporarily unavailable. Try again.';
  }
  return fallback;
}

export default function BillingAdminPage() {
  const [access, setAccess] = useState<number | null | 'checking'>('checking');
  const [overview, setOverview] = useState<OverviewView | null>(null);
  const [organizations, setOrganizations] = useState<OrganizationBilling[]>([]);
  const [payments, setPayments] = useState<PaymentRow[]>([]);
  const [walletEntries, setWalletEntries] = useState<WalletEntryRow[]>([]);
  const [walletCursor, setWalletCursor] = useState<string | null>(null);
  const [walletOrganizationId, setWalletOrganizationId] = useState('');
  const [walletLoading, setWalletLoading] = useState(false);
  const [reconciliation, setReconciliation] = useState<ReconciliationView | null>(null);
  const [auditEvents, setAuditEvents] = useState<AuditEventRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [sectionErrors, setSectionErrors] = useState<Record<string, string>>({});
  const [orgSearch, setOrgSearch] = useState('');
  const [orgStatus, setOrgStatus] = useState('');
  const [busy, setBusy] = useState(false);

  const load = async () => {
    setLoading(true);
    setError('');
    setSectionErrors({});
    try {
      await api('/platform/billing/me');
      setAccess(null);
    } catch (caught) {
      const status = caught instanceof ApiError ? caught.status : 500;
      setAccess(status);
      setError(messageFor(caught, 'Billing data is temporarily unavailable.'));
      setLoading(false);
      return;
    }

    const results = await Promise.allSettled([
      api<OverviewView>('/platform/billing/overview'),
      api<OrganizationSearch>('/platform/billing/organizations'),
      api<{ payments: PaymentRow[] }>('/platform/billing/payments'),
      api<ReconciliationView>('/platform/billing/reconciliation'),
      api<{ events: AuditEventRow[] }>('/platform/billing/audit'),
    ]);

    const [overviewResult, orgResult, paymentResult, reconciliationResult, auditResult] = results;
    const nextErrors: Record<string, string> = {};

    if (overviewResult.status === 'fulfilled') setOverview(overviewResult.value);
    else nextErrors.overview = messageFor(overviewResult.reason, 'Overview unavailable.');

    if (orgResult.status === 'fulfilled') {
      setOrganizations(orgResult.value.organizations);
      if (orgResult.value.organizations.length > 0 && !walletOrganizationId) {
        const first = orgResult.value.organizations[0]?.id;
        if (first) {
          setWalletOrganizationId(first);
          void loadWalletEntries(first);
        }
      }
    }
    else nextErrors.organizations = messageFor(orgResult.reason, 'Organizations unavailable.');

    if (paymentResult.status === 'fulfilled') setPayments(paymentResult.value.payments);
    else nextErrors.payments = messageFor(paymentResult.reason, 'Payments unavailable.');

    if (reconciliationResult.status === 'fulfilled') setReconciliation(reconciliationResult.value);
    else nextErrors.reconciliation = messageFor(reconciliationResult.reason, 'Reconciliation unavailable.');

    if (auditResult.status === 'fulfilled') setAuditEvents(auditResult.value.events);
    else nextErrors.audit = messageFor(auditResult.reason, 'Audit history unavailable.');

    setSectionErrors(nextErrors);
    if (Object.keys(nextErrors).length === results.length) {
      setError('Billing data is temporarily unavailable.');
    }
    setLoading(false);
  };

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void load();
    }, 0);
    return () => window.clearTimeout(timer);
  }, []);

  async function loadWalletEntries(organizationId: string, cursor?: string) {
    setWalletLoading(true);
    try {
      const result = await api<{ entries: WalletEntryRow[]; nextCursor: string | null }>(
        `/platform/billing/organizations/${organizationId}/wallet/transactions${cursor ? `?cursor=${cursor}` : ''}`,
      );
      setWalletEntries((current) => (cursor ? [...current, ...result.entries] : result.entries));
      setWalletCursor(result.nextCursor);
    } catch (caught) {
      setSectionErrors((current) => ({ ...current, wallets: messageFor(caught, 'Wallet ledger unavailable.') }));
    } finally {
      setWalletLoading(false);
    }
  }

  async function searchOrganizations(event?: FormEvent) {
    event?.preventDefault();
    setBusy(true);
    try {
      const parameters = new URLSearchParams();
      if (orgSearch.trim()) parameters.set('q', orgSearch.trim());
      if (orgStatus) parameters.set('status', orgStatus);
      const result = await api<OrganizationSearch>(`/platform/billing/organizations${parameters.size > 0 ? `?${parameters.toString()}` : ''}`);
      setOrganizations(result.organizations);
      setSectionErrors((current) => {
        const next = { ...current };
        delete next.organizations;
        return next;
      });
    } catch (caught) {
      setSectionErrors((current) => ({ ...current, organizations: messageFor(caught, 'Organization search failed.') }));
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
          <div className="button-row">
            <button type="button" className="quiet-button" disabled={loading} onClick={() => void load()}>
              {loading ? 'Refreshing…' : 'Retry'}
            </button>
          </div>
          {error && <p className="notice form-error" role="alert">{error}</p>}
          {loading ? (
            <p>Loading billing data…</p>
          ) : (
            <>
              {sectionErrors.overview ? (
                <p className="notice form-error" role="alert">{sectionErrors.overview}</p>
              ) : (
                overview && <OverviewPanels overview={overview} />
              )}
              <section className="card" id="wallets">
                <div className="section-heading">
                  <h2>Wallets by organization</h2>
                  <span>{organizations.length} shown</span>
                </div>
                {sectionErrors.organizations && <p className="notice form-error" role="alert">{sectionErrors.organizations}</p>}
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
              <section className="card" id="wallet-ledger">
                <div className="section-heading">
                  <h2>Wallet ledger</h2>
                  <span>{walletEntries.length} shown</span>
                </div>
                <label>
                  Organization
                  <select
                    value={walletOrganizationId}
                    onChange={(event) => {
                      const value = event.target.value;
                      setWalletOrganizationId(value);
                      setWalletEntries([]);
                      setWalletCursor(null);
                      if (value) void loadWalletEntries(value);
                    }}
                  >
                    <option value="">Select an organization</option>
                    {organizations.map((organization) => (
                      <option key={organization.id} value={organization.id}>
                        {organization.name}
                      </option>
                    ))}
                  </select>
                </label>
                {sectionErrors.wallets && <p className="notice form-error" role="alert">{sectionErrors.wallets}</p>}
                {walletLoading ? <p>Loading ledger…</p> : <WalletEntriesTable entries={walletEntries} />}
                {walletCursor && (
                  <button className="quiet-button" disabled={walletLoading} onClick={() => void loadWalletEntries(walletOrganizationId, walletCursor)}>
                    Load more
                  </button>
                )}
              </section>
              <section className="card" id="payments">
                <div className="section-heading">
                  <h2>Payments and top-up requests</h2>
                  <span>{payments.length} shown</span>
                </div>
                {sectionErrors.payments && <p className="notice form-error" role="alert">{sectionErrors.payments}</p>}
                <PaymentsTable payments={payments} />
              </section>
              <section id="reconciliation">
                {sectionErrors.reconciliation ? (
                  <p className="notice form-error" role="alert">{sectionErrors.reconciliation}</p>
                ) : (
                  reconciliation && <ReconciliationPanel reconciliation={reconciliation} />
                )}
              </section>
              <section className="card" id="audit">
                <div className="section-heading">
                  <h2>Financial audit history</h2>
                  <span>{auditEvents.length} shown</span>
                </div>
                {sectionErrors.audit && <p className="notice form-error" role="alert">{sectionErrors.audit}</p>}
                <BillingAuditTable events={auditEvents} />
              </section>
            </>
          )}
        </>
      )}
    </main>
  );
}
