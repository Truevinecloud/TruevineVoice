import type { MembershipSummary } from '../../../lib/session';

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
          <a
            key={entry.organizationId}
            href={`/app/contacts?organization=${encodeURIComponent(entry.organizationId)}`}
          >
            Contacts{memberships.length > 1 ? ` — ${entry.organizationName}` : ''}
          </a>
        ))}
    </>
  );
}
