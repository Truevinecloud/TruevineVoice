import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import {
  AccessNotice,
  AuditTable,
  DiagnosticsPanels,
  MembersTable,
  OrganizationsTable,
  SupportHeader,
  SupportNav,
  UsersTable,
  type DiagnosticsView,
} from './support-ui';

const diagnostics: DiagnosticsView = {
  organization: { id: 'org-1', name: 'Acme', slug: 'acme', status: 'ACTIVE' },
  memberCount: 3,
  auditEventCount: 12,
  billingProfilePresent: true,
  campaigns: {
    total: 2,
    byStatus: { ACTIVE: 1, PAUSED: 1 },
    emergencyStoppedCount: 1,
    recent: [
      {
        id: 'cmp-1',
        name: 'Launch',
        status: 'PAUSED',
        emergencyStoppedAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-02T00:00:00.000Z',
      },
    ],
  },
  walletBalances: [
    { currency: 'UGX', amountMinor: '3000', entryCount: 2, lastEntryAt: '2026-01-03T00:00:00.000Z' },
  ],
  topUpRequests: [
    {
      currency: 'UGX',
      requestCount: 1,
      totalRequestedMinor: '5000',
      lastRequestedAt: '2026-01-04T00:00:00.000Z',
    },
  ],
  notAvailable: ['voice_calls', 'messages'],
};

describe('SupportHeader', () => {
  it('renders the title inside the support workspace', () => {
    const markup = renderToStaticMarkup(<SupportHeader title="Support users" />);
    expect(markup).toContain('PLATFORM SUPPORT');
    expect(markup).toContain('Support users');
  });
});

describe('SupportNav', () => {
  it('marks the active section', () => {
    const markup = renderToStaticMarkup(<SupportNav current="users" />);
    expect(markup).toContain('aria-current="page"');
    expect(markup).toContain('/support/users');
  });
});

describe('AccessNotice', () => {
  it('renders nothing when access is established', () => {
    expect(renderToStaticMarkup(<AccessNotice status={null} />)).toBe('');
  });

  it('explains a 403 without leaking internal detail', () => {
    const markup = renderToStaticMarkup(<AccessNotice status={403} />);
    expect(markup).toContain('does not have Support Admin access');
  });

  it('points unauthenticated operators at sign-in', () => {
    const markup = renderToStaticMarkup(<AccessNotice status={401} />);
    expect(markup).toContain('Sign in');
  });
});

describe('OrganizationsTable', () => {
  it('links each row to its detail page', () => {
    const markup = renderToStaticMarkup(
      <OrganizationsTable
        organizations={[
          { id: 'org-1', name: 'Acme', slug: 'acme', status: 'SUSPENDED', memberCount: 2, campaignCount: 1 },
        ]}
      />,
    );
    expect(markup).toContain('/support/customers/org-1');
    expect(markup).toContain('SUSPENDED');
  });

  it('reports an empty result explicitly', () => {
    expect(renderToStaticMarkup(<OrganizationsTable organizations={[]} />)).toContain(
      'No organizations matched',
    );
  });
});

describe('UsersTable', () => {
  it('shows the platform role and membership count', () => {
    const markup = renderToStaticMarkup(
      <UsersTable
        users={[
          {
            id: 'user-1',
            email: 'ops@example.com',
            status: 'ACTIVE',
            createdAt: '2026-01-01T00:00:00.000Z',
            lockedUntil: null,
            platformRole: { role: 'SUPPORT_ADMIN', grantedAt: '2026-01-01T00:00:00.000Z' },
            membershipCount: 0,
          },
        ]}
      />,
    );
    expect(markup).toContain('ops@example.com');
    expect(markup).toContain('SUPPORT_ADMIN');
  });

  it('reports an empty result explicitly', () => {
    expect(renderToStaticMarkup(<UsersTable users={[]} />)).toContain('No users matched');
  });
});

describe('MembersTable', () => {
  it('links each member to the user page', () => {
    const markup = renderToStaticMarkup(
      <MembersTable
        members={[
          {
            userId: 'user-9',
            email: 'member@example.com',
            userStatus: 'ACTIVE',
            role: 'OWNER',
            joinedAt: '2026-01-01T00:00:00.000Z',
            lockedUntil: null,
          },
        ]}
      />,
    );
    expect(markup).toContain('/support/users/user-9');
  });
});

describe('DiagnosticsPanels', () => {
  it('renders ledger totals as exact minor-unit strings, never floats', () => {
    const markup = renderToStaticMarkup(<DiagnosticsPanels diagnostics={diagnostics} />);
    expect(markup).toContain('3000');
    expect(markup).toContain('5000');
    expect(markup).toContain('UGX');
  });

  it('names unmodelled domains instead of silently omitting them', () => {
    const markup = renderToStaticMarkup(<DiagnosticsPanels diagnostics={diagnostics} />);
    expect(markup).toContain('voice_calls');
    expect(markup).toContain('messages');
  });

  it('states an empty ledger rather than faking data', () => {
    const markup = renderToStaticMarkup(
      <DiagnosticsPanels
        diagnostics={{ ...diagnostics, walletBalances: [], topUpRequests: [], campaigns: { ...diagnostics.campaigns, recent: [] } }}
      />,
    );
    expect(markup).toContain('No wallet entries');
    expect(markup).toContain('No top-up requests');
  });
});

describe('AuditTable', () => {
  it('renders the actor identity and outcome', () => {
    const markup = renderToStaticMarkup(
      <AuditTable
        events={[
          {
            id: 'evt-1',
            action: 'platform.support.user_viewed',
            outcome: 'SUCCESS',
            scope: null,
            targetType: 'user',
            targetId: 'user-1',
            occurredAt: '2026-01-01T00:00:00.000Z',
            actor: { userId: 'actor-1', email: 'support@example.com' },
            metadata: {},
          },
        ]}
      />,
    );
    expect(markup).toContain('platform.support.user_viewed');
    expect(markup).toContain('support@example.com');
  });

  it('reports an empty trail explicitly', () => {
    expect(renderToStaticMarkup(<AuditTable events={[]} />)).toContain('No audit events');
  });
});
