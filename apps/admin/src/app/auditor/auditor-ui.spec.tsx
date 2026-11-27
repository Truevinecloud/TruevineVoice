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
            targetType: 'organization',
            targetId: 'org-1',
            organizationId: 'org-1',
            occurredAt: '2026-10-20T00:00:00.000Z',
            actor: { userId: 'actor-1', email: 'auditor@example.com' },
            metadata: { outcome: 'SUCCESS', reasonCode: 'security_incident' },
          },
        ]}
      />,
    );
    expect(markup).toContain('platform.audit.overview_viewed');
    expect(markup).toContain('auditor@example.com');
    expect(markup).toContain('identity trail');
    expect(markup).toContain('SUCCESS');
    expect(markup).toContain('2026-10-20 00:00:00 UTC');
    expect(markup).toContain('dateTime="2026-10-20T00:00:00.000Z"');
    expect(markup).toContain('View event details');
    expect(markup).toContain('role="region"');
    expect(markup).toContain('aria-label="Platform event history"');
    expect(markup).toContain('tabindex="0"');
    expect(markup).toContain('<caption>Platform event history. All times are UTC.');
    expect(markup.match(/scope="col"/g)).toHaveLength(8);
    for (const heading of ['Timestamp', 'Actor', 'Action', 'Target', 'Organization', 'Reason', 'Outcome']) {
      expect(markup).toContain(`<th scope="col">${heading}</th>`);
    }
    expect(markup).toContain('<td>org-1</td>');
    expect(markup).toContain('<td>security_incident</td>');
    expect(markup).toContain('organization · org-1');
    expect(markup).not.toContain('<button');
  });

  it('reports an empty trail explicitly', () => {
    expect(renderToStaticMarkup(<AuditorAuditTable events={[]} />)).toContain(
      'No platform audit events',
    );
  });

  it('labels missing historical fields and ignores structured metadata values', () => {
    const markup = renderToStaticMarkup(<AuditorAuditTable events={[{
      id: 'old-event', trail: 'identity', action: 'platform.admin.role_granted',
      outcome: 'SUCCESS', scope: null, targetType: null, targetId: null,
      occurredAt: '2026-10-20T00:00:00.000Z', actor: { userId: 'actor', email: 'operator@example.invalid' },
      metadata: { organizationId: { unexpected: true }, reasonCode: ['invalid'] },
    }]} />);
    expect(markup.match(/<td>Not recorded<\/td>/g)).toHaveLength(2);
    expect(markup).toContain('<td>Not recorded<small></small></td>');
    expect(markup).not.toContain('[object Object]');
  });

  it('uses previously projected legacy organization, target and reason text', () => {
    const markup = renderToStaticMarkup(<AuditorAuditTable events={[{
      id: 'legacy-event', trail: 'identity', action: 'platform.admin.role_granted',
      outcome: 'SUCCESS', scope: null, targetType: null, targetId: null,
      occurredAt: '2026-10-20T00:00:00.000Z', actor: { userId: 'actor', email: 'operator@example.invalid' },
      metadata: { organizationId: 'legacy-org', targetUserId: 'target-user', reason: 'Security review' },
    }]} />);
    expect(markup).toContain('<td>legacy-org</td>');
    expect(markup).toContain('<td>user<small>target-user</small></td>');
    expect(markup).toContain('<td>Security review</td>');
  });
});
