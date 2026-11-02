'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';

import { api } from '../../lib/api';
import { SettingsAccessNotice, SettingsHeader, SettingsNav } from './settings-ui';

/**
 * Platform Settings landing page.
 *
 * Access is established with the same permission the section itself uses, so a
 * role that cannot read payment settings never sees a link that leads to a 403.
 */
export default function SettingsPage() {
  const [access, setAccess] = useState<number | null | 'checking'>('checking');

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void (async () => {
        try {
          await api('/platform/payments/me');
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
      <SettingsHeader title="Settings" />
      <SettingsNav current="overview" />
      {access === 'checking' && (
        <p className="notice" role="status">
          Checking access…
        </p>
      )}
      <SettingsAccessNotice status={typeof access === 'number' ? access : null} />
      {access === null && (
        <section className="card">
          <div className="section-heading">
            <h2>Payment integrations</h2>
            <span>Super Admin only</span>
          </div>
          <p>
            Configure MTN Mobile Money and Airtel Money credentials. Credentials are encrypted at
            rest and never shown again after they are saved. One environment per provider can be
            active at a time.
          </p>
          <p>
            <Link href="/settings/payments">Open payment integrations</Link>
          </p>
        </section>
      )}
    </main>
  );
}
