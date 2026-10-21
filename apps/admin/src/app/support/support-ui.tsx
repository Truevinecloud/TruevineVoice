import Link from 'next/link';

/**
 * Presentational building blocks for the support workspace (RBAC-009).
 *
 * Pure props in, markup out - no fetching, no hooks beyond nothing at all - so
 * the unit suite renders them through `react-dom/server` without a DOM or a
 * router. Pages own the state and the calls to the API proxy.
 */

export type SupportOperator = { platformRole: string };

export type OrganizationRow = {
  id: string;
  name: string;
  slug: string;
  status: 'ACTIVE' | 'SUSPENDED';
  memberCount?: number;
  campaignCount?: number;
};

export type MemberRow = {
  userId: string;
  email: string;
  userStatus: 'ACTIVE' | 'SUSPENDED';
  role: string;
  joinedAt: string;
  lockedUntil: string | null;
};

export type CampaignRow = {
  id: string;
  name: string;
  status: string;
  emergencyStoppedAt: string | null;
  updatedAt: string;
};

export type DiagnosticsView = {
  organization: { id: string; name: string; slug: string; status: string };
  memberCount: number;
  auditEventCount: number;
  billingProfilePresent: boolean;
  campaigns: {
    total: number;
    byStatus: Record<string, number>;
    emergencyStoppedCount: number;
    recent: CampaignRow[];
  };
  walletBalances: Array<{
    currency: string;
    amountMinor: string;
    entryCount: number;
    lastEntryAt: string | null;
  }>;
  topUpRequests: Array<{
    currency: string;
    requestCount: number;
    totalRequestedMinor: string;
    lastRequestedAt: string | null;
  }>;
  notAvailable: string[];
};

export type UserRow = {
  id: string;
  email: string;
  status: 'ACTIVE' | 'SUSPENDED';
  createdAt: string;
  lockedUntil: string | null;
  platformRole: { role: string; grantedAt: string } | null;
  membershipCount: number;
};

export type AuditEventRow = {
  id: string;
  action: string;
  outcome: string;
  scope: string | null;
  targetType: string | null;
  targetId: string | null;
  occurredAt: string;
  actor: { userId: string; email: string };
  metadata: unknown;
};

export function SupportHeader({ title }: { title: string }) {
  return (
    <header className="topbar">
      <div>
        <span className="eyebrow">TRUEVINE VOICE · PLATFORM SUPPORT</span>
        <h1>{title}</h1>
      </div>
      <Link className="quiet-button" href="/">
        Operations home
      </Link>
    </header>
  );
}

export function SupportNav({ current }: { current: 'customers' | 'users' }) {
  return (
    <nav className="support-nav" aria-label="Support sections">
      <Link href="/support" aria-current={current === 'customers' ? 'page' : undefined}>
        Customers
      </Link>
      <Link href="/support/users" aria-current={current === 'users' ? 'page' : undefined}>
        Users
      </Link>
    </nav>
  );
}

export function Status({ value }: { value: string }) {
  return <span className={`status status-${value.toLowerCase()}`}>{value}</span>;
}

export function AccessNotice({ status }: { status: number | null }) {
  if (status === 401) {
    return (
      <p className="notice" role="status">
        Sign in with a platform account from the <Link href="/">operations home</Link>.
      </p>
    );
  }
  if (status === 403) {
    return (
      <p className="notice" role="status">
        This account does not have Support Admin access.
      </p>
    );
  }
  if (status !== null) {
    return (
      <p className="notice" role="status">
        Support data is temporarily unavailable.
      </p>
    );
  }
  return null;
}

