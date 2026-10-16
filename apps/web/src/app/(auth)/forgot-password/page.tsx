import { ForgotPasswordForm } from './ForgotPasswordForm';

/** `/forgot-password` */
export default function ForgotPasswordPage(): React.JSX.Element {
  return (
    <main className="auth-shell">
      <h1>Reset your password</h1>
      <p className="auth-subtitle">
        Enter the address you sign in with and we will send you a link.
      </p>

      <ForgotPasswordForm />

      <div className="auth-links">
        <a href="/sign-in">Back to sign in</a>
      </div>
    </main>
  );
}
