import { redirect } from 'next/navigation';

import { currentSession } from '../../../lib/session';

import { AccountDetails } from './AccountDetails';
import { PasswordResetPrompt } from './PasswordResetPrompt';

/** `/app/account` - profile and security settings. */
export default async function AccountPage(): Promise<React.JSX.Element> {
  const session = await currentSession();

  if (!session.ok) redirect('/sign-in');

  const organizations = session.me.memberships;

  return (
    <>
      <h1 className="page-title">Account and security</h1>

      <div className="card-section">
        <h2>Profile</h2>
        <AccountDetails email={session.me.email} userId={session.me.userId} />
      </div>

      <div className="card-section">
        <h2>Organizations</h2>
        {organizations.length === 0 ? (
          <p>You do not belong to any organization.</p>
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
                    <span className="tag">{membership.role.replace(/_/g, ' ')}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="card-section">
        <h2>Password</h2>
        <PasswordResetPrompt />
      </div>

      <div className="card-section">
        <h2>Platform access</h2>
        <p>
          You are {session.me.platformRole === null ? 'not' : ''} a Truevine platform operator.
          Customer organization roles and platform roles are separate authorities and one is never
          granted by the other.
        </p>
      </div>
    </>
  );
}
