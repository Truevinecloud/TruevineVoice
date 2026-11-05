import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn() }),
}));

import OperationsDashboard, { filterCampaigns, filterOrganizations } from './operations-dashboard';

const organizations = [
  { id: 'org-1', name: 'Acme', slug: 'acme', status: 'ACTIVE' as const, campaignCount: 2 },
  { id: 'org-2', name: 'Bravo', slug: 'bravo', status: 'SUSPENDED' as const, campaignCount: 0 },
];

const campaigns = [
  {
    organizationId: 'org-1',
    organizationName: 'Acme',
    organizationSlug: 'acme',
    id: 'cmp-1',
    name: 'Launch',
    status: 'ACTIVE' as const,
    emergencyStoppedAt: null,
  },
  {
    organizationId: 'org-2',
    organizationName: 'Bravo',
    organizationSlug: 'bravo',
    id: 'cmp-2',
    name: 'Paused',
    status: 'PAUSED' as const,
    emergencyStoppedAt: '2026-01-01T00:00:00.000Z',
  },
];

describe('OperationsDashboard', () => {
  it('renders the operations workspace shell', () => {
    const markup = renderToStaticMarkup(<OperationsDashboard />);
    expect(markup).toContain('PLATFORM OPERATIONS');
    expect(markup).toContain('Operations');
  });

  it('renders an unauthenticated sign-in state', () => {
    const markup = renderToStaticMarkup(<OperationsDashboard />);
    expect(markup).toContain('Platform sign in');
  });
});

describe('operation filters', () => {
  it('filters organizations by search and status', () => {
    expect(filterOrganizations(organizations, 'ac', 'ALL')).toHaveLength(1);
    expect(filterOrganizations(organizations, '', 'SUSPENDED')).toHaveLength(1);
    expect(filterOrganizations(organizations, 'zzz', 'ALL')).toHaveLength(0);
  });

  it('filters campaigns by organization, name, and status', () => {
    expect(filterCampaigns(campaigns, 'bravo', 'ALL')).toHaveLength(1);
    expect(filterCampaigns(campaigns, '', 'ACTIVE')).toHaveLength(1);
    expect(filterCampaigns(campaigns, 'missing', 'ALL')).toHaveLength(0);
  });
});
