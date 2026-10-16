/**
 * Read-only account facts.
 *
 * Email and user id are shown, not edited. There is no self-service email change:
 * changing the login identifier is an identity change that needs re-verification
 * of the new address, and building a half of that - an email field with no
 * verification behind it - would be worse than not offering it.
 */
export function AccountDetails({
  email,
  userId,
}: {
  readonly email: string;
  readonly userId: string;
}): React.JSX.Element {
  return (
    <dl style={{ margin: 0 }}>
      <dt className="field-hint">Email</dt>
      <dd style={{ margin: '0 0 0.9rem' }}>{email}</dd>

      <dt className="field-hint">User identifier</dt>
      <dd style={{ margin: '0 0 0.9rem', fontFamily: 'monospace', fontSize: '0.85rem' }}>
        {userId}
      </dd>
    </dl>
  );
}
