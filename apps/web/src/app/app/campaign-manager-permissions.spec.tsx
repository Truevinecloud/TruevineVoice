// @vitest-environment happy-dom
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { OrganizationRole } from '@truevine/auth';
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
import type { MembershipSummary } from '../../../lib/session';

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
    throw new Error(edirect:);
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
          role: 'CAMPAIGN_MANAGER' as OrganizationRole,
          permissions: [...ORGANIZATION_ROLE_PERMISSIONS.CAMPAIGN_MANAGER],
        },
      ],
    },
  };
}

afterEach(() => vi.clearAllMocks());

describe('RBAC-003 Campaign Manager navigation visibility', () => {
  it('shows only permitted items in nav', () => {
    const session = campaignManagerSession();
    const membership = session.me.memberships[0] as MembershipSummary;
    const labels = organizationNavigationItems(membership).map((item) => item.label);
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
  });
});

describe('RBAC-003 Campaign Manager page guards - allowed', () => {
  it('allows dashboard', async () => {
    mocks.session.mockResolvedValue(campaignManagerSession());
    mocks.organization.mockResolvedValue({ id: 'org-a', name: 'Alpha' });
    mocks.members.mockResolvedValue([]);
    mocks.invitations.mockResolvedValue([]);
    const html = renderToStaticMarkup(
      await (DashboardPage as (props: { searchParams: Promise<{ organization: string }> }) => Promise<unknown>)({
        searchParams: Promise.resolve({ organization: 'org-a' }),
      }),
    );
    expect(html).toContain('Alpha');
  });

  it('allows contacts', async () => {
    mocks.session.mockResolvedValue(campaignManagerSession());
    const html = renderToStaticMarkup(
      await (ContactsPage as (props: { searchParams: Promise<{ organization: string }> }) => Promise<unknown>)({
        searchParams: Promise.resolve({ organization: 'org-a' }),
      }),
    );
    expect(html).not.toContain('do not have access');
    expect(html).toContain('Contacts');
  });

  it('allows contact groups', async () => {
    mocks.session.mockResolvedValue(campaignManagerSession());
    const html = renderToStaticMarkup(
      await (ContactGroupsPage as (props: { searchParams: Promise<{ organization: string }> }) => Promise<unknown>)({
        searchParams: Promise.resolve({ organization: 'org-a' }),
      }),
    );
    expect(html).not.toContain('do not have access');
    expect(html).toContain('Contact groups');
  });

  it('allows campaigns', async () => {
    mocks.session.mockResolvedValue(campaignManagerSession());
    mocks.campaigns.mockResolvedValue([]);
    const html = renderToStaticMarkup(
      await (CampaignsPage as (props: { searchParams: Promise<{ organization: string }> }) => Promise<unknown>)({
        searchParams: Promise.resolve({ organization: 'org-a' }),
      }),
    );
    expect(html).not.toContain('do not have access');
    expect(html).toContain('Campaigns');
  });

  it('allows reports', async () => {
    mocks.session.mockResolvedValue(campaignManagerSession());
    mocks.report.mockResolvedValue({ totalCalls: 0, totalDurationSeconds: 0, statusBreakdown: [] });
    const html = renderToStaticMarkup(
      await (ReportsPage as (props: { searchParams: Promise<{ organization: string }> }) => Promise<unknown>)({
        searchParams: Promise.resolve({ organization: 'org-a' }),
      }),
    );
    expect(html).not.toContain('do not have access');
    expect(html).toContain('Reports');
  });

  it('allows organization settings read-only surface', async () => {
    mocks.session.mockResolvedValue(campaignManagerSession());
    mocks.organization.mockResolvedValue({ id: 'org-a', name: 'Alpha', slug: 'alpha' });
    const html = renderToStaticMarkup(
      await (SettingsPage as (props: { searchParams: Promise<{ organization: string }> }) => Promise<unknown>)({
        searchParams: Promise.resolve({ organization: 'org-a' }),
      }),
    );
    expect(html).not.toContain('do not have access');
  });
});

describe('RBAC-003 Campaign Manager page guards - denied', () => {
  it('denies team members', async () => {
    mocks.session.mockResolvedValue(campaignManagerSession());
    const html = renderToStaticMarkup(
      await (TeamPage as (props: { searchParams: Promise<{ organization: string }> }) => Promise<unknown>)({
        searchParams: Promise.resolve({ organization: 'org-a' }),
      }),
    );
    expect(html).toContain('do not have access');
  });

  it('denies invitations', async () => {
    mocks.session.mockResolvedValue(campaignManagerSession());
    const html = renderToStaticMarkup(
      await (InvitationsPage as (props: { searchParams: Promise<{ organization: string }> }) => Promise<unknown>)({
        searchParams: Promise.resolve({ organization: 'org-a' }),
      }),
    );
    expect(html).toContain('do not have access');
  });

  it('denies billing', async () => {
    mocks.session.mockResolvedValue(campaignManagerSession());
    const html = renderToStaticMarkup(
      await (BillingPage as (props: { searchParams: Promise<{ organization: string }> }) => Promise<unknown>)({
        searchParams: Promise.resolve({ organization: 'org-a' }),
      }),
    );
    expect(html).toContain('do not have access');
  });

  it('denies audio library', async () => {
    mocks.session.mockResolvedValue(campaignManagerSession());
    const html = renderToStaticMarkup(
      await (AudioPage as (props: { searchParams: Promise<{ organization: string }> }) => Promise<unknown>)({
        searchParams: Promise.resolve({ organization: 'org-a' }),
      }),
    );
    expect(html).toContain('do not have access');
  });

  it('denies ownership transfer actions context', async () => {
    mocks.session.mockResolvedValue(campaignManagerSession());
    const html = renderToStaticMarkup(
      await (SettingsPage as (props: { searchParams: Promise<{ organization: string }> }) => Promise<unknown>)({
        searchParams: Promise.resolve({ organization: 'org-a' }),
      }),
    );
    expect(html).not.toContain('Transfer ownership');
  });
});

describe('RBAC-003 Campaign Manager cross-tenant guard', () => {
  it('redirects or denies cross-tenant access', async () => {
    mocks.session.mockResolvedValue(campaignManagerSession());
    try {
      await (CampaignsPage as (props: { searchParams: Promise<{ organization: string }> }) => Promise<unknown>)({
        searchParams: Promise.resolve({ organization: 'org-b' }),
      });
      expect.fail('expected redirect or access denial');
    } catch (error) {
      expect((error as Error).message).toMatch(/redirect:|do not have access/);
    }
  });
});

describe('RBAC-003 Campaign Manager campaign UI', () => {
  it('renders campaign surface without policy violations', async () => {
    mocks.session.mockResolvedValue(campaignManagerSession());
    mocks.campaigns.mockResolvedValue([]);
    const html = renderToStaticMarkup(
      await (CampaignsPage as (props: { searchParams: Promise<{ organization: string }> }) => Promise<unknown>)({
        searchParams: Promise.resolve({ organization: 'org-a' }),
      }),
    );
    expect(html).toContain('Campaign');
  });
});
