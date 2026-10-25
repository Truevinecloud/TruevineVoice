import { redirect } from 'next/navigation';
import { currentSession, hasPermission } from '../../../lib/session';
import { fetchBilling } from '../../../lib/billing-api';
import { BillingView } from './BillingView';
import { PageHeader } from '../AppUI';

export default async function BillingPage({
  searchParams,
}: {
  readonly searchParams: Promise<{ organization?: string | string[]; cursor?: string | string[] }>;
}) {
  const session = await currentSession();
  if (!session.ok) redirect('/sign-in');
  if (!session.me.termsAccepted) redirect('/accept-terms');
  const params = await searchParams;
  const requested = Array.isArray(params.organization)
    ? params.organization[0]
    : params.organization;
  const membership =
    requested === undefined
      ? session.me.memberships[0]
      : session.me.memberships.find((entry) => entry.organizationId === requested);
  if (
    !membership ||
    !hasPermission(membership, 'billing:read') ||
    !hasPermission(membership, 'wallet:read')
  )
    return (
      <>
        <PageHeader title="Billing" />
        <p role="alert">You do not have billing access in this organization.</p>
      </>
    );
  const cursor = Array.isArray(params.cursor) ? params.cursor[0] : params.cursor;
  let data;
  try {
    data = await fetchBilling(membership.organizationId, cursor);
  } catch {
    return (
      <>
        <PageHeader title="Billing" eyebrow={membership.organizationName} />
        <p role="alert">
          Billing information could not be loaded. Your session or permissions may have changed.
          Reload or sign in again.
        </p>
      </>
    );
  }
  return (
    <>
      <PageHeader
        title="Billing"
        eyebrow={membership.organizationName}
        description="Review ledger balance, transaction history, and billing details."
      />
      <nav aria-label="Billing organization">
        {session.me.memberships
          .filter((entry) => hasPermission(entry, 'billing:read'))
          .map((entry) => (
            <a
              key={entry.organizationId}
              href={`/app/billing?organization=${encodeURIComponent(entry.organizationId)}`}
            >
              {entry.organizationName}
            </a>
          ))}
      </nav>
      <BillingView
        organizationId={membership.organizationId}
        canUpdate={hasPermission(membership, 'billing:update')}
        {...data}
      />
    </>
  );
}
