'use client';

import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useState } from 'react';

import type { OrganizationPermission } from '@truevine/auth';
import type { MembershipSummary } from '../../lib/session';

type NavigationItem = {
  readonly label: string;
  readonly href: string;
  readonly permission: OrganizationPermission | null;
};

export function organizationNavigationItems(
  membership: MembershipSummary,
): readonly NavigationItem[] {
  const organization = encodeURIComponent(membership.organizationId);
  const candidates: readonly NavigationItem[] = [
    { label: 'Dashboard', href: `/app?organization=${organization}`, permission: null },
    {
      label: 'Contacts',
      href: `/app/contacts?organization=${organization}`,
      permission: 'contact:read',
    },
    {
      label: 'Contact groups',
      href: `/app/contact-groups?organization=${organization}`,
      permission: 'contact:read',
    },
    {
      label: 'Campaigns',
      href: `/app/campaigns?organization=${organization}`,
      permission: 'campaign:read',
    },
    { label: 'Audio', href: `/app/audio?organization=${organization}`, permission: 'audio:read' },
    {
      label: 'Reports',
      href: `/app/reports?organization=${organization}`,
      permission: 'reporting:read',
    },
    {
      label: 'Organization',
      href: `/app/settings?organization=${organization}`,
      permission: 'organization:read',
    },
    { label: 'Team', href: `/app/team?organization=${organization}`, permission: 'member:read' },
    {
      label: 'Invitations',
      href: `/app/invitations?organization=${organization}`,
      permission: 'invitation:read',
    },
    {
      label: 'Billing',
      href: `/app/billing?organization=${organization}`,
      permission: 'billing:read',
    },
    { label: 'Account', href: '/app/account', permission: null },
  ];

  return candidates.filter(
    (item) => item.permission === null || membership.permissions.includes(item.permission),
  );
}

/** Organization navigation reflects the permissions returned by GET /me. */
export function AppNavigation({
  memberships,
}: {
  readonly memberships: readonly MembershipSummary[];
}): React.JSX.Element {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const router = useRouter();
  const [mobileOpen, setMobileOpen] = useState(false);
  const requestedOrganization = searchParams.get('organization');
  const selected =
    memberships.find((item) => item.organizationId === requestedOrganization) ?? memberships[0];

  if (!selected) {
    return (
      <nav className="app-navigation" aria-label="Organization">
        <p className="app-navigation__empty">
          Your account is not a member of an organization yet. Accept an invitation or ask an
          organization owner to invite you.
        </p>
        <Link className="app-navigation__link" href="/app/account">
          Account
        </Link>
      </nav>
    );
  }

  const links = organizationNavigationItems(selected);

  return (
    <nav className="app-navigation" aria-label="Organization navigation">
      <div className="app-navigation__context">
        <div className="app-navigation__organization">
          {memberships.length > 1 ? (
            <label>
              <span>Organization</span>
              <select
                aria-label="Organization"
                value={selected.organizationId}
                onChange={(event) => {
                  router.push(`/app?organization=${encodeURIComponent(event.target.value)}`);
                  setMobileOpen(false);
                }}
              >
                {memberships.map((membership) => (
                  <option key={membership.organizationId} value={membership.organizationId}>
                    {membership.organizationName}
                  </option>
                ))}
              </select>
            </label>
          ) : (
            <span className="app-navigation__organization-name">{selected.organizationName}</span>
          )}
        </div>
        <button
          className="app-navigation__toggle"
          type="button"
          aria-controls="organization-navigation-links"
          aria-expanded={mobileOpen}
          onClick={() => setMobileOpen((open) => !open)}
        >
          {mobileOpen ? 'Close menu' : 'Menu'}
        </button>
      </div>
      <div
        className="app-navigation__links"
        id="organization-navigation-links"
        data-open={mobileOpen}
      >
        {links.map((item) => {
          const route = item.href.split('?', 1)[0];
          const active =
            route === '/app'
              ? pathname === '/app'
              : pathname === route || pathname.startsWith(`${route}/`);

          return (
            <Link
              className="app-navigation__link"
              key={item.label}
              href={item.href}
              aria-current={active ? 'page' : undefined}
              onClick={() => setMobileOpen(false)}
            >
              {item.label}
            </Link>
          );
        })}
      </div>
    </nav>
  );
}
