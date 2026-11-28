import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import Settings from './settings/page';
import Team from './team/page';
import Invite from './team/invite/page';
import Invitations from './invitations/page';
import Dashboard from './page';
import Contacts from './contacts/page';
import Groups from './contact-groups/page';
import Audio from './audio/page';
import Campaigns from './campaigns/page';
import Reports from './reports/page';
import Billing from './billing/page';
import { ORGANIZATION_ROLE_PERMISSIONS } from '@truevine/auth';
const mocks = vi.hoisted(() => ({ session: vi.fn(), read: vi.fn() }));
vi.mock('../../lib/session', async (original) => ({
  ...(await original<typeof import('../../lib/session')>()),
  currentSession: mocks.session,
}));
vi.mock('../../lib/org-api', () => ({
  fetchOrganization: mocks.read,
  fetchMembers: mocks.read,
  fetchInvitations: mocks.read,
  fetchCampaigns: mocks.read,
  fetchCampaignStatusReport: mocks.read,
}));
vi.mock('../../lib/billing-api', () => ({ fetchBilling: mocks.read }));
vi.mock('next/navigation', () => ({
  redirect: (path: string) => {
    throw new Error(`redirect:${path}`);
  },
}));
afterEach(() => vi.clearAllMocks());
describe('tenant pages reject forged organization selections before any data fetch', () => {
  for (const [label, page] of Object.entries({
    Settings,
    Team,
    Invite,
    Invitations,
    Dashboard,
    Contacts,
    Groups,
    Audio,
    Campaigns,
    Reports,
    Billing,
  })) {
    it.each(['foreign-tenant', '', ['org-a', 'foreign-tenant']])(
      `${label} rejects %s without falling back to A`,
      async (organization) => {
        mocks.session.mockResolvedValue({
          ok: true,
          me: {
            userId: 'user-a',
            termsAccepted: true,
            memberships: [
              {
                organizationId: 'org-a',
                organizationName: 'Private Alpha',
                role: 'OWNER',
                permissions: ORGANIZATION_ROLE_PERMISSIONS.OWNER,
              },
            ],
          },
        });
        const html = renderToStaticMarkup(
          await page({ searchParams: Promise.resolve({ organization }) }),
        );
        expect(html).not.toContain('Private Alpha');
        expect(html).not.toContain('foreign-tenant');
        expect(html).toMatch(/access|permission|workspace/i);
        expect(mocks.read).not.toHaveBeenCalled();
      },
    );
  }
});
