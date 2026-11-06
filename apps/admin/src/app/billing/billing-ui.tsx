import Link from 'next/link';

export type BillingOperator = { platformRole: string };

export type WalletBalance = {
  currency: string;
  amountMinor: string;
  entryCount: number;
  lastEntryAt: string | null;
};

export type TopUpSummary = {
  currency: string;
  requestCount: number;
  totalRequestedMinor: string;
  lastRequestedAt: string | null;
};

export type OrganizationBilling = {
  id: string;
  name: string;
  slug: string;
  status: 'ACTIVE' | 'SUSPENDED';
  createdAt: string;
  memberCount: number;
  campaignCount: number;
  billingProfilePresent: boolean;
  walletBalances: WalletBalance[];
  topUpRequests: TopUpSummary[];
};

export type OverviewView = {
  organizations: { total: number };
  walletTotals: Array<{ currency: string; amountMinor: string; entryCount: number }>;
  topUpRequests: { total: number };
  notAvailable: string[];
};

export type PaymentRow = {
  id: string;
  organizationId: string;
  organizationName: string;
  organizationSlug: string;
  amountMinor: string;
  currency: string;
  createdById: string;
  createdAt: string;
  status: string;
};

export type ReconciliationAlert = {
  organizationId: string;
  organizationName: string;
  currency: string;
  reason: string;
};

export type WalletEntryRow = {
  id: string;
  amountMinor: string;
  currency: string;
  reference: string;
  description: string;
  createdAt: string;
};
export type ReconciliationView = {
  alerts: ReconciliationAlert[];
  unmatchedTransactions: unknown[];
  notAvailable: string[];
};

export type AuditEventRow = {
  id: string;
  trail: string;
  action: string;
  outcome: string;
  scope: string | null;
  targetType: string | null;
  targetId: string | null;
  occurredAt: string;
  actor: { userId: string; email: string };
  metadata: unknown;
};

export function BillingHeader({ title }: { title: string }) {
  return (
    <header className="topbar">
      <div>
        <span className="eyebrow">TRUEVINE VOICE · PLATFORM BILLING</span>
        <h1>{title}</h1>
      </div>
      <Link className="quiet-button" href="/">
        Operations home
      </Link>
    </header>
  );
}

export function BillingNav({ current }: { current: 'overview' | 'wallets' | 'payments' | 'reconciliation' | 'audit' }) {
  const sections = [
    { key: 'overview', href: '/billing', label: 'Overview' },
    { key: 'wallets', href: '/billing#wallets', label: 'Wallets' },
    { key: 'payments', href: '/billing#payments', label: 'Payments' },
    { key: 'reconciliation', href: '/billing#reconciliation', label: 'Reconciliation' },
    { key: 'audit', href: '/billing#audit', label: 'Audit' },
  ] as const;
  return (
    <nav className="technical-nav" aria-label="Billing sections">
      {sections.map((section) => (
        <Link key={section.key} href={section.href} aria-current={current === section.key ? 'page' : undefined}>
          {section.label}
        </Link>
      ))}
    </nav>
  );
}

export function Status({ value }: { value: string }) {
  return <span className={`status status-${value.toLowerCase()}`}>{value}</span>;
}

export function AccessNotice({ status }: { status: number | null }) {
  if (status === 401) {
    return (
      <p className="notice" role="status">
        Sign in with a billing account from the <Link href="/">operations home</Link>.
      </p>
    );
  }
  if (status === 403) {
    return (
      <p className="notice" role="status">
        This account does not have Billing Admin access. A Platform Owner can assign the BILLING_ADMIN role from Platform Admins.
      </p>
    );
  }
  if (status !== null) {
    return (
      <p className="notice" role="status">
        Billing data is temporarily unavailable.
      </p>
    );
  }
  return null;
}

export function OverviewPanels({ overview }: { overview: OverviewView }) {
  return (
    <>
      <section className="health-grid" aria-label="Billing overview">
        <div className="health-card">
          <span>Organizations</span>
          <strong>{overview.organizations.total}</strong>
        </div>
        <div className="health-card">
          <span>Top-up requests</span>
          <strong>{overview.topUpRequests.total}</strong>
        </div>
        {overview.walletTotals.map((total) => (
          <div className="health-card" key={total.currency}>
            <span>Wallet {total.currency}</span>
            <strong>{total.amountMinor}</strong>
            <small>{total.entryCount} entries</small>
          </div>
        ))}
      </section>
      <p className="footnote">
        Not modelled yet, so not shown: {overview.notAvailable.join(', ')}.
      </p>
    </>
  );
}

