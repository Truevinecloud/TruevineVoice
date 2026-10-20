'use client';

import { useCallback, useEffect, useState, type FormEvent } from 'react';

type Organization = {
  id: string;
  name: string;
  slug: string;
  status: 'ACTIVE' | 'SUSPENDED';
  campaignCount: number;
};
type Campaign = {
  organizationId: string;
  organizationName: string;
  organizationSlug: string;
  id: string;
  name: string;
  status: 'DRAFT' | 'ACTIVE' | 'PAUSED' | 'COMPLETED';
  emergencyStoppedAt: string | null;
};
type Health = {
  application: { status: string; dependencies: Record<string, { status: string }> };
  voiceProvider: { status: string; activeCalls: number | null };
};
type Operator = { platformRole: 'PLATFORM_OWNER' | 'OPERATIONS_ADMIN' | 'AUDITOR' };

const API = '/admin/api';

function csrfToken(): string {
  return (
    document.cookie
      .split('; ')
      .find((cookie) => cookie.startsWith('tv_csrf='))
      ?.slice('tv_csrf='.length) ?? ''
  );
}

async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`${API}${path}`, {
    ...init,
    credentials: 'same-origin',
    cache: 'no-store',
    headers: {
      ...(init.body ? { 'content-type': 'application/json' } : {}),
      ...(init.method && init.method !== 'GET' ? { 'x-truevine-csrf': csrfToken() } : {}),
      ...init.headers,
    },
  });
  if (!response.ok) {
    const error = new Error(`Request failed (${response.status})`);
    Object.assign(error, { status: response.status });
    throw error;
  }
  return (response.status === 204 ? undefined : await response.json()) as T;
}

export default function OperationsDashboard() {
  const [operator, setOperator] = useState<Operator | null>(null);
  const [organizations, setOrganizations] = useState<Organization[]>([]);
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [health, setHealth] = useState<Health | null>(null);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [message, setMessage] = useState('Checking platform access…');
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const me = await api<Operator>('/platform/operations/me');
      const [orgRows, campaignRows, healthReport] = await Promise.all([
        api<Organization[]>('/platform/operations/organizations'),
        api<Campaign[]>('/platform/operations/campaigns'),
        api<Health>('/platform/operations/health'),
      ]);
      setOperator(me);
      setOrganizations(orgRows);
      setCampaigns(campaignRows);
      setHealth(healthReport);
      setMessage('');
    } catch (error) {
      const status = (error as Error & { status?: number }).status;
      setOperator(null);
      setMessage(
        status === 401
          ? 'Sign in with an approved platform account.'
          : status === 403
            ? 'This account does not have Operations Admin access.'
            : 'Operations data is temporarily unavailable.',
      );
    }
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void refresh();
    }, 0);
    return () => window.clearTimeout(timer);
  }, [refresh]);

  async function signIn(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setMessage('Signing in…');
    try {
      await api('/auth/sign-in', { method: 'POST', body: JSON.stringify({ email, password }) });
      setPassword('');
      await refresh();
    } catch {
      setMessage('Sign-in failed. Check the credentials and try again.');
    } finally {
      setBusy(false);
    }
  }

  async function signOut() {
    await api('/auth/sign-out', { method: 'POST' }).catch(() => undefined);
    setOperator(null);
    setMessage('Signed out.');
  }

  async function stopCampaign(campaign: Campaign) {
    const reasonCode = window.prompt(
      'Choose reason code: security_incident, provider_incident, abuse_suspected, customer_request, other',
    );
    if (!reasonCode) return;
    setBusy(true);
    try {
      await api(
        `/platform/operations/organizations/${encodeURIComponent(campaign.organizationId)}/campaigns/${encodeURIComponent(campaign.id)}/emergency-stop`,
        {
          method: 'POST',
          body: JSON.stringify({ reasonCode }),
        },
      );
      setMessage('Campaign stopped and the action was recorded. No voice provider is connected.');
      await refresh();
    } catch {
      setMessage('Emergency stop failed. Refresh and verify the campaign state.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="operations-shell">
      <header className="topbar">
        <div>
          <span className="eyebrow">TRUEVINE VOICE · PLATFORM</span>
          <h1>Operations</h1>
        </div>
        {operator && (
          <button className="quiet-button" onClick={() => void signOut()}>
            Sign out
          </button>
        )}
      </header>
      {message && (
        <p className="notice" role="status">
          {message}
        </p>
      )}
      {!operator ? (
        <form className="card sign-in" onSubmit={(event) => void signIn(event)}>
          <h2>Platform sign in</h2>
          <label>
            Email
            <input
              type="email"
              autoComplete="username"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              required
            />
          </label>
          <label>
            Password
            <input
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              required
            />
          </label>
          <button disabled={busy} type="submit">
            Sign in
          </button>
        </form>
      ) : (
        <>
          <section className="health-grid" aria-label="Service health">
            <HealthCard label="API" value={health?.application.status ?? 'unknown'} />
            <HealthCard
              label="PostgreSQL"
              value={health?.application.dependencies.postgres?.status ?? 'unknown'}
            />
            <HealthCard
              label="Redis"
              value={health?.application.dependencies.redis?.status ?? 'unknown'}
            />
            <HealthCard
              label="Voice provider"
              value={health?.voiceProvider.status ?? 'unknown'}
              detail="No provider integration is configured."
            />
          </section>
          <section className="card">
            <div className="section-heading">
              <h2>Organizations</h2>
              <span>{organizations.length} shown</span>
            </div>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Organization</th>
                    <th>Status</th>
                    <th>Campaigns</th>
                  </tr>
                </thead>
                <tbody>
                  {organizations.map((org) => (
                    <tr key={org.id}>
                      <td>
                        <strong>{org.name}</strong>
                        <small>{org.slug}</small>
                      </td>
                      <td>
                        <Status value={org.status} />
                      </td>
                      <td>{org.campaignCount}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
          <section className="card">
            <div className="section-heading">
              <h2>Campaign operations</h2>
              <span>Latest 100</span>
            </div>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Campaign</th>
                    <th>Organization</th>
                    <th>Status</th>
                    <th>Action</th>
                  </tr>
                </thead>
                <tbody>
                  {campaigns.map((campaign) => (
                    <tr key={`${campaign.organizationId}:${campaign.id}`}>
                      <td>{campaign.name}</td>
                      <td>
                        {campaign.organizationName}
                        <small>{campaign.organizationSlug}</small>
                      </td>
                      <td>
                        <Status value={campaign.status} />
                      </td>
                      <td>
                        {campaign.status === 'ACTIVE' && !campaign.emergencyStoppedAt && (
                          <button
                            className="danger-button"
                            disabled={
                              busy ||
                              (operator.platformRole !== 'OPERATIONS_ADMIN' &&
                                operator.platformRole !== 'PLATFORM_OWNER')
                            }
                            onClick={() => void stopCampaign(campaign)}
                          >
                            Emergency stop
                          </button>
                        )}
                        {campaign.emergencyStoppedAt && <span>Stopped</span>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
          <p className="footnote">
            Emergency stop pauses the campaign record and prevents reactivation through customer
            campaign APIs. Voice dispatch and active calls are not supported in this release.
          </p>
        </>
      )}
    </main>
  );
}

function HealthCard({ label, value, detail }: { label: string; value: string; detail?: string }) {
  return (
    <div className="health-card">
      <span>{label}</span>
      <strong>{value}</strong>
      {detail && <small>{detail}</small>}
    </div>
  );
}

function Status({ value }: { value: string }) {
  return <span className={`status status-${value.toLowerCase()}`}>{value}</span>;
}
