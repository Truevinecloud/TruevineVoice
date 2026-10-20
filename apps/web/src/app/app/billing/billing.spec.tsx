import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { formatUgx } from '../../../lib/billing';
import { BillingView } from './BillingView';
import BillingPage from './page';

const mocks = vi.hoisted(() => ({ session: vi.fn(), billing: vi.fn(), refresh: vi.fn() }));
vi.mock('../../../lib/session', () => ({
  currentSession: mocks.session,
  hasPermission: (m: { permissions: string[] } | undefined, p: string) =>
    m?.permissions.includes(p) ?? false,
}));
vi.mock('../../../lib/billing-api', () => ({ fetchBilling: mocks.billing }));
vi.mock('next/navigation', () => ({
  redirect: (url: string) => {
    throw new Error(`redirect:${url}`);
  },
  useRouter: () => ({ refresh: mocks.refresh }),
}));
const data = {
  wallet: { currency: 'UGX' as const, amountMinor: '9007199254740993' },
  billing: {
    profile: null,
    topUps: [
      {
        id: 'request',
        currency: 'UGX' as const,
        amountMinor: '5000',
        createdAt: '2026-10-19',
        status: 'PENDING' as const,
      },
    ],
    collectionAvailable: false as const,
  },
  transactions: {
    entries: [
      {
        id: 'entry',
        currency: 'UGX' as const,
        amountMinor: '10000',
        createdAt: '2026-10-19',
        description: 'Confirmed payment',
      },
    ],
    nextCursor: null,
  },
};
function session(permissions = ['wallet:read', 'billing:read', 'billing:update']) {
  return {
    ok: true,
    me: {
      termsAccepted: true,
      memberships: [
        { organizationId: 'a', organizationName: 'Tenant A', role: 'BILLING', permissions },
      ],
    },
  };
}
afterEach(() => vi.clearAllMocks());
describe('billing-only customer screen', () => {
  it('renders exact amounts, transaction history, profile and pending top-up without campaign controls', async () => {
    mocks.session.mockResolvedValue(session());
    mocks.billing.mockResolvedValue(data);
    const markup = renderToStaticMarkup(
      await BillingPage({ searchParams: Promise.resolve({ organization: 'a' }) }),
    );
    expect(markup).toContain('UGX 9,007,199,254,740,993');
    for (const label of [
      'Transaction history',
      'Confirmed payment',
      'Billing details',
      'Request top-up',
      'Pending',
      'does not add wallet funds',
    ])
      expect(markup).toContain(label);
    expect(markup).not.toMatch(/Launch campaign|Edit contacts|href="[^"]*campaign/);
    expect(mocks.billing).toHaveBeenCalledWith('a', undefined);
  });
  it('refuses unauthorized or foreign tenant selection before reading billing data', async () => {
    mocks.session.mockResolvedValue(session());
    expect(
      renderToStaticMarkup(
        await BillingPage({ searchParams: Promise.resolve({ organization: 'b' }) }),
      ),
    ).toContain('do not have billing access');
    mocks.session.mockResolvedValue(session(['organization:read']));
    expect(
      renderToStaticMarkup(await BillingPage({ searchParams: Promise.resolve({}) })),
    ).toContain('do not have billing access');
    expect(mocks.billing).not.toHaveBeenCalled();
  });
  it('requires sign-in and terms', async () => {
    mocks.session.mockResolvedValue({ ok: false });
    await expect(BillingPage({ searchParams: Promise.resolve({}) })).rejects.toThrow(
      'redirect:/sign-in',
    );
    mocks.session.mockResolvedValue({
      ...session(),
      me: { ...session().me, termsAccepted: false },
    });
    await expect(BillingPage({ searchParams: Promise.resolve({}) })).rejects.toThrow(
      'redirect:/accept-terms',
    );
  });
  it('never renders failed reads as a zero wallet or empty successful history', async () => {
    mocks.session.mockResolvedValue(session());
    mocks.billing.mockRejectedValue(new Error('offline'));
    const markup = renderToStaticMarkup(await BillingPage({ searchParams: Promise.resolve({}) }));
    expect(markup).toContain('could not be loaded');
    expect(markup).not.toContain('UGX 0');
  });
  it('omits mutation controls without billing:update and provides scoped history pagination', () => {
    const markup = renderToStaticMarkup(
      <BillingView
        organizationId="a"
        canUpdate={false}
        {...data}
        transactions={{ entries: [], nextCursor: 'cursor' }}
      />,
    );
    expect(markup).not.toContain('<form');
    expect(markup).toContain('organization=a&amp;cursor=cursor');
  });
  it('formats zero, signed corrections and large integer amounts exactly', () => {
    expect(formatUgx('0')).toBe('UGX 0');
    expect(formatUgx('-1234')).toBe('UGX -1,234');
    expect(formatUgx('9007199254740993')).toBe('UGX 9,007,199,254,740,993');
  });
});
