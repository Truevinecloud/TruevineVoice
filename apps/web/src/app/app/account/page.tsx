import { redirect } from 'next/navigation';

import { currentSession } from '../../../lib/session';

import { AccountDetails } from './AccountDetails';
import { PasswordResetPrompt } from './PasswordResetPrompt';
import { EmptyState, PageHeader, SectionCard, StatusBadge } from '../AppUI';

/** `/app/account` - profile and security settings. */
export default async function AccountPage(): Promise<React.JSX.Element> {
  const session = await currentSession();

  if (!session.ok) redirect('/sign-in');

  const organizations = session.me.memberships;

  return (
    <>
      <PageHeader
        title="My Profile"
        description="Your sign-in identity and organization memberships."
      />

      <SectionCard title="Profile">
        <AccountDetails email={session.me.email} userId={session.me.userId} />
      </SectionCard>

      <SectionCard
        title="Organizations"
        description="Organizations and roles currently attached to your account."
      >
        {organizations.length === 0 ? (
          <EmptyState title="No organization memberships">
            Accept an invitation or ask an organization owner to invite you.
          </EmptyState>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th scope="col">Organization</th>
                <th scope="col">Your role</th>
              </tr>
            </thead>
            <tbody>
              {organizations.map((membership) => (
                <tr key={membership.organizationId}>
                  <td>{membership.organizationName}</td>
                  <td>
                    <StatusBadge>{membership.role.replace(/_/g, ' ')}</StatusBadge>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </SectionCard>

      <SectionCard
        title="Password"
        description="Password changes use the existing secure reset flow."
      >
        <PasswordResetPrompt />
      </SectionCard>

      <SectionCard title="Platform access">
        <p>
          You are {session.me.platformRole === null ? 'not' : ''} a Truevine platform operator.
          Customer organization roles and platform roles are separate authorities and one is never
          granted by the other.
        </p>
      </SectionCard>
    </>
  );
}
