import { cookies } from 'next/headers';
import { apiRequest } from './api-target';
import type { Billing, Transactions, Wallet } from './billing';

/** Session-forwarded, uncached reads; failed reads must never look like an empty wallet. */
async function read<T>(path: string): Promise<T> {
  const token = (await cookies()).get('tv_session')?.value;
  if (!token) throw new Error('Sign in to view billing.');
  const response = await fetch(apiRequest(path), {
    headers: { cookie: `tv_session=${token}` },
    cache: 'no-store',
  });
  if (!response.ok) throw new Error('Billing information could not be loaded.');
  return response.json() as Promise<T>;
}
export async function fetchBilling(organizationId: string, cursor?: string) {
  const root = `/organizations/${encodeURIComponent(organizationId)}`;
  const [wallet, billing, transactions] = await Promise.all([
    read<Wallet>(`${root}/wallet`),
    read<Billing>(`${root}/billing`),
    read<Transactions>(
      `${root}/wallet/transactions${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`,
    ),
  ]);
  return { wallet, billing, transactions };
}
