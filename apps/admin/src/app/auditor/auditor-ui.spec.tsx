import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import {
  AuditorAccessNotice,
  AuditorAuditTable,
  AuditorHeader,
  AuditorNav,
  OrganizationsTable,
  OverviewPanels,
  type OverviewView,
} from './auditor-ui';

const overview: OverviewView = {
  organizations: { total: 3 },
  platformRoles: [
    { role: 'AUDITOR', count: 2 },
    { role: 'PLATFORM_OWNER', count: 1 },
  ],
  scope: {
    readable: [
      'platform:tenant:read',
      'platform:operations:read',
      'platform:support:read',
      'platform:audit:read',
    ],
    writable: [],
  },
};

describe('AuditorHeader', () => {
  it('renders the title inside the auditor workspace', () => {
    const markup = renderToStaticMarkup(<AuditorHeader title="Audit overview" />);
    expect(markup).toContain('PLATFORM AUDIT');
    expect(markup).toContain('Audit overview');
  });
});

describe('AuditorNav', () => {
  it('marks the active section', () => {
    const markup = renderToStaticMarkup(<AuditorNav current="organizations" />);
    expect(markup).toContain('aria-current="page"');
    expect(markup).toContain('/auditor/organizations');
  });
});

describe('AuditorAccessNotice', () => {
  it('renders nothing when access is established', () => {
    expect(renderToStaticMarkup(<AuditorAccessNotice status={null} />)).toBe('');
  });

  it('explains a 403 without leaking internal detail', () => {
    const markup = renderToStaticMarkup(<AuditorAccessNotice status={403} />);
    expect(markup).toContain('does not have Auditor access');
  });

  it('points unauthenticated operators at sign-in', () => {
    const markup = renderToStaticMarkup(<AuditorAccessNotice status={401} />);
    expect(markup).toContain('Sign in');
  });
});

describe('OverviewPanels', () => {
  it('renders platform totals and role counts', () => {
    const markup = renderToStaticMarkup(<OverviewPanels overview={overview} />);
    expect(markup).toContain('Organizations');
    expect(markup).toContain('AUDITOR');
    expect(markup).toContain('PLATFORM_OWNER');
  });

  it('states that the role writes nothing', () => {
    const markup = renderToStaticMarkup(<OverviewPanels overview={overview} />);
    expect(markup).toContain('Read-only');
    expect(markup).toContain('Writable permissions: none');
  });

  it('reports an empty role population explicitly', () => {
    const markup = renderToStaticMarkup(
      <OverviewPanels overview={{ ...overview, platformRoles: [] }} />,
    );
    expect(markup).toContain('No platform roles are currently assigned');
  });
});

describe('OrganizationsTable', () => {
  it('renders identity and status metadata', () => {
    const markup = renderToStaticMarkup(
      <OrganizationsTable
        organizations={[
          {
            id: 'org-1',
            name: 'Acme',
            slug: 'acme',
            status: 'ACTIVE',
            createdAt: '2026-10-20T00:00:00.000Z',
            memberCount: 3,
          },
        ]}
      />,
    );
    expect(markup).toContain('Acme');
    expect(markup).toContain('acme');
    expect(markup).toContain('ACTIVE');
    expect(markup).toContain('3');
  });

  it('reports an empty page explicitly', () => {
    expect(renderToStaticMarkup(<OrganizationsTable organizations={[]} />)).toContain(
      'No organizations on this page',
    );
  });
});

describe('AuditorAuditTable', () => {
  it('renders the trail tag, actor identity, outcome and projected detail', () => {
    const markup = renderToStaticMarkup(
      <AuditorAuditTable
        events={[
          {
            id: 'evt-1',
            trail: 'identity',
            action: 'platform.audit.overview_viewed',
            outcome: 'SUCCESS',
            scope: null,
            targetType: null,
            targetId: null,
            occurredAt: '2026-10-20T00:00:00.000Z',
            actor: { userId: 'actor-1', email: 'auditor@example.com' },
            metadata: { outcome: 'SUCCESS' },
          },
        ]}
      />,
    );
    expect(markup).toContain('platform.audit.overview_viewed');
    expect(markup).toContain('auditor@example.com');
    expect(markup).toContain('identity trail');
    expect(markup).toContain('SUCCESS');
  });

  it('reports an empty trail explicitly', () => {
    expect(renderToStaticMarkup(<AuditorAuditTable events={[]} />)).toContain(
      'No platform audit events',
    );
  });
});
