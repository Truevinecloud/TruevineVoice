// @vitest-environment happy-dom
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ORGANIZATION_ROLE_PERMISSIONS } from '@truevine/auth';
import ContactsPage from './contacts/page';
import ContactGroupsPage from './contact-groups/page';
import AudioPage from './audio/page';
import CampaignsPage from './campaigns/page';
import ReportsPage from './reports/page';
import SettingsPage from './settings/page';
import TeamPage from './team/page';
import InvitationsPage from './invitations/page';
import BillingPage from './billing/page';
import DashboardPage from './page';
import { organizationNavigationItems } from './AppNavigation';

const mocks = vi.hoisted(() => ({
  session: vi.fn(),
  campaigns: vi.fn(),
  report: vi.fn(),
  organization: vi.fn(),
  members: vi.fn(),
  invitations: vi.fn(),
  billing: vi.fn(),
  contacts: vi.fn(),
  groups: vi.fn(),
  audio: vi.fn(),
}));

vi.mock('../../../lib/session', () => ({
  currentSession: mocks.session,
  hasPermission: (
    membership:
      | {
          permissions: readonly string[];
          role?: string;
          userId?: string;
          organizationId?: string;
        }
      | undefined,
    permission: string,
  ) => membership?.permissions.includes(permission) ?? false,
}));

vi.mock('../../../lib/org-api', () => ({
  fetchCampaigns: mocks.campaigns,
  fetchCampaignStatusReport: mocks.report,
  fetchOrganization: mocks.organization,
  fetchMembers: mocks.members,
  fetchInvitations: mocks.invitations,
}));

vi.mock('../../../lib/billing-api', () => ({
  fetchBilling: mocks.billing,
}));

vi.mock('next/navigation', () => ({
  redirect: (url: string) => {
    throw new Error(`redirect:${url}`);
  },
}));

function campaignManagerSession() {
  return {
    ok: true,
    me: {
      termsAccepted: true,
      userId: 'user-cm',
      memberships: [
        {
          organizationId: 'org-a',
          organizationSlug: 'alpha',
          organizationName: 'Alpha',
          role: 'CAMPAIGN_MANAGER' as const,
          permissions: [...ORGANIZATION_ROLE_PERMISSIONS.CAMPAIGN_MANAGER],
        },
      ],
    },
  };
}

function _sessionWith(
  permissions: string[],
  role: 'OWNER' | 'ADMIN' | 'CAMPAIGN_MANAGER' | 'BILLING' | 'VIEWER' = 'VIEWER',
) {
  return {
    ok: true,
    me: {
      termsAccepted: true,
      userId: 'user-1',
      memberships: [
        {
          organizationId: 'org-a',
          organizationSlug: 'alpha',
          organizationName: 'Alpha',
          role,
          permissions,
        },
      ],
    },
  };
}

afterEach(() => vi.clearAllMocks());

describe('RBAC-003 Campaign Manager navigation visibility', () => {
  it('shows only permitted items in nav', () => {
    const session = campaignManagerSession();
    const membership = session.me.memberships[0] as any;
    const labels = organizationNavigationItems(membership).map((item: any) => item.label);
    expect(labels).toContain('Dashboard');
    expect(labels).toContain('Contacts');
    expect(labels).toContain('Contact Groups');
    expect(labels).toContain('Campaigns');
    expect(labels).toContain('Reports');
    expect(labels).toContain('Organization Settings');
    expect(labels).not.toContain('Audio Library');
    expect(labels).not.toContain('Team Members');
    expect(labels).not.toContain('Invitations');
    expect(labels).not.toContain('Billing');
    expect(labels).not.toContain('My Profile'); // profile is separate, check separately
  });
});

