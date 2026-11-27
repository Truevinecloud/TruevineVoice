'use client';

import { useState, type ChangeEvent, type FormEvent } from 'react';
import { request, messageFor } from '../../../lib/api';
import { Button, Input, SectionCard, StatusBadge } from '../AppUI';

export interface SimulationResult {
  readonly topUpRequestId: string;
  readonly paymentIntentId: string;
  readonly providerReference: string;
  readonly status: string;
}

export interface SettlementResult {
  readonly outcome: string;
  readonly eventId: string | null;
  readonly organizationId: string | null;
  readonly walletEntryId: string | null;
}

export function BillingSimulation({
  organizationId,
  operatorUserId,
}: {
  readonly organizationId: string;
  readonly operatorUserId?: string;
}) {
  const [amount, setAmount] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [simulationResult, setSimulationResult] = useState<SimulationResult | null>(null);
  const [settlementResult, setSettlementResult] = useState<SettlementResult | null>(null);

  const handleAmountChange = (event: ChangeEvent<HTMLInputElement>) => {
    setAmount(event.target.value);
  };

  async function requestSyntheticTopUp(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setMessage('');
    try {
      const result = await request<SimulationResult>('/_test/payments/synthetic/top-up', {
        method: 'POST',
        headers: {
          'x-w502-test-operator-user-id': operatorUserId ?? '',
        },
        body: {
          organizationId,
          amountMinor: amount,
          idempotencyKey: `sim-${Date.now()}`,
        },
      });
      setSimulationResult(result);
      setMessage(
        `Synthetic top-up ${result.topUpRequestId} created. Payment intent ${result.paymentIntentId} is pending settlement.`,
      );
    } catch (error) {
      setMessage(messageFor(error));
    } finally {
      setBusy(false);
    }
  }

  async function settleSynthetic(status: 'SUCCESS' | 'FAILED') {
    if (busy || !simulationResult) return;
    setBusy(true);
    setMessage('');
    try {
      const payload = {
        provider: 'SYNTHETIC_SANDBOX',
        environment: 'SANDBOX',
        eventId: `evt-${Date.now()}`,
        providerReference: simulationResult.providerReference,
        status,
        amountMinor: amount,
        currency: 'UGX',
        signature: 'placeholder',
      };
      const result = await request<SettlementResult>('/_test/payments/synthetic/settle', {
        method: 'POST',
        headers: {
          'x-w502-synthetic-verification-key': 'test-synthetic-key-0001',
        },
        body: payload,
      });
      setSettlementResult(result);
      setMessage(
        `Settlement ${result.outcome}. ${result.walletEntryId ? `Wallet entry ${result.walletEntryId} credited.` : 'No wallet credit.'}`,
      );
    } catch (error) {
      setMessage(messageFor(error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <SectionCard
      title="Local payment simulation — no real money"
      description="Synthetic top-up and settlement for local testing only. Not available in production."
      className="simulation-card"
    >
      <p role="note" className="simulation-hint">
        This section is for local development testing. It calls test-only endpoints and does not
        initiate real payments or collect real money.
      </p>

      <form onSubmit={requestSyntheticTopUp} className="simulation-form">
        <label htmlFor="sim-top-up-amount">Synthetic top-up amount (UGX)</label>
        <Input
          id="sim-top-up-amount"
          type="text"
          value={amount}
          onChange={handleAmountChange}
          placeholder="e.g. 10000"
          maxLength={19}
          required
          disabled={busy}
        />
        <button type="submit" disabled={busy}>
          {busy ? 'Requesting…' : 'Request synthetic top-up'}
        </button>
      </form>

      {message && <p role="status">{message}</p>}

      {simulationResult && (
        <div className="simulation-result">
          <h3>Payment intent</h3>
          <ul>
            <li>Top-up request: <code>{simulationResult.topUpRequestId}</code></li>
            <li>Payment intent: <code>{simulationResult.paymentIntentId}</code></li>
            <li>Provider reference: <code>{simulationResult.providerReference}</code></li>
            <li>Status: <StatusBadge tone="warning">{simulationResult.status}</StatusBadge></li>
          </ul>
          <div className="simulation-actions">
            <Button
              type="button"
              variant="primary"
              onClick={() => settleSynthetic('SUCCESS')}
              disabled={busy || settlementResult?.outcome === 'CREDITED'}
            >
              Simulate success
            </Button>
            <Button
              type="button"
              variant="danger"
              onClick={() => settleSynthetic('FAILED')}
              disabled={busy || settlementResult?.outcome === 'REJECTED'}
            >
              Simulate failure
            </Button>
          </div>
        </div>
      )}

      {settlementResult && (
        <div className="simulation-settlement">
          <h3>Settlement result</h3>
          <ul>
            <li>Outcome: <StatusBadge tone={settlementResult.outcome === 'CREDITED' ? 'success' : 'danger'}>{settlementResult.outcome}</StatusBadge></li>
            <li>Event ID: <code>{settlementResult.eventId ?? '—'}</code></li>
            <li>Organization: <code>{settlementResult.organizationId ?? '—'}</code></li>
            <li>Wallet entry: <code>{settlementResult.walletEntryId ?? '—'}</code></li>
          </ul>
        </div>
      )}
    </SectionCard>
  );
}
