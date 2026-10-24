import type { MembershipSummary } from '../../../lib/session';
import { Fragment } from 'react';

export function ContactsNavigation({
  memberships,
}: {
  readonly memberships: readonly MembershipSummary[];
}) {
  return (
    <>
      {memberships
        .filter((entry) => entry.permissions.includes('contact:read'))
        .map((entry) => (
          <Fragment key={entry.organizationId}>
            <a
              key={entry.organizationId}
              href={`/app/contacts?organization=${encodeURIComponent(entry.organizationId)}`}
            >
              Contacts{memberships.length > 1 ? ` — ${entry.organizationName}` : ''}
            </a>
            <a
              href={`/app/contact-groups?organization=${encodeURIComponent(entry.organizationId)}`}
            >
              Contact groups{memberships.length > 1 ? ` — ${entry.organizationName}` : ''}
            </a>
          </Fragment>
        ))}
    </>
  );
}
