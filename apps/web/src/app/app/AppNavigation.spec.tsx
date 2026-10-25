// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ORGANIZATION_ROLE_PERMISSIONS } from '@truevine/auth';
import type { MembershipSummary } from '../../lib/session';
import { AppNavigation, organizationNavigationItems } from './AppNavigation';

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
vi.mock('./SignOutButton', () => ({
  SignOutButton: () => (
    <button className="button-secondary" type="button">
      Sign out
    </button>
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

  it('shows links from backend permissions rather than assuming role-based access', () => {
    const labels = organizationNavigationItems(member).map((item) => item.label);
    expect(labels).toEqual([
      'Dashboard',
      'Contacts',
      'Contact Groups',
      'Campaigns',
      'Audio Library',
      'My Profile',
    ]);
    expect(labels).not.toContain('Team Members');
    expect(labels).not.toContain('Billing');
    expect(labels).not.toContain('Organization Settings');
  });

  it('does not add platform navigation for an organization Owner', () => {
    const owner = {
      ...member,
      role: 'OWNER' as const,
      permissions: [...ORGANIZATION_ROLE_PERMISSIONS.OWNER],
    };
    const items = organizationNavigationItems(owner);
    expect(items.map((item) => item.label)).toEqual([
      'Dashboard',
      'Contacts',
      'Contact Groups',
      'Campaigns',
      'Audio Library',
      'Reports',
      'Organization Settings',
      'Team Members',
      'Invitations',
      'Billing',
      'My Profile',
    ]);
    expect(items.every((item) => item.href.startsWith('/app'))).toBe(true);
    expect(items.some((item) => item.href.includes('platform'))).toBe(false);
  });

  it('opens the mobile drawer, exposes close controls, and restores focus on Escape', () => {
    act(() => root.render(<AppNavigation memberships={[member]} email="owner@example.test" />));
    const menu = container.querySelector<HTMLButtonElement>('.mobile-menu-button')!;
    expect(menu.getAttribute('aria-expanded')).toBe('false');
    act(() => menu.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    expect(menu.getAttribute('aria-expanded')).toBe('true');
    expect(container.querySelector('.app-sidebar')?.getAttribute('data-mobile-open')).toBe('true');
    expect(container.querySelector('.app-sidebar')?.getAttribute('role')).toBe('dialog');
    expect(container.querySelector('.app-sidebar')?.getAttribute('aria-modal')).toBe('true');
    expect(container.querySelector('.sidebar-backdrop')).not.toBeNull();
    const close = container.querySelector<HTMLButtonElement>('.sidebar-mobile-close')!;
    expect(close.getAttribute('aria-label')).toBe('Close navigation menu');
    const signOut = container.querySelector<HTMLButtonElement>(
      '.sidebar-footer .button-secondary',
    )!;
    act(() => {
      signOut.focus();
      signOut.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));
    });
    expect(document.activeElement).toBe(container.querySelector('.sidebar-brand-row a'));
    act(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })));
    expect(menu.getAttribute('aria-expanded')).toBe('false');
    expect(document.activeElement).toBe(menu);
  });

  it('highlights the active route and closes the drawer after navigation', () => {
    nav.pathname = '/app/campaigns';
    act(() => root.render(<AppNavigation memberships={[member]} email="owner@example.test" />));
    const campaignLink = container.querySelector<HTMLAnchorElement>(
      '.sidebar-nav-link[href^="/app/campaigns"]',
    )!;
    expect(campaignLink.getAttribute('aria-current')).toBe('page');
    const menu = container.querySelector<HTMLButtonElement>('.mobile-menu-button')!;
    act(() => menu.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    act(() => campaignLink.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    expect(container.querySelector('.app-sidebar')?.getAttribute('data-mobile-open')).toBe('false');
  });

  it('switches only between organizations returned by the authenticated session', () => {
    const second: MembershipSummary = {
      ...member,
      organizationId: 'org-b',
      organizationSlug: 'beta',
      organizationName: 'Beta',
      permissions: ['organization:read'],
    };
    act(() =>
      root.render(<AppNavigation memberships={[member, second]} email="owner@example.test" />),
    );
    const selector = container.querySelector<HTMLSelectElement>(
      'select[aria-label="Switch organization"]',
    )!;
    expect([...selector.options].map((option) => option.value)).toEqual(['org-a', 'org-b']);
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!.call(
        selector,
        'org-b',
      );
      selector.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(nav.push).toHaveBeenCalledWith('/app?organization=org-b');
    nav.push.mockClear();
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!.call(
        selector,
        'org-foreign',
      );
      selector.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(nav.push).not.toHaveBeenCalled();
  });

  it('supports a collapsed desktop sidebar with a control that announces its state', () => {
    act(() => root.render(<AppNavigation memberships={[member]} email="owner@example.test" />));
    const sidebar = container.querySelector('.app-sidebar')!;
    const collapse = container.querySelector<HTMLButtonElement>('.sidebar-collapse-button')!;
    expect(sidebar.getAttribute('data-collapsed')).toBe('false');
    act(() => collapse.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    expect(sidebar.getAttribute('data-collapsed')).toBe('true');
    expect(collapse.getAttribute('aria-label')).toBe('Expand sidebar');
  });
});
