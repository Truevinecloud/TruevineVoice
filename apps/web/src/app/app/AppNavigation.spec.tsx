// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AppNavigation, organizationNavigationItems } from './AppNavigation';
import type { MembershipSummary } from '../../lib/session';

const nav = vi.hoisted(() => ({ pathname: '/app', organization: 'org-a', push: vi.fn() }));
vi.mock('next/navigation', () => ({
  usePathname: () => nav.pathname,
  useRouter: () => ({ push: nav.push }),
  useSearchParams: () => new URLSearchParams(`organization=${nav.organization}`),
}));
vi.mock('next/link', () => ({
  default: ({ href, children, ...props }: React.AnchorHTMLAttributes<HTMLAnchorElement>) => (
    <a href={href as string} {...props}>
      {children}
    </a>
  ),
}));

const member: MembershipSummary = {
  organizationId: 'org-a',
  organizationSlug: 'alpha',
  organizationName: 'Alpha',
  role: 'VIEWER',
  permissions: ['campaign:read', 'audio:read', 'contact:read'],
};

describe('AppNavigation', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    nav.pathname = '/app';
    nav.organization = 'org-a';
    nav.push.mockReset();
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it('shows only links allowed by the selected backend membership permissions', () => {
    const labels = organizationNavigationItems(member).map((item) => item.label);
    expect(labels).toEqual([
      'Dashboard',
      'Contacts',
      'Contact groups',
      'Campaigns',
      'Audio',
      'Account',
    ]);
    expect(labels).not.toContain('Team');
    expect(labels).not.toContain('Billing');
  });

  it('opens and closes the phone navigation without changing session state', () => {
    act(() => root.render(<AppNavigation memberships={[member]} />));
    const toggle = container.querySelector('button[aria-controls]')!;
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    act(() => toggle.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(container.querySelector('.app-navigation__links')?.getAttribute('data-open')).toBe(
      'true',
    );
    act(() =>
      container
        .querySelector('a[href^="/app/campaigns"]')!
        .dispatchEvent(new MouseEvent('click', { bubbles: true })),
    );
    expect(container.querySelector('.app-navigation__links')?.getAttribute('data-open')).toBe(
      'false',
    );
    expect(container.querySelector('a[href="/app"]')?.getAttribute('aria-current')).toBe('page');
  });

  it('switches only to another organization returned by the authenticated session', () => {
    const second: MembershipSummary = {
      ...member,
      organizationId: 'org-b',
      organizationSlug: 'beta',
      organizationName: 'Beta',
      permissions: ['organization:read'],
    };
    act(() => root.render(<AppNavigation memberships={[member, second]} />));
    const selector = container.querySelector('select[aria-label="Organization"]')!;
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!.call(
        selector,
        'org-b',
      );
      selector.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(nav.push).toHaveBeenCalledWith('/app?organization=org-b');
  });
});
