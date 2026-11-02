import Link from 'next/link';

/**
 * Shared chrome for the platform Settings workspace.
 *
 * Pure presentational components only: the pages own access checks and data.
 * Settings is a platform area, so every link here is a platform route and none
 * of them takes an organization id.
 */

export type SettingsSection = 'overview' | 'payments';

export function SettingsHeader({ title }: { title: string }) {
  return (
    <header className="topbar">
      <div>
        <span className="eyebrow">TRUEVINE VOICE · PLATFORM SETTINGS</span>
        <h1>{title}</h1>
      </div>
      <Link className="quiet-button" href="/">
        Operations home
      </Link>
    </header>
  );
}

export function SettingsNav({ current }: { current: SettingsSection }) {
  const sections: Array<{ key: SettingsSection; href: string; label: string }> = [
    { key: 'overview', href: '/settings', label: 'Settings' },
    { key: 'payments', href: '/settings/payments', label: 'Payment integrations' },
  ];

  return (
    <nav className="settings-nav" aria-label="Settings sections">
      {sections.map((section) => (
        <Link
          key={section.key}
          href={section.href}
          aria-current={current === section.key ? 'page' : undefined}
        >
          {section.label}
        </Link>
      ))}
    </nav>
  );
}

export function SettingsAccessNotice({ status }: { status: number | null }) {
  if (status === 401) {
    return (
      <p className="notice" role="status">
        Sign in with a platform Super Admin account from the <Link href="/">operations home</Link>.
      </p>
    );
  }
  if (status === 403) {
    return (
      <p className="notice" role="status">
        Payment integration settings are available to the platform Super Admin only. Your role does
        not include access to payment-provider credentials.
      </p>
    );
  }
  if (status === 503) {
    return (
      <p className="notice" role="status">
        Settings are temporarily unavailable because the API is not reachable.
      </p>
    );
  }
  if (status !== null) {
    return (
      <p className="notice" role="status">
        Settings could not be loaded. Your account and data are unchanged.
      </p>
    );
  }
  return null;
}
