// @vitest-environment happy-dom
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ORGANIZATION_ROLE_PERMISSIONS } from '@truevine/auth';
import type { MembershipSummary } from '../../lib/session';
import AudioPage from './audio/page';
import BillingPage from './billing/page';
import CampaignsPage from './campaigns/page';
import ContactGroupsPage from './contact-groups/page';
import ContactsPage from './contacts/page';
import InvitationsPage from './invitations/page';
import DashboardPage from './page';
import ReportsPage from './reports/page';
import SettingsPage from './settings/page';
import TeamPage from './team/page';
import { organizationNavigationItems } from './AppNavigation';

const mocks = vi.hoisted(() => ({
  session: vi.fn(),
  campaigns: vi.fn(),
  report: vi.fn(),
  organization: vi.fn(),
  members: vi.fn(),
  invitations: vi.fn(),
  billing: vi.fn(),
}));

vi.mock('../../lib/session', () => ({
  currentSession: mocks.session,
  hasPermission: (
    membership: { readonly permissions: readonly string[] } | undefined,
    permission: string,
  ) => membership?.permissions.includes(permission) ?? false,
}));

vi.mock('../../lib/org-api', () => ({
  fetchCampaigns: mocks.campaigns,
  fetchCampaignStatusReport: mocks.report,
  fetchOrganization: mocks.organization,
  fetchMembers: mocks.members,
  fetchInvitations: mocks.invitations,
}));

vi.mock('../../lib/billing-api', () => ({
  fetchBilling: mocks.billing,
}));

vi.mock('next/navigation', () => ({
  redirect: (url: string) => {
    throw new Error('redirect:' + url);
  },
}));

function campaignManagerMembership(): MembershipSummary {
  return {
    organizationId: 'org-a',
    organizationSlug: 'alpha',
    organizationName: 'Alpha',
    role: 'CAMPAIGN_MANAGER',
    permissions: [...ORGANIZATION_ROLE_PERMISSIONS.CAMPAIGN_MANAGER],
  };
}

function campaignManagerSession() {
  return {
    ok: true,
    me: {
      termsAccepted: true,
      userId: 'user-cm',
      memberships: [campaignManagerMembership()],
    },
  };
}

function organizationSearchParams(): { searchParams: Promise<{ organization: string }> } {
  return { searchParams: Promise.resolve({ organization: 'org-a' }) };
}

afterEach(() => {
  vi.clearAllMocks();
});

describe('RBAC-003 Campaign Manager navigation visibility', () => {
  it('shows only the items the policy grants', () => {
    const labels = organizationNavigationItems(campaignManagerMembership()).map(
      (item) => item.label,
    );

    expect(labels).toContain('Dashboard');
    expect(labels).toContain('Contacts');
    expect(labels).toContain('Contact Groups');
    expect(labels).toContain('Campaigns');
    expect(labels).toContain('Reports');
    expect(labels).toContain('Audio Library');
    expect(labels).toContain('Organization Settings');

    // CAMPAIGN_MANAGER is not granted member:read, invitation:read, billing:read
    // or wallet:read, so those surfaces must not be advertised.
    expect(labels).not.toContain('Team Members');
    expect(labels).not.toContain('Invitations');
    expect(labels).not.toContain('Billing');
  });
});

