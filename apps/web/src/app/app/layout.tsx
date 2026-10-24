import { redirect } from 'next/navigation';

import { currentSession, type MembershipSummary } from '../../lib/session';

import { SignOutButton } from './SignOutButton';
import { ContactsNavigation } from './contacts/ContactsNavigation';

/**
 * The authenticated application shell.
 *
 * Two guards, in order, both of which the API also enforces. The server-side
 * check exists to avoid flashing private UI at somebody who is not signed in; it
 * is **not** the security boundary. Hiding a link is a courtesy, and every route
 * behind this layout re-checks the session and the permission server-side.
 *
 *   1. No usable session -> `/sign-in`. An expired or revoked session says so
 *      rather than pretending to be signed out, because "your session expired" and
 *      "you are not signed in" need different user actions.
 *   2. Terms not accepted -> `/accept-terms`.
 */

export default async function AppLayout({
  children,
}: {
  readonly children: React.ReactNode;
}): Promise<React.JSX.Element> {
  const session = await currentSession();

  if (!session.ok) {
    if (session.failure.kind === 'expired' || session.failure.kind === 'revoked') {
      redirect('/sign-in?reason=session-ended');
    }

    redirect('/sign-in');
  }

  if (!session.me.termsAccepted) {
    redirect('/accept-terms');
  }

  return (
    <div className="app-shell">
      <header className="app-header">
        <a className="app-brand" href="/app">
          Truevine Voice
        </a>
        <div className="app-user">
          <span>{session.me.email}</span>
          <SignOutButton />
        </div>
      </header>

      <AppNavigation memberships={session.me.memberships} />

      <main className="app-main">{children}</main>
    </div>
  );
}

/**
 * Organization switcher and navigation.
 *
 * Links are filtered by the permission the server reported for the caller's role
 * in the selected organization. A user with no organization sees an explanation
 * rather than an empty shell.
 */
async function AppNavigation({
  memberships,
}: {
  readonly memberships: readonly MembershipSummary[];
}): Promise<React.JSX.Element> {
  if (memberships.length === 0) {
    return (
      <div className="app-main">
        <div className="card-section">
          <h2>No organization yet</h2>
          <p>
            Your account is not a member of any organization. If you were expecting access, ask an
            organization owner to invite you, or accept the invitation link they sent you.
          </p>
        </div>
      </div>
    );
  }

  const selected = memberships[0]!;

  return (
    <nav className="app-nav" aria-label="Organization">
      <span className="tag tag-owner" style={{ alignSelf: 'center', marginRight: '0.4rem' }}>
        {selected.organizationName}
      </span>
      <PermissionLink membership={selected} href="/app" label="Dashboard" permission={null} />
      <ContactsNavigation memberships={memberships} />
      <PermissionLink
        membership={selected}
        href={`/app/campaigns?organization=${encodeURIComponent(selected.organizationId)}`}
        label="Campaigns"
        permission="campaign:read"
      />
      <PermissionLink
        membership={selected}
        href={`/app/audio?organization=${encodeURIComponent(selected.organizationId)}`}
        label="Audio"
        permission="audio:read"
      />
      <PermissionLink
        membership={selected}
        href={`/app/reports?organization=${encodeURIComponent(selected.organizationId)}`}
        label="Reports"
        permission="reporting:read"
      />
      <PermissionLink
        membership={selected}
        href="/app/settings"
        label="Organization"
        permission="organization:read"
      />
      <PermissionLink
        membership={selected}
        href="/app/team"
        label="Team"
        permission="member:read"
      />
      <PermissionLink
        membership={selected}
        href="/app/invitations"
        label="Invitations"
        permission="invitation:read"
      />
      <PermissionLink membership={selected} href="/app/account" label="Account" permission={null} />
      {memberships
        .filter((entry) => entry.permissions.includes('billing:read'))
        .map((entry) => (
          <a
            key={entry.organizationId}
            href={`/app/billing?organization=${encodeURIComponent(entry.organizationId)}`}
          >
            Billing — {entry.organizationName}
          </a>
        ))}

      {memberships.length > 1 && (
        <span style={{ alignSelf: 'center', marginLeft: 'auto', fontSize: '0.82rem' }}>
          Also in:{' '}
          {memberships
            .slice(1)
            .map((m) => m.organizationName)
            .join(', ')}
        </span>
      )}
    </nav>
  );
}

async function PermissionLink({
  membership,
  href,
  label,
  permission,
}: {
  readonly membership: MembershipSummary;
  readonly href: string;
  readonly label: string;
  readonly permission: string | null;
}): Promise<React.JSX.Element | null> {
  if (permission !== null && !membership.permissions.includes(permission)) {
    return null;
  }

  return <a href={href}>{label}</a>;
}
