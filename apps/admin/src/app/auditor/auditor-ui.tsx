import Link from 'next/link';

/**
 * Presentational building blocks for the auditor workspace (RBAC-011).
 *
 * Pure props in, markup out - no fetching, no hooks - so the unit suite renders
 * them through `react-dom/server`. Pages own the state and the calls to the API
 * proxy.
 *
 * The workspace shows what the auditor is entitled to and nothing else: platform
 * counts, organization identity/status, and the merged platform audit trail. It
 * has no controls that mutate, because the role cannot mutate and a disabled
 * button would imply a capability that does not exist.
 */

export type PlatformRoleCount = {
  role: string;
  count: number;
};

export type OverviewView = {
  organizations: { total: number };
  platformRoles: PlatformRoleCount[];
  scope: {
    readable: string[];
    writable: readonly string[];
  };
};

export type OrganizationRow = {
  id: string;
  name: string;
  slug: string;
  status: 'ACTIVE' | 'SUSPENDED';
  createdAt: string;
  memberCount: number;
};

export type AuditEventRow = {
  id: string;
  trail: string;
  action: string;
  outcome: string;
  scope: string | null;
  targetType: string | null;
  targetId: string | null;
  occurredAt: string;
  actor: { userId: string; email: string };
  metadata: unknown;
};

export function AuditorHeader({ title }: { title: string }) {
  return (
    <header className="topbar">
      <div>
        <span className="eyebrow">TRUEVINE VOICE · PLATFORM AUDIT</span>
        <h1>{title}</h1>
      </div>
      <Link className="quiet-button" href="/">
        Operations home
      </Link>
    </header>
  );
}

export function AuditorNav({
  current,
}: {
  current: 'overview' | 'organizations' | 'audit';
}) {
  const sections: Array<{ key: typeof current; href: string; label: string }> = [
    { key: 'overview', href: '/auditor', label: 'Overview' },
    { key: 'organizations', href: '/auditor/organizations', label: 'Organizations' },
    { key: 'audit', href: '/auditor/audit', label: 'Audit trail' },
  ];

  return (
    <nav className="auditor-nav" aria-label="Auditor sections">
      {sections.map((section) => (
        <Link
          key={section.key}
          href={section.href}
          aria-current={current === section.key ? 'page' : undefined}
        >
          {section.label}
        </Link>
      ))}
    </nav>
  );
}

export function AuditorAccessNotice({ status }: { status: number | null }) {
  if (status === 401) {
    return (
      <p className="notice" role="status">
        Sign in with an audit account from the <Link href="/">operations home</Link>.
      </p>
    );
  }
  if (status === 403) {
    return (
      <p className="notice" role="status">
        This account does not have Auditor access.
      </p>
    );
  }
  if (status !== null) {
    return (
      <p className="notice" role="status">
        Audit records are temporarily unavailable.
      </p>
    );
  }
  return null;
}

export function Status({ value }: { value: string }) {
  return <span className={`status status-${value.toLowerCase()}`}>{value}</span>;
}

export function OverviewPanels({ overview }: { overview: OverviewView }) {
  return (
    <>
      <section className="health-grid" aria-label="Platform totals">
        <HealthCard label="Organizations" value={String(overview.organizations.total)} />
        <HealthCard
          label="Platform operators"
          value={String(
            overview.platformRoles.reduce((total, row) => total + row.count, 0),
          )}
        />
      </section>
      <div className="card">
        <div className="section-heading">
          <h2>Platform roles</h2>
          <span>{overview.platformRoles.length} roles in use</span>
        </div>
        {overview.platformRoles.length === 0 ? (
          <p className="footnote">No platform roles are currently assigned.</p>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Role</th>
                  <th>Holders</th>
                </tr>
              </thead>
              <tbody>
                {overview.platformRoles.map((row) => (
                  <tr key={row.role}>
                    <td>
                      <strong>{row.role}</strong>
                    </td>
                    <td>{row.count}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
      <div className="card">
        <div className="section-heading">
          <h2>This role&apos;s reach</h2>
        </div>
        <p>
          Read-only. The auditor answers for what happened; it does not change anything.
        </p>
        <ul>
          {overview.scope.readable.map((permission) => (
            <li key={permission}>
              <code>{permission}</code>
            </li>
          ))}
        </ul>
        <p className="footnote">
          Writable permissions: {overview.scope.writable.length === 0 ? 'none' : overview.scope.writable.join(', ')}.
        </p>
      </div>
    </>
  );
}

export function OrganizationsTable({ organizations }: { organizations: OrganizationRow[] }) {
  if (organizations.length === 0) {
    return <p className="footnote">No organizations on this page.</p>;
  }
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Organization</th>
            <th>Status</th>
            <th>Members</th>
            <th>Created</th>
          </tr>
        </thead>
        <tbody>
          {organizations.map((organization) => (
            <tr key={organization.id}>
              <td>
                <strong>{organization.name}</strong>
                <small>{organization.slug}</small>
              </td>
              <td>
                <Status value={organization.status} />
              </td>
              <td>{organization.memberCount}</td>
              <td>{organization.createdAt}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function AuditorAuditTable({ events }: { events: AuditEventRow[] }) {
  if (events.length === 0) {
    return <p className="footnote">No platform audit events on this trail.</p>;
  }
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>When</th>
            <th>Action</th>
            <th>Actor</th>
            <th>Scope</th>
            <th>Outcome</th>
            <th>Detail</th>
          </tr>
        </thead>
        <tbody>
          {events.map((event) => (
            <tr key={`${event.trail}:${event.id}`}>
              <td>{event.occurredAt}</td>
              <td>
                <strong>{event.action}</strong>
                <small>{event.trail} trail</small>
              </td>
              <td>
                {event.actor.email}
                <small>{event.actor.userId}</small>
              </td>
              <td>{event.scope ?? '—'}</td>
              <td>
                <Status value={event.outcome} />
              </td>
              <td>
                <code>{JSON.stringify(event.metadata)}</code>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function HealthCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="health-card">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}
