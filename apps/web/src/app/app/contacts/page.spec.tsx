import { renderToStaticMarkup } from 'react-dom/server';
import {
  ORGANIZATION_ROLES,
  ORGANIZATION_ROLE_PERMISSIONS,
  type OrganizationRole,
} from '@truevine/auth';
import { afterEach, describe, expect, it, vi } from 'vitest';
import ContactsPage from './page';
import { ContactsNavigation } from './ContactsNavigation';
import type { MembershipSummary } from '../../../lib/session';

const mocks = vi.hoisted(() => ({ session: vi.fn() }));
vi.mock('../../../lib/session', () => ({
  currentSession: mocks.session,
  hasPermission: (membership: MembershipSummary, permission: string) =>
    membership.permissions.includes(permission),
}));
vi.mock('next/navigation', () => ({
  redirect: (url: string) => {
    throw new Error(`redirect:${url}`);
  },
}));

function membership(role: OrganizationRole, organizationId = 'org-a'): MembershipSummary {
  return {
    organizationId,
    organizationSlug: organizationId,
    organizationName: organizationId,
    role,
    permissions: ORGANIZATION_ROLE_PERMISSIONS[role],
  };
}
afterEach(() => vi.clearAllMocks());

describe('Contacts route and organization navigation policy', () => {
  it.each(ORGANIZATION_ROLES)('matches existing backend permissions for %s', async (role) => {
    const member = membership(role);
    mocks.session.mockResolvedValue({
      ok: true,
      me: { termsAccepted: true, memberships: [member] },
    });
    const markup = renderToStaticMarkup(await ContactsPage({ searchParams: Promise.resolve({}) }));
    const navigation = renderToStaticMarkup(<ContactsNavigation memberships={[member]} />);
    const allowed = ['OWNER', 'ADMIN', 'CAMPAIGN_MANAGER'].includes(role);
    expect(markup.includes('Search contacts')).toBe(allowed);
    expect(markup.includes('Add Contact')).toBe(allowed);
    expect(navigation.includes('/app/contacts?organization=org-a')).toBe(allowed);
    expect(markup.includes('do not have access')).toBe(!allowed);
  });

  it('rejects an unheld tenant selection without mounting the API client', async () => {
    mocks.session.mockResolvedValue({
      ok: true,
      me: { termsAccepted: true, memberships: [membership('OWNER')] },
    });
    const markup = renderToStaticMarkup(
      await ContactsPage({ searchParams: Promise.resolve({ organization: 'foreign' }) }),
    );
    expect(markup).toContain('do not have access');
    expect(markup).not.toContain('Search contacts');
  });

  it('uses the requested authenticated membership and never borrows permissions from another tenant', async () => {
    const memberships = [
      membership('OWNER'),
      membership('VIEWER', 'org-b'),
      membership('ADMIN', 'org-c'),
    ];
    mocks.session.mockResolvedValue({ ok: true, me: { termsAccepted: true, memberships } });
    const denied = renderToStaticMarkup(
      await ContactsPage({ searchParams: Promise.resolve({ organization: 'org-b' }) }),
    );
    expect(denied).toContain('do not have access');
    const permitted = await ContactsPage({
      searchParams: Promise.resolve({ organization: 'org-c' }),
    });
    expect(permitted.props).toMatchObject({
      organizationId: 'org-c',
      canCreate: true,
      canUpdate: true,
    });
    const navigation = renderToStaticMarkup(<ContactsNavigation memberships={memberships} />);
    expect(navigation).toContain('organization=org-a');
    expect(navigation).toContain('organization=org-c');
    expect(navigation).not.toContain('organization=org-b');
  });

  it('requires a session, accepted terms and an actual membership', async () => {
    mocks.session.mockResolvedValue({ ok: false });
    await expect(ContactsPage({ searchParams: Promise.resolve({}) })).rejects.toThrow(
      'redirect:/sign-in',
    );
    mocks.session.mockResolvedValue({ ok: true, me: { termsAccepted: false } });
    await expect(ContactsPage({ searchParams: Promise.resolve({}) })).rejects.toThrow(
      'redirect:/accept-terms',
    );
    mocks.session.mockResolvedValue({ ok: true, me: { termsAccepted: true, memberships: [] } });
    expect(
      renderToStaticMarkup(await ContactsPage({ searchParams: Promise.resolve({}) })),
    ).toContain('do not have access');
  });
});
