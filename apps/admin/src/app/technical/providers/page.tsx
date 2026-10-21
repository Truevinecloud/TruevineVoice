'use client';

import { useEffect, useState } from 'react';

import { api } from '../../../lib/api';
import {
  ProvidersTable,
  TechnicalAccessNotice,
  TechnicalHeader,
  TechnicalNav,
  type ProviderRow,
} from '../technical-ui';

type ProvidersResponse = { providers: ProviderRow[]; notAvailable: string[] };

/** Provider integration status (RBAC-010). Read-only; providers are declared, not configured. */
export default function TechnicalProvidersPage() {
  const [access, setAccess] = useState<number | null | 'checking'>('checking');
  const [providers, setProviders] = useState<ProviderRow[]>([]);
  const [notAvailable, setNotAvailable] = useState<string[]>([]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void (async () => {
        try {
          await api('/platform/technical/me');
          const result = await api<ProvidersResponse>('/platform/technical/providers');
          setProviders(result.providers);
          setNotAvailable(result.notAvailable);
          setAccess(null);
        } catch (error) {
          setAccess((error as { status?: number }).status ?? 500);
        }
      })();
    }, 0);
    return () => window.clearTimeout(timer);
  }, []);

  return (
    <main className="operations-shell">
      <TechnicalHeader title="Providers" />
      <TechnicalNav current="providers" />
      <TechnicalAccessNotice status={typeof access === 'number' ? access : null} />
      {access === null && (
        <section className="card">
          <div className="section-heading">
            <h2>Provider integrations</h2>
            <span>{providers.length} declared</span>
          </div>
          <ProvidersTable providers={providers} />
          <p className="footnote">
            Not modelled yet, so not shown: {notAvailable.join(', ')}. A provider marked
            not_integrated is declared as an interface only; no SDK is linked.
          </p>
        </section>
      )}
    </main>
  );
}