export function OrganizationsTable({ organizations }: { organizations: OrganizationRow[] }) {
  if (organizations.length === 0) {
    return <p className="footnote">No organizations matched.</p>;
  }
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Organization</th>
            <th>Status</th>
            <th>Members</th>
            <th>Campaigns</th>
          </tr>
        </thead>
        <tbody>
          {organizations.map((organization) => (
            <tr key={organization.id}>
              <td>
                <Link href={`/support/customers/${organization.id}`}>
                  <strong>{organization.name}</strong>
                  <small>{organization.slug}</small>
                </Link>
              </td>
              <td>
                <Status value={organization.status} />
              </td>
              <td>{organization.memberCount ?? '—'}</td>
              <td>{organization.campaignCount ?? '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function UsersTable({ users }: { users: UserRow[] }) {
  if (users.length === 0) {
    return <p className="footnote">No users matched.</p>;
  }
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>User</th>
            <th>Status</th>
            <th>Organizations</th>
            <th>Platform role</th>
          </tr>
        </thead>
        <tbody>
          {users.map((user) => (
            <tr key={user.id}>
              <td>
                <Link href={`/support/users/${user.id}`}>
                  <strong>{user.email}</strong>
                  <small>{user.id}</small>
                </Link>
              </td>
              <td>
                <Status value={user.status} />
                {user.lockedUntil && <small>Locked until {user.lockedUntil}</small>}
              </td>
              <td>{user.membershipCount}</td>
              <td>{user.platformRole?.role ?? '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function MembersTable({ members }: { members: MemberRow[] }) {
  if (members.length === 0) {
    return <p className="footnote">This organization has no members.</p>;
  }
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Member</th>
            <th>Role</th>
            <th>Account</th>
            <th>Joined</th>
          </tr>
        </thead>
        <tbody>
          {members.map((member) => (
            <tr key={member.userId}>
              <td>
                <Link href={`/support/users/${member.userId}`}>
                  <strong>{member.email}</strong>
                </Link>
              </td>
              <td>{member.role}</td>
              <td>
                <Status value={member.userStatus} />
                {member.lockedUntil && <small>Locked until {member.lockedUntil}</small>}
              </td>
              <td>{member.joinedAt}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function DiagnosticsPanels({ diagnostics }: { diagnostics: DiagnosticsView }) {
  return (
    <>
      <div className="kv-grid" aria-label="Diagnostics summary">
        <Metric label="Members" value={String(diagnostics.memberCount)} />
        <Metric label="Audit events" value={String(diagnostics.auditEventCount)} />
        <Metric
          label="Billing profile"
          value={diagnostics.billingProfilePresent ? 'On file' : 'None'}
        />
        <Metric label="Campaigns" value={String(diagnostics.campaigns.total)} />
        <Metric
          label="Emergency stopped"
          value={String(diagnostics.campaigns.emergencyStoppedCount)}
        />
      </div>
      <div className="card">
        <div className="section-heading">
          <h2>Wallet balances</h2>
          <span>Sum of the append-only ledger</span>
        </div>
        {diagnostics.walletBalances.length === 0 ? (
          <p>No wallet entries.</p>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Currency</th>
                  <th>Balance (minor units)</th>
                  <th>Entries</th>
                  <th>Last entry</th>
                </tr>
              </thead>
              <tbody>
                {diagnostics.walletBalances.map((balance) => (
                  <tr key={balance.currency}>
                    <td>{balance.currency}</td>
                    <td>{balance.amountMinor}</td>
                    <td>{balance.entryCount}</td>
                    <td>{balance.lastEntryAt ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
      <div className="card">
        <div className="section-heading">
          <h2>Top-up requests</h2>
          <span>Durable requests, not payments</span>
        </div>
        {diagnostics.topUpRequests.length === 0 ? (
          <p>No top-up requests.</p>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Currency</th>
                  <th>Requests</th>
                  <th>Requested (minor units)</th>
                  <th>Last request</th>
                </tr>
              </thead>
              <tbody>
                {diagnostics.topUpRequests.map((topUp) => (
                  <tr key={topUp.currency}>
                    <td>{topUp.currency}</td>
                    <td>{topUp.requestCount}</td>
                    <td>{topUp.totalRequestedMinor}</td>
                    <td>{topUp.lastRequestedAt ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
      <div className="card">
        <div className="section-heading">
          <h2>Recent campaigns</h2>
          <span>Latest 50 by update</span>
        </div>
        {diagnostics.campaigns.recent.length === 0 ? (
          <p>No campaigns.</p>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Campaign</th>
                  <th>Status</th>
                  <th>Emergency stop</th>
                  <th>Updated</th>
                </tr>
              </thead>
              <tbody>
                {diagnostics.campaigns.recent.map((campaign) => (
                  <tr key={campaign.id}>
                    <td>{campaign.name}</td>
                    <td>
                      <Status value={campaign.status} />
                    </td>
                    <td>{campaign.emergencyStoppedAt ?? '—'}</td>
                    <td>{campaign.updatedAt}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
      <p className="footnote">
        Not modelled yet, so not shown: {diagnostics.notAvailable.join(', ')}. An empty section
        above means an empty ledger, not missing data.
      </p>
    </>
  );
}

export function AuditTable({ events }: { events: AuditEventRow[] }) {
  if (events.length === 0) {
    return <p className="footnote">No audit events on this trail.</p>;
  }
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>When</th>
            <th>Action</th>
            <th>Actor</th>
            <th>Outcome</th>
          </tr>
        </thead>
        <tbody>
          {events.map((event) => (
            <tr key={event.id}>
              <td>{event.occurredAt}</td>
              <td>
                <strong>{event.action}</strong>
                {event.targetId && <small>{`${event.targetType ?? 'target'} ${event.targetId}`}</small>}
              </td>
              <td>
                {event.actor.email}
                <small>{event.actor.userId}</small>
              </td>
              <td>
                <Status value={event.outcome} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="kv">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}
