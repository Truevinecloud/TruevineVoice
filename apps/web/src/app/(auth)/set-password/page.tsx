import { SetPasswordForm } from '../shared/SetPasswordForm';

/**
 * `/set-password`
 *
 * The activation endpoint an operator's provisioning link points at. An account
 * created by `npm run provision:owner` has no usable password until this is used,
 * which is why the wording says so plainly.
 */
export default async function SetPasswordPage({
  searchParams,
}: {
  readonly searchParams: Promise<{ readonly token?: string | string[] }>;
}): Promise<React.JSX.Element> {
  const params = await searchParams;
  const raw = params.token;
  const token = Array.isArray(raw) ? raw[0] : raw;

  if (token === undefined || token.length === 0) {
    return (
      <main className="auth-shell">
        <h1>Set your password</h1>
        <p className="auth-subtitle">
          This activation link is incomplete. Ask whoever provisioned your account for a new one.
        </p>
        <div className="auth-links">
          <a href="/sign-in">Go to sign in</a>
        </div>
      </main>
    );
  }

  return (
    <main className="auth-shell">
      <SetPasswordForm
        token={token}
        title="Set your password"
        description="Your account has no password yet. Choose one now to finish activation."
      />
    </main>
  );
}