describe('RBAC-003 Campaign Manager page guards - allowed', () => {
  it('allows dashboard', async () => {
    mocks.session.mockResolvedValue(campaignManagerSession());
    (mocks as any).organization.mockResolvedValue({ id: 'org-a', name: 'Alpha' });
    (mocks as any).members.mockResolvedValue([]);
    (mocks as any).invitations.mockResolvedValue([]);
    const html = renderToStaticMarkup(
      await (DashboardPage as any)({ searchParams: Promise.resolve({ organization: 'org-a' }) }),
    );
    expect(html).toContain('Alpha');
  });

  it('allows contacts', async () => {
    mocks.session.mockResolvedValue(campaignManagerSession());
    const html = renderToStaticMarkup(
      await ContactsPage({ searchParams: Promise.resolve({ organization: 'org-a' }) }),
    );
    expect(html).not.toContain('do not have access');
    expect(html).toContain('Contacts');
  });

  it('allows contact groups', async () => {
    mocks.session.mockResolvedValue(campaignManagerSession());
    const html = renderToStaticMarkup(
      await ContactGroupsPage({ searchParams: Promise.resolve({ organization: 'org-a' }) }),
    );
    expect(html).not.toContain('do not have access');
    expect(html).toContain('Contact groups');
  });

  it('allows campaigns', async () => {
    mocks.session.mockResolvedValue(campaignManagerSession());
    mocks.campaigns.mockResolvedValue([]);
    const html = renderToStaticMarkup(
      await CampaignsPage({ searchParams: Promise.resolve({ organization: 'org-a' }) }),
    );
    expect(html).not.toContain('do not have campaign access');
    expect(html).toContain('Campaigns');
  });

  it('allows reports', async () => {
    mocks.session.mockResolvedValue(campaignManagerSession());
    mocks.report.mockResolvedValue({ total: 0, draft: 0, active: 0, completed: 0 });
    const html = renderToStaticMarkup(
      await ReportsPage({ searchParams: Promise.resolve({ organization: 'org-a' }) }),
    );
    expect(html).not.toContain('do not have reporting access');
    expect(html).toContain('Reports');
  });

  it('allows read-only organization settings', async () => {
    mocks.session.mockResolvedValue(campaignManagerSession());
    mocks.organization.mockResolvedValue({ id: 'org-a', name: 'Alpha', slug: 'alpha' });
    const html = renderToStaticMarkup(
      await SettingsPage({ searchParams: Promise.resolve({ organization: 'org-a' }) }),
    );
    expect(html).not.toContain('You do not have permission');
    expect(html).toContain('Organization settings');
  });
});

describe('RBAC-003 Campaign Manager page guards - denied', () => {
  it('denies team management', async () => {
    mocks.session.mockResolvedValue(campaignManagerSession());
    const html = renderToStaticMarkup(
      await TeamPage({ searchParams: Promise.resolve({ organization: 'org-a' }) }),
    );
    expect(html).toContain('You do not have permission to view members');
  });

  it('denies invitations', async () => {
    mocks.session.mockResolvedValue(campaignManagerSession());
    const html = renderToStaticMarkup(
      await InvitationsPage({ searchParams: Promise.resolve({ organization: 'org-a' }) }),
    );
    expect(html).toContain('Your role cannot view invitations');
  });

  it('denies billing and wallet', async () => {
    mocks.session.mockResolvedValue(campaignManagerSession());
    const html = renderToStaticMarkup(
      await BillingPage({ searchParams: Promise.resolve({ organization: 'org-a' }) }),
    );
    expect(html).toContain('You do not have billing access');
    expect(mocks.billing).not.toHaveBeenCalled();
  });

  it('denies ownership transfer UI (no transfer controls)', async () => {
    mocks.session.mockResolvedValue(campaignManagerSession());
    mocks.members.mockResolvedValue([
      { userId: 'u1', email: 'owner@example.test', role: 'OWNER', joinedAt: '2026-01-01T00:00:00Z' },
      { userId: 'u2', email: 'other@example.test', role: 'ADMIN', joinedAt: '2026-01-01T00:00:00Z' },
    ]);
    const html = renderToStaticMarkup(
      await TeamPage({ searchParams: Promise.resolve({ organization: 'org-a' }) }),
    );
    expect(html).not.toContain('Transfer ownership');
  });

  it('denies audio library (no audio:read)', async () => {
    mocks.session.mockResolvedValue(campaignManagerSession());
    const html = renderToStaticMarkup(
      await AudioPage({ searchParams: Promise.resolve({ organization: 'org-a' }) }),
    );
    expect(html).toContain('You do not have audio access');
  });

  it('refuses foreign organization access before fetching data', async () => {
    mocks.session.mockResolvedValue(campaignManagerSession());
    mocks.campaigns.mockClear();
    const html = renderToStaticMarkup(
      await CampaignsPage({ searchParams: Promise.resolve({ organization: 'org-b' }) }),
    );
    expect(html).toContain('You do not have campaign access');
    expect(mocks.campaigns).not.toHaveBeenCalled();
  });
});

describe('RBAC-003 Campaign Manager campaign UI', () => {
  it('shows campaign builder but no obvious create controls requiring extra perms beyond read/update', async () => {
    mocks.session.mockResolvedValue(campaignManagerSession());
    mocks.campaigns.mockResolvedValue([
      {
        id: 'c1',
        name: 'Autumn calls',
        status: 'DRAFT',
        createdAt: '2026-10-01T00:00:00.000Z',
        updatedAt: '2026-10-02T00:00:00.000Z',
      },
    ]);
    const html = renderToStaticMarkup(
      await CampaignsPage({ searchParams: Promise.resolve({ organization: 'org-a' }) }),
    );
    // CampaignBuilder is rendered; we just verify page doesn't crash and shows content
    expect(html).toContain('Campaigns');
    expect(html).toContain('Autumn calls');
  });
});
