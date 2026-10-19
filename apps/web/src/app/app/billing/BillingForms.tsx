'use client';
import { useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { messageFor, request } from '../../../lib/api';
import type { BillingProfile } from '../../../lib/billing';
import { submitTopUpRequest } from '../../../lib/top-up-request';

export function TopUpForm({ organizationId }: { readonly organizationId: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    const form = event.currentTarget;
    const amount = String(new FormData(form).get('amount') ?? '').trim();
    setBusy(true);
    setMessage('');
    try {
      const result = await submitTopUpRequest(organizationId, amount, sessionStorage);
      setMessage(
        `Request ${result.id} is pending. No payment was collected and your wallet was not credited.`,
      );
      form.reset();
      router.refresh();
    } catch (error) {
      setMessage(messageFor(error));
    } finally {
      setBusy(false);
    }
  }
  return (
    <form onSubmit={submit}>
      <p>
        Payment collection is not available yet. This records a pending request only; it does not
        add wallet funds.
      </p>
      <label htmlFor="top-up-amount">Amount (UGX)</label>
      <input
        id="top-up-amount"
        name="amount"
        type="text"
        inputMode="numeric"
        pattern="[1-9][0-9]*"
        maxLength={19}
        required
        disabled={busy}
      />
      <button type="submit" disabled={busy}>
        {busy ? 'Saving request…' : 'Request top-up'}
      </button>
      {message && <p role="status">{message}</p>}
    </form>
  );
}

export function BillingProfileForm({
  organizationId,
  profile,
}: {
  readonly organizationId: string;
  readonly profile: BillingProfile | null;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    const data = new FormData(event.currentTarget);
    setBusy(true);
    setMessage('');
    try {
      await request(`/organizations/${organizationId}/billing`, {
        method: 'PATCH',
        body: { name: data.get('name'), email: data.get('email'), address: data.get('address') },
      });
      setMessage('Billing details saved.');
      router.refresh();
    } catch (error) {
      setMessage(messageFor(error));
    } finally {
      setBusy(false);
    }
  }
  return (
    <form onSubmit={submit}>
      <label htmlFor="billing-name">Billing name</label>
      <input
        id="billing-name"
        name="name"
        maxLength={200}
        required
        defaultValue={profile?.name ?? ''}
        disabled={busy}
      />
      <label htmlFor="billing-email">Billing email</label>
      <input
        id="billing-email"
        name="email"
        type="email"
        maxLength={254}
        required
        defaultValue={profile?.email ?? ''}
        disabled={busy}
      />
      <label htmlFor="billing-address">Billing address</label>
      <textarea
        id="billing-address"
        name="address"
        maxLength={500}
        required
        defaultValue={profile?.address ?? ''}
        disabled={busy}
      />
      <button type="submit" disabled={busy}>
        {busy ? 'Saving…' : 'Save billing details'}
      </button>
      {message && <p role="status">{message}</p>}
    </form>
  );
}
