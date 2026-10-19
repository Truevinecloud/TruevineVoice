import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import CampaignsPage from './page';
import ReportsPage from '../reports/page';
import DashboardPage from '../page';

const mocks = vi.hoisted(() => ({
  session: vi.fn(),
  campaigns: vi.fn(),
  report: vi.fn(),
  organization: vi.fn(),
  members: vi.fn(),
  invitations: vi.fn(),
}));
vi.mock('../../../lib/session', () => ({
  currentSession: mocks.session,
  hasPermission: (membership: { permissions: string[] } | undefined, permission: string) =>
    membership?.permissions.includes(permission) ?? false,
}));
vi.mock('../../../lib/org-api', () => ({
  fetchCampaigns: mocks.campaigns,
  fetchCampaignStatusReport: mocks.report,
  fetchOrganization: mocks.organization,
  fetchMembers: mocks.members,
  fetchInvitations: mocks.invitations,
}));
vi.mock('next/navigation', () => ({
  redirect: (url: string) => {
    throw new Error(`redirect:${url}`);
  },
}));

function session(
  permissions = ['organization:read', 'member:read', 'campaign:read', 'reporting:read'],
) {
  return {
    ok: true,
    me: {
      termsAccepted: true,
      memberships: [
        { organizationId: 'org-a', organizationName: 'Tenant A', role: 'VIEWER', permissions },
      ],
    },
  };
}

afterEach(() => vi.clearAllMocks());

describe('read-only Viewer campaign and report pages', () => {
  it('renders the authorized organization dashboard and rejects a foreign selection', async () => {
    mocks.session.mockResolvedValue(session());
    mocks.organization.mockResolvedValue({ id: 'org-a', name: 'Tenant A' });
    mocks.members.mockResolvedValue([{ userId: 'u1' }, { userId: 'u2' }]);
    mocks.invitations.mockResolvedValue(null);

    const dashboard = renderToStaticMarkup(
      await DashboardPage({
        searchParams: Promise.resolve({ organization: 'org-a' }),
      }),
    );
    expect(dashboard).toContain('Tenant A');
    expect(dashboard).toContain('2 members');
    expect(mocks.organization).toHaveBeenCalledWith('org-a');
    expect(mocks.members).toHaveBeenCalledWith('org-a');

    mocks.organization.mockClear();
    const foreign = renderToStaticMarkup(
      await DashboardPage({
        searchParams: Promise.resolve({ organization: 'org-b' }),
      }),
    );
    expect(foreign).toContain('do not have access to the selected organization');
    expect(mocks.organization).not.toHaveBeenCalled();
  });

  it('renders campaign status and dates without controls', async () => {
    mocks.session.mockResolvedValue(session());
    mocks.campaigns.mockResolvedValue([
      {
        id: 'c1',
        name: 'Autumn calls',
        status: 'COMPLETED',
        createdAt: '2026-10-01T00:00:00.000Z',
        updatedAt: '2026-10-02T00:00:00.000Z',
      },
    ]);

    const markup = renderToStaticMarkup(
      await CampaignsPage({
        searchParams: Promise.resolve({ organization: 'org-a' }),
      }),
    );

    expect(markup).toContain('Autumn calls');
    expect(markup).toContain('COMPLETED');
    expect(markup).toContain('Campaign execution and call outcome data are not available yet');
    expect(markup).not.toMatch(/<form|<button|Launch|Edit|Delete/);
    expect(mocks.campaigns).toHaveBeenCalledWith('org-a');
  });

  it('renders only the campaign status report returned for the authorized tenant', async () => {
    mocks.session.mockResolvedValue(session());
    mocks.report.mockResolvedValue({ total: 5, draft: 2, active: 1, completed: 2 });

    const markup = renderToStaticMarkup(
      await ReportsPage({
        searchParams: Promise.resolve({ organization: 'org-a' }),
      }),
    );

    expect(markup).toContain('Campaign inventory summary');
    expect(markup).toContain('<dd>5</dd>');
    expect(markup).toContain(
      'Call attempts, delivery outcomes, and performance metrics are not available yet',
    );
    expect(markup).not.toMatch(/<form|<button|Launch|Edit|Delete/);
    expect(mocks.report).toHaveBeenCalledWith('org-a');
  });

  it('refuses missing permissions and foreign organization ids before fetching data', async () => {
    mocks.session.mockResolvedValue(session(['organization:read', 'campaign:read']));
    const deniedReport = renderToStaticMarkup(
      await ReportsPage({
        searchParams: Promise.resolve({ organization: 'org-a' }),
      }),
    );
    expect(deniedReport).toContain('do not have reporting access');

    mocks.session.mockResolvedValue(session());
    const foreign = renderToStaticMarkup(
      await CampaignsPage({
        searchParams: Promise.resolve({ organization: 'org-b' }),
      }),
    );
    expect(foreign).toContain('do not have campaign access');
    expect(mocks.campaigns).not.toHaveBeenCalled();
    expect(mocks.report).not.toHaveBeenCalled();
  });

  it('requires sign-in and accepted terms', async () => {
    mocks.session.mockResolvedValue({ ok: false });
    await expect(CampaignsPage({ searchParams: Promise.resolve({}) })).rejects.toThrow(
      'redirect:/sign-in',
    );
    mocks.session.mockResolvedValue({
      ...session(),
      me: { ...session().me, termsAccepted: false },
    });
    await expect(ReportsPage({ searchParams: Promise.resolve({}) })).rejects.toThrow(
      'redirect:/accept-terms',
    );
  });
});
