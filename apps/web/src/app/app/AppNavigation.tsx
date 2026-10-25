'use client';

import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';

import type { OrganizationPermission } from '@truevine/auth';
import type { MembershipSummary } from '../../lib/session';
import { SignOutButton } from './SignOutButton';

type NavGroup = 'Workspace' | 'Organization' | 'Account';
type NavigationItem = {
  readonly label: string;
  readonly href: string;
  readonly group: NavGroup;
  readonly icon: string;
  readonly permissions: readonly OrganizationPermission[];
};

export function organizationNavigationItems(
  membership: MembershipSummary,
): readonly NavigationItem[] {
  const organization = encodeURIComponent(membership.organizationId);
  const candidates: readonly NavigationItem[] = [
    {
      label: 'Dashboard',
      href: `/app?organization=${organization}`,
      group: 'Workspace',
      icon: 'grid',
      permissions: [],
    },
    {
      label: 'Contacts',
      href: `/app/contacts?organization=${organization}`,
      group: 'Workspace',
      icon: 'users',
      permissions: ['contact:read'],
    },
    {
      label: 'Contact Groups',
      href: `/app/contact-groups?organization=${organization}`,
      group: 'Workspace',
      icon: 'layers',
      permissions: ['contact:read'],
    },
    {
      label: 'Campaigns',
      href: `/app/campaigns?organization=${organization}`,
      group: 'Workspace',
      icon: 'send',
      permissions: ['campaign:read'],
    },
    {
      label: 'Audio Library',
      href: `/app/audio?organization=${organization}`,
      group: 'Workspace',
      icon: 'audio',
      permissions: ['audio:read'],
    },
    {
      label: 'Reports',
      href: `/app/reports?organization=${organization}`,
      group: 'Workspace',
      icon: 'chart',
      permissions: ['reporting:read'],
    },
    {
      label: 'Organization Settings',
      href: `/app/settings?organization=${organization}`,
      group: 'Organization',
      icon: 'building',
      permissions: ['organization:read'],
    },
    {
      label: 'Team Members',
      href: `/app/team?organization=${organization}`,
      group: 'Organization',
      icon: 'team',
      permissions: ['member:read'],
    },
    {
      label: 'Invitations',
      href: `/app/invitations?organization=${organization}`,
      group: 'Organization',
      icon: 'mail',
      permissions: ['invitation:read'],
    },
    {
      label: 'Billing',
      href: `/app/billing?organization=${organization}`,
      group: 'Organization',
      icon: 'wallet',
      permissions: ['billing:read', 'wallet:read'],
    },
    { label: 'My Profile', href: '/app/account', group: 'Account', icon: 'user', permissions: [] },
  ];

  return candidates.filter((item) =>
    item.permissions.every((permission) => membership.permissions.includes(permission)),
  );
}

function NavIcon({ name }: { readonly name: string }): React.JSX.Element {
  const paths: Record<string, React.ReactNode> = {
    grid: (
      <>
        <rect x="3" y="3" width="7" height="7" rx="1.5" />
        <rect x="14" y="3" width="7" height="7" rx="1.5" />
        <rect x="3" y="14" width="7" height="7" rx="1.5" />
        <rect x="14" y="14" width="7" height="7" rx="1.5" />
      </>
    ),
    users: (
      <>
        <path d="M16 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
        <circle cx="10" cy="7" r="4" />
        <path d="M20 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75" />
      </>
    ),
    layers: (
      <>
        <path d="m12 3 9 5-9 5-9-5 9-5Z" />
        <path d="m3 12 9 5 9-5M3 16l9 5 9-5" />
      </>
    ),
    send: (
      <>
        <path d="m22 2-7 20-4-9-9-4Z" />
        <path d="M22 2 11 13" />
      </>
    ),
    audio: (
      <>
        <path d="M9 18V5l12-2v13" />
        <circle cx="6" cy="18" r="3" />
        <circle cx="18" cy="16" r="3" />
      </>
    ),
    chart: (
      <>
        <path d="M3 3v18h18" />
        <path d="m19 9-5 5-4-4-5 5" />
      </>
    ),
    building: (
      <>
        <rect x="4" y="3" width="16" height="18" rx="2" />
        <path d="M9 21v-4h6v4M8 7h1m6 0h1M8 11h1m6 0h1" />
      </>
    ),
    team: (
      <>
        <circle cx="9" cy="8" r="3" />
        <path d="M3 20a6 6 0 0 1 12 0M16 5a3 3 0 0 1 0 6m2 3a5 5 0 0 1 3 5" />
      </>
    ),
    mail: (
      <>
        <rect x="3" y="5" width="18" height="14" rx="2" />
        <path d="m3 7 9 6 9-6" />
      </>
    ),
    wallet: (
      <>
        <rect x="3" y="5" width="18" height="15" rx="2" />
        <path d="M3 8V6a2 2 0 0 1 2-2h14M16 14h.01" />
        <path d="M21 10h-5a3 3 0 0 0 0 6h5" />
      </>
    ),
    user: (
      <>
        <circle cx="12" cy="8" r="4" />
        <path d="M4 21a8 8 0 0 1 16 0" />
      </>
    ),
  };
  return (
    <svg
      aria-hidden="true"
      className="nav-icon"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {paths[name]}
    </svg>
  );
}

