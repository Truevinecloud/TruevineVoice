import { formatUgx, type Billing, type Transactions, type Wallet } from '../../../lib/billing';
import { BillingProfileForm, TopUpForm } from './BillingForms';

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
      <section className="card-section">
        <h2>Wallet balance</h2>
        <p>{formatUgx(wallet.amountMinor)}</p>
        <p>Only confirmed ledger entries affect this balance.</p>
      </section>
      <section className="card-section">
        <h2>Top-ups</h2>
        {canUpdate && <TopUpForm organizationId={organizationId} />}
        <h3>Recent requests</h3>
        {billing.topUps.length === 0 ? (
          <p>No top-up requests.</p>
        ) : (
          <ul>
            {billing.topUps.map((entry) => (
              <li key={entry.id}>
                {formatUgx(entry.amountMinor)} — Pending — {entry.createdAt}
              </li>
            ))}
          </ul>
        )}
      </section>
      <section className="card-section">
        <h2>Transaction history</h2>
        {transactions.entries.length === 0 ? (
          <p>No confirmed wallet transactions on this page.</p>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table>
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
      </section>
      <section className="card-section">
        <h2>Billing details</h2>
        {canUpdate ? (
          <BillingProfileForm organizationId={organizationId} profile={billing.profile} />
        ) : (
          <p>{billing.profile?.name ?? 'No billing details saved.'}</p>
        )}
        <p>Invoices, payment collection and usage charges are not available yet.</p>
      </section>
    </>
  );
}
