'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useState, type ReactNode } from 'react';

import { canActAsPlatform, PLATFORM_ROLES, type PlatformRole } from '@truevine/auth';

import { api } from '../lib/api';

type PlatformMe = { platformRole: PlatformRole | null };
type PlatformLink = {
  label: string;
  href: string;
  permission: Parameters<typeof canActAsPlatform>[1];
};

const PLATFORM_LINKS: readonly PlatformLink[] = [
  { label: 'Operations', href: '/', permission: 'platform:operations:read' },
  { label: 'Support', href: '/support', permission: 'platform:support:read' },
  { label: 'Technical', href: '/technical', permission: 'platform:technical:read' },
  { label: 'Audit', href: '/auditor', permission: 'platform:audit:read' },
];

export function platformNavigationItems(role: PlatformRole | null): readonly PlatformLink[] {
  if (!role || !PLATFORM_ROLES.includes(role)) return [];
  return PLATFORM_LINKS.filter((item) => canActAsPlatform(role, item.permission));
}

export function PlatformShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const [role, setRole] = useState<PlatformRole | null>(null);
  const [checked, setChecked] = useState(false);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    let active = true;
    const refresh = async () => {
      try {
        const me = await api<PlatformMe>('/me');
        if (active)
          setRole(
            me.platformRole && PLATFORM_ROLES.includes(me.platformRole) ? me.platformRole : null,
          );
      } catch {
        if (active) setRole(null);
      } finally {
        if (active) setChecked(true);
      }
    };
    void refresh();
    window.addEventListener('truevine:session-changed', refresh);
    return () => {
      active = false;
      window.removeEventListener('truevine:session-changed', refresh);
    };
  }, []);

  const items = platformNavigationItems(role);

  async function signOut() {
    await api('/auth/sign-out', { method: 'POST' }).catch(() => undefined);
    setRole(null);
    window.dispatchEvent(new Event('truevine:session-changed'));
    router.replace('/');
    router.refresh();
  }

  return (
    <div className="platform-app-shell">
      <header className="platform-shell-header">
        <Link className="platform-shell-brand" href="/">
          Truevine Voice <span>Platform</span>
        </Link>
        {checked && role && (
          <button className="platform-shell-signout" type="button" onClick={() => void signOut()}>
            Sign out
          </button>
        )}
        {checked && role && (
          <button
            className="platform-shell-toggle"
            type="button"
            aria-controls="platform-shell-links"
            aria-expanded={open}
            onClick={() => setOpen((value) => !value)}
          >
            {open ? 'Close menu' : 'Menu'}
          </button>
        )}
      </header>
      {checked && role && items.length > 0 && (
        <nav className="platform-shell-nav" aria-label="Platform administration">
          <span className="platform-shell-context">Platform administration</span>
          <div id="platform-shell-links" className="platform-shell-links" data-open={open}>
            {items.map((item) => {
              const active =
                item.href === '/'
                  ? pathname === '/'
                  : pathname === item.href || pathname.startsWith(`${item.href}/`);
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  aria-current={active ? 'page' : undefined}
                  onClick={() => setOpen(false)}
                >
                  {item.label}
                </Link>
              );
            })}
          </div>
        </nav>
      )}
      {children}
    </div>
  );
}