/** Organization links are derived only from the authenticated /me memberships. */
export function AppNavigation({
  memberships,
  email,
}: {
  readonly memberships: readonly MembershipSummary[];
  readonly email: string;
}): React.JSX.Element {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const router = useRouter();
  const requestedOrganization = searchParams.get('organization');
  const selected =
    memberships.find((item) => item.organizationId === requestedOrganization) ?? memberships[0];
  const [collapsed, setCollapsed] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);
  const menuButton = useRef<HTMLButtonElement>(null);
  const sidebar = useRef<HTMLElement>(null);
  const wasMobileOpen = useRef(false);

  useEffect(() => {
    if (!mobileOpen) {
      if (wasMobileOpen.current) menuButton.current?.focus();
      wasMobileOpen.current = false;
      return;
    }
    wasMobileOpen.current = true;
    sidebar.current?.querySelector<HTMLElement>('.sidebar-mobile-close')?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setMobileOpen(false);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [mobileOpen]);

  const links = selected ? organizationNavigationItems(selected) : [];
  const groups: readonly NavGroup[] = ['Workspace', 'Organization', 'Account'];

  function chooseOrganization(organizationId: string): void {
    // The select options are the session memberships. Never navigate to an ID
    // supplied outside that authenticated list.
    if (!memberships.some((entry) => entry.organizationId === organizationId)) return;
    router.push(`/app?organization=${encodeURIComponent(organizationId)}`);
    setMobileOpen(false);
  }

  return (
    <>
      <a className="skip-link" href="#main-content">
        Skip to content
      </a>
      <header className="app-topbar">
        <button
          ref={menuButton}
          className="mobile-menu-button"
          type="button"
          aria-label="Open navigation menu"
          aria-controls="app-sidebar"
          aria-expanded={mobileOpen}
          onClick={() => setMobileOpen(true)}
        >
          <span />
          <span />
          <span />
        </button>
        <Link
          className="app-brand app-brand--top"
          href={
            selected ? `/app?organization=${encodeURIComponent(selected.organizationId)}` : '/app'
          }
        >
          <span className="brand-mark" aria-hidden="true">
            T
          </span>
          <span>
            Truevine <strong>Voice</strong>
          </span>
        </Link>
        <div className="topbar-context">
          <label className="organization-switcher">
            <span className="organization-switcher__label">Workspace</span>
            {memberships.length > 1 ? (
              <select
                aria-label="Switch organization"
                value={selected?.organizationId ?? ''}
                onChange={(event) => chooseOrganization(event.target.value)}
              >
                {memberships.map((entry) => (
                  <option key={entry.organizationId} value={entry.organizationId}>
                    {entry.organizationName}
                  </option>
                ))}
              </select>
            ) : (
              <span className="organization-switcher__name">
                {selected?.organizationName ?? 'No organization'}
              </span>
            )}
          </label>
          <Link className="topbar-account" href="/app/account" aria-label={`Account: ${email}`}>
            <span className="avatar" aria-hidden="true">
              {email.slice(0, 1).toUpperCase()}
            </span>
            <span className="topbar-account__identity">
              <strong>{email}</strong>
              <small>Account</small>
            </span>
            <span className="topbar-chevron" aria-hidden="true">
              ⌄
            </span>
          </Link>
        </div>
      </header>

      {mobileOpen && (
        <button
          className="sidebar-backdrop"
          type="button"
          aria-label="Close navigation menu"
          onClick={() => setMobileOpen(false)}
        />
      )}
      <aside
        ref={sidebar}
        id="app-sidebar"
        className="app-sidebar"
        data-collapsed={collapsed}
        data-mobile-open={mobileOpen}
        role={mobileOpen ? 'dialog' : undefined}
        aria-modal={mobileOpen ? true : undefined}
        aria-label="Application sidebar"
        onKeyDown={(event) => {
          if (!mobileOpen || event.key !== 'Tab') return;
          const focusable = Array.from(
            sidebar.current?.querySelectorAll<HTMLElement>(
              'a[href], button:not(:disabled):not(.sidebar-collapse-button), select:not(:disabled)',
            ) ?? [],
          );
          const first = focusable[0];
          const last = focusable.at(-1);
          if (event.shiftKey && document.activeElement === first) {
            event.preventDefault();
            last?.focus();
          } else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault();
            first?.focus();
          }
        }}
      >
        <div className="sidebar-brand-row">
          <Link
            className="app-brand"
            href={
              selected ? `/app?organization=${encodeURIComponent(selected.organizationId)}` : '/app'
            }
            onClick={() => setMobileOpen(false)}
          >
            <span className="brand-mark" aria-hidden="true">
              T
            </span>
            <span className="brand-wordmark">
              Truevine <strong>Voice</strong>
            </span>
          </Link>
          <button
            className="sidebar-mobile-close"
            type="button"
            aria-label="Close navigation menu"
            onClick={() => setMobileOpen(false)}
          >
            ×
          </button>
        </div>
        <div
          className="sidebar-organization"
          title={selected?.organizationName ?? 'No organization'}
        >
          <span className="organization-avatar" aria-hidden="true">
            {selected?.organizationName.slice(0, 1).toUpperCase() ?? '—'}
          </span>
          <span className="sidebar-organization__text">
            <small>Current workspace</small>
            <strong>{selected?.organizationName ?? 'No organization'}</strong>
          </span>
        </div>
        <nav className="sidebar-navigation" aria-label="Main navigation">
          {selected ? (
            groups.map((group) => {
              const groupItems = links.filter((item) => item.group === group);
              if (groupItems.length === 0) return null;
              return (
                <section className="sidebar-nav-group" key={group} aria-label={group}>
                  <h2 className="sidebar-nav-heading">{group}</h2>
                  {groupItems.map((item) => {
                    const route = item.href.split('?', 1)[0];
                    const active =
                      route === '/app'
                        ? pathname === '/app'
                        : pathname === route || pathname.startsWith(`${route}/`);
                    return (
                      <Link
                        className="sidebar-nav-link"
                        key={item.label}
                        href={item.href}
                        aria-current={active ? 'page' : undefined}
                        title={collapsed ? item.label : undefined}
                        onClick={() => setMobileOpen(false)}
                      >
                        <NavIcon name={item.icon} />
                        <span className="sidebar-nav-label">{item.label}</span>
                      </Link>
                    );
                  })}
                </section>
              );
            })
          ) : (
            <div className="sidebar-empty-state">
              <strong>No workspace yet</strong>
              <p>Accept an invitation or ask an organization owner to invite you.</p>
              <Link href="/app/account">View account</Link>
            </div>
          )}
        </nav>
        <div className="sidebar-footer">
          <SignOutButton />
          <button
            className="sidebar-collapse-button"
            type="button"
            aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
            aria-expanded={!collapsed}
            onClick={() => setCollapsed((value) => !value)}
          >
            <span aria-hidden="true">{collapsed ? '›' : '‹'}</span>
            <span className="sidebar-nav-label">Collapse sidebar</span>
          </button>
        </div>
      </aside>
    </>
  );
}
