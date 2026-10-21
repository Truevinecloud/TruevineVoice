'use client';

import { useEffect, useState } from 'react';

import { api } from '../../../lib/api';
import {
  QueuesPanel,
  TechnicalAccessNotice,
  TechnicalHeader,
  TechnicalNav,
  type QueueView,
} from '../technical-ui';

/** Queue and failed-job status (RBAC-010). Read-only; no queue system is integrated yet. */
export default function TechnicalQueuesPage() {
  const [access, setAccess] = useState<number | null | 'checking'>('checking');
  const [queues, setQueues] = useState<QueueView | null>(null);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void (async () => {
        try {
          await api('/platform/technical/me');
          setQueues(await api<QueueView>('/platform/technical/queues'));
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
      <TechnicalHeader title="Queues" />
      <TechnicalNav current="queues" />
      <TechnicalAccessNotice status={typeof access === 'number' ? access : null} />
      {access === null && queues && <QueuesPanel queues={queues} />}
    </main>
  );
}
