import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ORGANIZATION_ROLE_PERMISSIONS, type OrganizationRole } from '@truevine/auth';
import TeamPage from './page';
import InvitePage from './invite/page';

const mocks = vi.hoisted(() => ({ session: vi.fn(), members: vi.fn() }));
vi.mock('../../../lib/session', async (original) => ({
  ...(await original<typeof import('../../../lib/session')>()),
  currentSession: mocks.session,
}));
vi.mock('../../../lib/org-api', () => ({ fetchMembers: mocks.members }));
vi.mock('next/navigation', () => ({
  redirect: (url: string) => {
    throw new Error(`redirect:${url}`);
  },
}));
vi.mock('./actions', () => ({
  RemoveMemberButton: () => <button>Remove</button>,
  TransferOwnershipButton: () => <button>Make owner</button>,
}));
vi.mock('./invite/InviteForm', () => ({
  InviteForm: ({ roles }: { roles: readonly string[] }) => (
    <select>
      {roles.map((role) => (
        <option key={role}>{role}</option>
      ))}
    </select>
  ),
}));

function signIn(role: OrganizationRole) {
  mocks.session.mockResolvedValue({
    ok: true,
    me: {
      userId: 'actor',
      memberships: [
        {
          organizationId: 'synthetic-org',
          organizationName: 'Synthetic organization',
          role,
          permissions: ORGANIZATION_ROLE_PERMISSIONS[role],
        },
      ],
    },
  });
}

afterEach(() => vi.clearAllMocks());

describe('Team Members protected actions', () => {
  it.each([
    ['OWNER', false],
    ['ADMIN', false],
    ['BILLING', false],
    ['VIEWER', true],
    ['CAMPAIGN_MANAGER', true],
    ['UNKNOWN', false],
  ] as const)('Admin removal of %s is visible: %s', async (targetRole, allowed) => {
    signIn('ADMIN');
    mocks.members.mockResolvedValue([
      {
        userId: 'target',
        email: 'target@example.invalid',
        role: targetRole,
        joinedAt: '2026-10-01',
      },
    ]);
    const html = renderToStaticMarkup(await TeamPage({ searchParams: Promise.resolve({}) }));
    expect(html.includes('<button>Remove</button>')).toBe(allowed);
    expect(html).not.toContain('Make owner');
  });

  it('does not offer self-removal or self ownership transfer', async () => {
    signIn('ADMIN');
    mocks.members.mockResolvedValue([
      {
        userId: 'actor',
        email: 'self@example.invalid',
        role: 'ADMIN',
        joinedAt: '2026-10-01',
      },
    ]);
    const html = renderToStaticMarkup(await TeamPage({ searchParams: Promise.resolve({}) }));
    expect(html).not.toContain('<button>');
  });

  it.each(['VIEWER', 'BILLING', 'CAMPAIGN_MANAGER'] as const)(
    '%s cannot remove members or transfer ownership',
    async (role) => {
      signIn(role);
      mocks.members.mockResolvedValue([
        {
          userId: 'target',
          email: 'target@example.invalid',
          role: 'VIEWER',
          joinedAt: '2026-10-01',
        },
      ]);
      const html = renderToStaticMarkup(await TeamPage({ searchParams: Promise.resolve({}) }));
      expect(html).not.toContain('<button>');
    },
  );

  it('preserves Owner controls over an Admin', async () => {
    signIn('OWNER');
    mocks.members.mockResolvedValue([
      {
        userId: 'target',
        email: 'target@example.invalid',
        role: 'ADMIN',
        joinedAt: '2026-10-01',
      },
    ]);
    const html = renderToStaticMarkup(await TeamPage({ searchParams: Promise.resolve({}) }));
    expect(html).toContain('<button>Remove</button>');
    expect(html).toContain('<button>Make owner</button>');
  });

  it('offers Admin invitations only for Campaign Manager and Viewer', async () => {
    signIn('ADMIN');
    const html = renderToStaticMarkup(await InvitePage({ searchParams: Promise.resolve({}) }));
    expect(html.match(/<option[^>]*>[^<]+<\/option>/g)).toEqual([
      '<option>CAMPAIGN_MANAGER</option>',
      '<option>VIEWER</option>',
    ]);
  });
});