export function OrganizationsTable({ organizations }: { organizations: OrganizationBilling[] }) {
  if (organizations.length === 0) {
    return <p className="footnote">No organizations matched.</p>;
  }
  return (
    <div className="table-wrap">
      <table className="platform-admin-table">
        <thead>
          <tr>
            <th>Organization</th>
            <th>Status</th>
            <th>Billing profile</th>
            <th>Wallets</th>
            <th>Top-ups</th>
          </tr>
        </thead>
        <tbody>
          {organizations.map((organization) => (
            <tr key={organization.id}>
              <td className="email-cell">
                {organization.name}
                <small>{organization.slug}</small>
              </td>
              <td>
                <Status value={organization.status} />
              </td>
              <td>{organization.billingProfilePresent ? 'On file' : 'None'}</td>
              <td>
                {organization.walletBalances.length === 0
                  ? 'No wallet entries'
                  : organization.walletBalances.map((balance) => (
                      <div key={balance.currency}>
                        {balance.currency} {balance.amountMinor} ({balance.entryCount})
                      </div>
                    ))}
              </td>
              <td>
                {organization.topUpRequests.length === 0
                  ? '—'
                  : organization.topUpRequests.map((topUp) => (
                      <div key={topUp.currency}>
                        {topUp.currency} {topUp.totalRequestedMinor} ({topUp.requestCount})
                      </div>
                    ))}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function PaymentsTable({ payments }: { payments: PaymentRow[] }) {
  if (payments.length === 0) {
    return <p className="footnote">No payment requests matched.</p>;
  }
  return (
    <div className="table-wrap">
      <table className="platform-admin-table">
        <thead>
          <tr>
            <th>Organization</th>
            <th>Amount</th>
            <th>Currency</th>
            <th>Status</th>
            <th>Created</th>
          </tr>
        </thead>
        <tbody>
          {payments.map((payment) => (
            <tr key={payment.id}>
              <td className="email-cell">
                {payment.organizationName}
                <small>{payment.organizationSlug}</small>
              </td>
              <td>{payment.amountMinor}</td>
              <td>{payment.currency}</td>
              <td>
                <Status value={payment.status} />
              </td>
              <td>{payment.createdAt}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function ReconciliationPanel({ reconciliation }: { reconciliation: ReconciliationView }) {
  return (
    <div className="card">
      <div className="section-heading">
        <h2>Reconciliation alerts</h2>
        <span>{reconciliation.alerts.length} shown</span>
      </div>
      {reconciliation.alerts.length === 0 ? (
        <p className="footnote">No reconciliation alerts.</p>
      ) : (
        <div className="table-wrap">
          <table className="platform-admin-table">
            <thead>
              <tr>
                <th>Organization</th>
                <th>Currency</th>
                <th>Reason</th>
              </tr>
            </thead>
            <tbody>
              {reconciliation.alerts.map((alert, index) => (
                <tr key={`${alert.organizationId}:${alert.currency}:${index}`}>
                  <td>{alert.organizationName}</td>
                  <td>{alert.currency}</td>
                  <td>{alert.reason}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="footnote">
        Not modelled yet, so not shown: {reconciliation.notAvailable.join(', ')}.
      </p>
    </div>
  );
}

export function WalletEntriesTable({ entries }: { entries: WalletEntryRow[] }) {
  if (entries.length === 0) {
    return <p className="footnote">No ledger entries for this organization.</p>;
  }
  return (
    <div className="table-wrap">
      <table className="platform-admin-table">
        <thead>
          <tr>
            <th>When</th>
            <th>Amount</th>
            <th>Currency</th>
            <th>Reference</th>
            <th>Description</th>
          </tr>
        </thead>
        <tbody>
          {entries.map((entry) => (
            <tr key={entry.id}>
              <td>{entry.createdAt}</td>
              <td>{entry.amountMinor}</td>
              <td>{entry.currency}</td>
              <td>{entry.reference}</td>
              <td>{entry.description}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
export function BillingAuditTable({ events }: { events: AuditEventRow[] }) {
  if (events.length === 0) {
    return <p className="footnote">No platform audit events on this trail.</p>;
  }
  return (
    <div className="table-wrap">
      <table className="platform-admin-table">
        <thead>
          <tr>
            <th>When</th>
            <th>Action</th>
            <th>Actor</th>
            <th>Outcome</th>
          </tr>
        </thead>
        <tbody>
          {events.map((event) => (
            <tr key={`${event.trail}:${event.id}`}>
              <td>{event.occurredAt}</td>
              <td>
                <strong>{event.action}</strong>
                <small>{event.trail} trail</small>
              </td>
              <td>
                {event.actor.email}
                <small>{event.actor.userId}</small>
              </td>
              <td>
                <Status value={event.outcome} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
