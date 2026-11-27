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

/**
 * The API's bounded projection of a sensitive mutation's stored evidence.
 *
 * `redacted` lists the monetary paths the server replaced for a reader without
 * `platform:billing:read`. The table renders that list explicitly, so an
 * incomplete-looking record is explained rather than mistaken for no change.
 */
export type AuditEvidence = {
  target: { type: string; id: string } | null;
  before: Record<string, unknown> | null;
  change: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  reasonCode: string | null;
  justification: string | null;
  reasonSource: string | null;
  redacted: readonly string[];
  financialAccess: 'visible' | 'redacted' | 'not_financial';
};

export type AuditEventRow = {
  id: string;
  trail: string;
  action: string;
  outcome: string;
  scope: string | null;
  targetType: string | null;
  targetId: string | null;
  organizationId?: string | null;
  occurredAt: string;
  actor: { userId: string; email: string };
  metadata: unknown;
  evidence?: AuditEvidence | null;
};

export function AuditorHeader({ title }: { title: string }) {
  return (
    <header className="topbar">
      <div>
        <span className="eyebrow">TRUEVINE VOICE · PLATFORM AUDIT</span>
        <h1>{title}</h1>
        <span className="badge">Read-only workspace</span>
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
              <td><AuditTime value={organization.createdAt} /></td>
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
    <>
      <p className="audit-scroll-hint">Scroll horizontally to view every column.</p>
      <div className="table-wrap audit-history-scroll" role="region" aria-label="Platform event history" tabIndex={0}>
        <table className="audit-history-table">
          <caption>Platform event history. All times are UTC.</caption>
          <thead>
            <tr>
              <th scope="col">Timestamp</th>
              <th scope="col">Action</th>
              <th scope="col">Actor</th>
              <th scope="col">Target</th>
              <th scope="col">Organization</th>
              <th scope="col">Reason</th>
              <th scope="col">Outcome</th>
              <th scope="col">Detail</th>
            </tr>
          </thead>
          <tbody>
            {events.map((event) => (
              <AuditRow key={`${event.trail}:${event.id}`} event={event} />
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

/**
 * One audit event. Evidence is rendered field by field, never as raw JSON, so
 * a redacted value is visibly redacted and an unbounded provider payload cannot
 * become an accidental detail view.
 */
function AuditRow({ event }: { event: AuditEventRow }) {
  const evidence = event.evidence ?? null;
  const targetType =
    event.targetType ??
    evidence?.target?.type ??
    (auditMetadataText(event.metadata, 'targetUserId') ? 'user' : null);
  const targetId =
    event.targetId ??
    evidence?.target?.id ??
    auditMetadataText(event.metadata, 'targetUserId');
  const reason =
    evidence?.reasonCode ??
    auditMetadataText(event.metadata, 'reasonCode') ??
    auditMetadataText(event.metadata, 'reason') ??
    null;
  const organization =
    event.organizationId ?? auditMetadataText(event.metadata, 'organizationId') ?? null;

  return (
    <tr>
      <td><AuditTime value={event.occurredAt} /></td>
      <td>
        <strong>{event.action}</strong>
        <small>{event.trail} trail</small>
      </td>
      <td>
        {event.actor.email}
        <small>{event.actor.userId}</small>
      </td>
      <td>
        {targetType ?? 'Not recorded'}
        <small>{targetId}</small>
      </td>
      <td>{organization ?? 'Not recorded'}</td>
      <td>
        {reason ?? 'Not recorded'}
        {reason !== null && evidence?.reasonSource && <small>{evidence.reasonSource} supplied</small>}
      </td>
      <td>
        <Status value={event.outcome} />
      </td>
      <td>
        <details>
          <summary>View event details</summary>
          <dl className="audit-details">
            <dt>Event ID</dt><dd>{event.id}</dd>
            <dt>Scope</dt><dd>{event.scope ?? 'Identity'}</dd>
            <dt>Target</dt><dd>{targetType ?? 'Not recorded'}{targetId && ` · ${targetId}`}</dd>
            {evidence && (
              <>
                <dt>Reason code</dt><dd>{evidence.reasonCode ?? 'Not recorded'}</dd>
                <dt>Reason source</dt><dd>{describeReasonSource(evidence.reasonSource)}</dd>
                <dt>Operator justification</dt>
                <dd>
                  {evidence.justification === null
                    ? 'Not supplied'
                    : evidence.justification === '[REDACTED]'
                      ? <span className="audit-redacted-value">[redacted by the API]</span>
                      : evidence.justification}
                </dd>
              </>
            )}
          </dl>
          {evidence?.financialAccess === 'redacted' && (
            <p className="audit-redaction" role="note">
              Monetary values are hidden because this account does not hold billing read
              access. The action, actor and reason remain visible.
              {evidence.redacted.length > 0 && (
                <> Redacted fields: <code>{evidence.redacted.join(', ')}</code>.</>
              )}
            </p>
          )}
          {evidence?.financialAccess === 'visible' && (
            <p className="footnote">Monetary evidence is visible to this account.</p>
          )}
          {evidence && <EvidenceBlock label="Before" record={evidence.before} />}
          {evidence && <EvidenceBlock label="Change" record={evidence.change} />}
          {evidence && <EvidenceBlock label="After" record={evidence.after} />}
          {Object.keys(auditMetadataObject(event.metadata)).length > 0 && (
            <>
              <p className="footnote">Projected event metadata</p>
              <pre>{JSON.stringify(event.metadata, null, 2)}</pre>
            </>
          )}
        </details>
      </td>
    </tr>
  );
}

function describeReasonSource(value: string | null): string {
  if (value === 'caller') return 'Supplied by the operator';
  if (value === 'server') return 'Server purpose code';
  return 'Not recorded';
}

/** Flatten the API's bounded evidence record into readable dotted paths. */
function EvidenceBlock({
  label,
  record,
}: {
  label: string;
  record: Readonly<Record<string, unknown>> | null;
}) {
  if (record === null) return null;
  const rows = evidenceEntries(record);
  if (rows.length === 0) return null;
  return (
    <section className="audit-evidence" aria-label={`${label} state`}>
      <h3>{label}</h3>
      <dl>
        {rows.map(([path, value]) => (
          <div key={path} className="audit-evidence-row">
            <dt>{path}</dt>
            <dd>
              {value === '[redacted]'
                ? <span className="audit-redacted-value">[redacted]</span>
                : evidenceText(value)}
            </dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

function evidenceEntries(
  record: Readonly<Record<string, unknown>>,
  prefix = '',
  depth = 0,
  out: Array<[string, unknown]> = [],
): Array<[string, unknown]> {
  if (depth > 3 || out.length >= 40) return out;
  for (const [key, value] of Object.entries(record)) {
    const path = prefix === '' ? key : `${prefix}.${key}`;
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      evidenceEntries(value as Readonly<Record<string, unknown>>, path, depth + 1, out);
    } else {
      out.push([path, value]);
    }
    if (out.length >= 40) break;
  }
  return out;
}

function evidenceText(value: unknown): string {
  if (value === null) return '—';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return '[unreadable]';
  }
}

function auditMetadataObject(metadata: unknown): Record<string, unknown> {
  return metadata !== null && typeof metadata === 'object' && !Array.isArray(metadata)
    ? (metadata as Record<string, unknown>)
    : {};
}

/** Only display bounded text from the API's existing scalar metadata projection. */
function auditMetadataText(metadata: unknown, key: string): string | null {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata) || !Object.prototype.hasOwnProperty.call(metadata, key)) return null;
  const value = (metadata as Record<string, unknown>)[key];
  return typeof value === 'string' && value.trim() && value.length <= 256 ? value : null;
}

function AuditTime({ value }: { value: string }) {
  const date = new Date(value);
  return <time dateTime={value}>{Number.isNaN(date.getTime()) ? value : `${date.toISOString().slice(0, 10)} ${date.toISOString().slice(11, 19)} UTC`}</time>;
}

function HealthCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="health-card">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}
