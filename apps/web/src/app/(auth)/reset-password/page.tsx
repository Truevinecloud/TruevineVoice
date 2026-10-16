import { SetPasswordForm } from '../shared/SetPasswordForm';

/**
 * `/reset-password`
 *
 * `searchParams` is a Promise in Next.js 16, so it is awaited.
 *
 * A request with no token renders nothing but an explanation rather than a form
 * that could only fail. Sending someone to a reset form without a token wastes
 * their time and tells an attacker the screen exists.
 */
export default async function ResetPasswordPage({
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
        <h1>Reset your password</h1>
        <p className="auth-subtitle">
          This link is incomplete. Request a new one from the sign-in page.
        </p>
        <div className="auth-links">
          <a href="/forgot-password">Request a new link</a>
          <a href="/sign-in">Back to sign in</a>
        </div>
      </main>
    );
  }

  return (
    <main className="auth-shell">
      <SetPasswordForm
        token={token}
        title="Choose a new password"
        description="This link can be used once. Setting a new password signs out every other session."
      />
    </main>
  );
}
