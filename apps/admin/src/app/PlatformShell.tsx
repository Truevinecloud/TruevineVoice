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
  { label: 'Settings', href: '/settings', permission: 'platform:payments:read' },
  { label: 'Platform Admins', href: '/platform-admin', permission: 'platform:admin:manage' },
];

export function isPlatformNavItemActive(pathname: string, href: string): boolean {
  return href === '/' ? pathname === '/' : pathname === href || pathname.startsWith(`${href}/`);
}

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
      <header className="platform-mobile-header">
        <Link className="platform-shell-brand" href="/">
          Truevine Voice <span>Platform</span>
        </Link>
        {checked && role && items.length > 0 && (
          <button
            className="platform-shell-toggle"
            type="button"
            aria-controls="platform-sidebar"
            aria-expanded={open}
            onClick={() => setOpen((value) => !value)}
          >
            {open ? 'Close menu' : 'Menu'}
          </button>
        )}
      </header>

      <aside
        id="platform-sidebar"
        className="platform-sidebar"
        data-open={open}
        aria-label="Platform administration"
      >
        <div className="platform-sidebar-header">
          <Link className="platform-shell-brand" href="/">
            Truevine Voice <span>Platform</span>
          </Link>
          {checked && role && items.length > 0 && (
            <button
              className="platform-shell-toggle platform-sidebar-close"
              type="button"
              aria-controls="platform-sidebar"
              aria-expanded={open}
              onClick={() => setOpen(false)}
            >
              Close
            </button>
          )}
        </div>

        {checked && role && items.length > 0 && (
          <>
            <span className="platform-shell-context">Platform administration</span>
            <nav className="platform-sidebar-nav">
              <div className="platform-shell-links">
                {items.map((item) => {
                  const active = isPlatformNavItemActive(pathname, item.href);
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
            <div className="platform-sidebar-footer">
              <button className="platform-shell-signout" type="button" onClick={() => void signOut()}>
                Sign out
              </button>
            </div>
          </>
        )}
      </aside>

      {open && (
        <button
          type="button"
          className="platform-sidebar-backdrop"
          aria-label="Close navigation"
          onClick={() => setOpen(false)}
        />
      )}

      <main className="platform-main">{children}</main>
    </div>
  );
}