import { formatUgx, type Billing, type Transactions, type Wallet } from '../../../lib/billing';
import { BillingProfileForm, TopUpForm } from './BillingForms';
import { EmptyState, SectionCard, StatusBadge } from '../AppUI';

export function BillingView({
  organizationId,
  canUpdate,
  wallet,
  billing,
  transactions,
}: {
  readonly organizationId: string;
  readonly canUpdate: boolean;
  readonly wallet: Wallet;
  readonly billing: Billing;
  readonly transactions: Transactions;
}) {
  return (
    <>
      <SectionCard title="Wallet balance" description="Calculated from confirmed ledger entries.">
        <p className="billing-balance">{formatUgx(wallet.amountMinor)}</p>
        <p>Only confirmed ledger entries affect this balance.</p>
      </SectionCard>
      <SectionCard
        title="Top-ups"
        description="Requests remain pending until payment collection is integrated."
      >
        {canUpdate && <TopUpForm organizationId={organizationId} />}
        <h3 className="subsection-title">Recent requests</h3>
        {billing.topUps.length === 0 ? (
          <EmptyState title="No top-up requests">Submitted requests will appear here.</EmptyState>
        ) : (
          <ul>
            {billing.topUps.map((entry) => (
              <li key={entry.id}>
                {formatUgx(entry.amountMinor)} — <StatusBadge tone="warning">Pending</StatusBadge> —{' '}
                {entry.createdAt}
              </li>
            ))}
          </ul>
        )}
      </SectionCard>
      <SectionCard
        title="Transaction history"
        description="Confirmed wallet entries for this organization."
      >
        {transactions.entries.length === 0 ? (
          <EmptyState title="No transactions yet">
            Confirmed wallet activity will appear here.
          </EmptyState>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table className="table">
              <caption>Confirmed wallet entries</caption>
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Description</th>
                  <th>Amount</th>
                </tr>
              </thead>
              <tbody>
                {transactions.entries.map((entry) => (
                  <tr key={entry.id}>
                    <td>{entry.createdAt}</td>
                    <td>{entry.description}</td>
                    <td>{formatUgx(entry.amountMinor)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {transactions.nextCursor && (
          <a
            href={`/app/billing?organization=${encodeURIComponent(organizationId)}&cursor=${encodeURIComponent(transactions.nextCursor)}`}
          >
            Older transactions
          </a>
        )}
      </SectionCard>
      <SectionCard
        title="Billing details"
        description="Contact details associated with billing requests."
      >
        {canUpdate ? (
          <BillingProfileForm organizationId={organizationId} profile={billing.profile} />
        ) : (
          <p>{billing.profile?.name ?? 'No billing details saved.'}</p>
        )}
        <p>Invoices, payment collection and usage charges are not available yet.</p>
      </SectionCard>
    </>
  );
}
