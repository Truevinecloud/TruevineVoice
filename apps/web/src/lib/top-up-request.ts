'use client';
import { ApiError, request } from './api';
import type { TopUp } from './billing';

/** Persist the request identity before sending; a timeout must not create a new operation. */
export async function submitTopUpRequest(
  organizationId: string,
  amount: string,
  storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>,
  send = (path: string, body: unknown) => request<TopUp>(path, { method: 'POST', body }),
): Promise<TopUp> {
  if (!/^[1-9][0-9]{0,18}$/.test(amount) || BigInt(amount) > 9223372036854775807n)
    throw new ApiError(
      400,
      'invalid_amount',
      'Enter a positive whole UGX amount within the supported limit.',
    );
  const storageKey = `tv:top-up:${organizationId}`;
  const saved = storage.getItem(storageKey);
  const pending = saved
    ? (JSON.parse(saved) as { amount: string; key: string })
    : { amount, key: crypto.randomUUID() };
  if (pending.amount !== amount)
    throw new ApiError(
      409,
      'pending_retry',
      'Retry the previous amount before submitting a different request.',
    );
  storage.setItem(storageKey, JSON.stringify(pending));
  const result = await send(`/organizations/${encodeURIComponent(organizationId)}/wallet/top-ups`, {
    amountMinor: amount,
    currency: 'UGX',
    idempotencyKey: pending.key,
  });
  storage.removeItem(storageKey);
  return result;
}
