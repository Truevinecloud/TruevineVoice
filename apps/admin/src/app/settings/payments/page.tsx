'use client';

import { useCallback, useEffect, useState } from 'react';

import { api } from '../../../lib/api';
import { SettingsAccessNotice, SettingsHeader, SettingsNav } from '../settings-ui';
import {
  ConnectionTestingNotice,
  PaymentProvidersFailure,
  PaymentProvidersLoading,
  ProviderCard,
  type PaymentProvidersView,
} from './payments-ui';

/**
 * Super Admin -> Settings -> Payment integrations.
 *
 * Reads a redacted view only. The API never returns a credential value, so this
 * page cannot display one even by accident; a saved field is shown as "Saved"
 * and its input starts blank.
 */
export default function PaymentIntegrationsPage() {
  const [access, setAccess] = useState<number | null | 'checking'>('checking');
  const [view, setView] = useState<PaymentProvidersView | null>(null);
  const [failure, setFailure] = useState<number | null>(null);

  const load = useCallback(async () => {
    try {
      const result = await api<PaymentProvidersView>('/platform/payments/providers');
      setView(result);
      setFailure(null);
    } catch (error) {
      setFailure((error as { status?: number }).status ?? 500);
    }
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void (async () => {
        try {
          await api('/platform/payments/me');
        } catch (error) {
          setAccess((error as { status?: number }).status ?? 500);
          return;
        }
        setAccess(null);
        await load();
      })();
    }, 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  return (
    <main className="operations-shell">
      <SettingsHeader title="Payment integrations" />
      <SettingsNav current="payments" />
      {access === 'checking' && <PaymentProvidersLoading />}
      <SettingsAccessNotice status={typeof access === 'number' ? access : null} />
      {access === null && failure !== null && <PaymentProvidersFailure status={failure} />}
      {access === null && view === null && failure === null && <PaymentProvidersLoading />}
      {access === null && view !== null && (
        <>
          <ConnectionTestingNotice connectionTesting={view.connectionTesting} />
          {view.providers.map((provider) => (
            <ProviderCard
              key={provider.provider}
              provider={provider}
              connectionTesting={view.connectionTesting}
              onChanged={() => void load()}
            />
          ))}
        </>
      )}
    </main>
  );
}