describe('RBAC-003 Campaign Manager page guards - allowed', () => {
  it('allows dashboard and hides member, invitation and billing surfaces', async () => {
    mocks.session.mockResolvedValue(campaignManagerSession());
    mocks.organization.mockResolvedValue({ id: 'org-a', name: 'Alpha' });
    mocks.campaigns.mockResolvedValue([]);

    const html = renderToStaticMarkup(await DashboardPage(organizationSearchParams()));

    expect(html).toContain('Alpha');
    expect(html).toContain('Your workspace');
    expect(html).toContain('No campaign records yet');
    // A role without member:read, invitation:read or billing:read is not shown
    // those areas at all, not even as an empty "no permission" card.
    expect(html).not.toContain('Team');
    expect(html).not.toContain('Pending invitations');
    expect(html).not.toContain('Billing');
    expect(mocks.members).not.toHaveBeenCalled();
    expect(mocks.invitations).not.toHaveBeenCalled();
    expect(mocks.billing).not.toHaveBeenCalled();
  });

  it('allows contacts', async () => {
    mocks.session.mockResolvedValue(campaignManagerSession());

    const html = renderToStaticMarkup(await ContactsPage(organizationSearchParams()));

    expect(html).toContain('Contacts');
    expect(html).not.toContain('You do not have access to contacts');
  });

  it('allows contact groups', async () => {
    mocks.session.mockResolvedValue(campaignManagerSession());

    const html = renderToStaticMarkup(await ContactGroupsPage(organizationSearchParams()));

    expect(html).toContain('Contact groups');
    expect(html).not.toContain('You do not have access to contact groups');
  });

  it('allows campaigns', async () => {
    mocks.session.mockResolvedValue(campaignManagerSession());
    mocks.campaigns.mockResolvedValue([]);

    const html = renderToStaticMarkup(await CampaignsPage(organizationSearchParams()));

    expect(html).toContain('Campaigns');
    expect(html).not.toContain('You do not have campaign access');
  });

  it('allows reports', async () => {
    mocks.session.mockResolvedValue(campaignManagerSession());
    mocks.report.mockResolvedValue({ total: 0, draft: 0, active: 0, completed: 0 });

    const html = renderToStaticMarkup(await ReportsPage(organizationSearchParams()));

    expect(html).toContain('Reports');
    expect(html).not.toContain('You do not have reporting access');
  });

  it('allows the read-only organization settings surface', async () => {
    mocks.session.mockResolvedValue(campaignManagerSession());
    mocks.organization.mockResolvedValue({ id: 'org-a', name: 'Alpha', slug: 'alpha' });

    const html = renderToStaticMarkup(await SettingsPage(organizationSearchParams()));

    expect(html).toContain('Organization settings');
    expect(html).toContain('Alpha');
    // organization:update is not granted, so the profile stays read-only.
    expect(html).toContain('does not include changing its settings');
  });

  it('allows the audio library', async () => {
    mocks.session.mockResolvedValue(campaignManagerSession());

    const html = renderToStaticMarkup(await AudioPage(organizationSearchParams()));

    expect(html).toContain('Audio Library');
    expect(html).not.toContain('You do not have audio access');
  });
});

describe('RBAC-003 Campaign Manager page guards - denied', () => {
  it('denies team members', async () => {
    mocks.session.mockResolvedValue(campaignManagerSession());

    const html = renderToStaticMarkup(await TeamPage(organizationSearchParams()));

    expect(html).toContain('You do not have permission to view members of this organization.');
  });

  it('denies invitations', async () => {
    mocks.session.mockResolvedValue(campaignManagerSession());

    const html = renderToStaticMarkup(await InvitationsPage(organizationSearchParams()));

    expect(html).toContain('Your role cannot view invitations for this organization.');
  });

  it('denies billing', async () => {
    mocks.session.mockResolvedValue(campaignManagerSession());

    const html = renderToStaticMarkup(await BillingPage(organizationSearchParams()));

    expect(html).toContain('You do not have billing access in this organization.');
  });
});

describe('RBAC-003 Campaign Manager cross-tenant guard', () => {
  it('refuses an organization the caller is not a member of', async () => {
    mocks.session.mockResolvedValue(campaignManagerSession());

    const html = renderToStaticMarkup(
      await CampaignsPage({ searchParams: Promise.resolve({ organization: 'org-b' }) }),
    );

    // The page resolves the requested organization against /me memberships and
    // renders a refusal rather than reading another tenant's campaigns.
    expect(html).toContain('You do not have campaign access in this organization.');
    expect(mocks.campaigns).not.toHaveBeenCalled();
  });
});

describe('RBAC-003 Campaign Manager campaign surface', () => {
  it('renders the campaign workspace for a permitted role', async () => {
    mocks.session.mockResolvedValue(campaignManagerSession());
    mocks.campaigns.mockResolvedValue([]);

    const html = renderToStaticMarkup(await CampaignsPage(organizationSearchParams()));

    expect(html).toContain('Campaigns');
    expect(html).toContain('No campaigns yet');
  });
});
