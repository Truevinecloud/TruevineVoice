import Link from 'next/link';

/**
 * Presentational building blocks for the technical workspace (RBAC-010).
 *
 * Pure props in, markup out - no fetching, no hooks - so the unit suite renders
 * them through `react-dom/server` without a DOM or a router. Pages own the
 * state and the calls to the API proxy.
 *
 * The recurring idea here is honesty: a subsystem the platform cannot report on
 * is rendered with the reason it cannot, never as an empty table that reads as
 * "there were none".
 */

export type SubsystemStatus = {
  status: string;
  detail?: string;
};

export type OverviewView = {
  application: {
    status: string;
    service: string;
    version: string;
    environment: string;
    uptimeSeconds: number;
    timestamp: string;
    dependencies: Record<string, { status: string; latencyMs?: number }>;
  };
  subsystems: {
    voiceProvider: SubsystemStatus;
    queues: SubsystemStatus;
    logStorage: SubsystemStatus;
  };
  notAvailable: string[];
};

export type ProviderRow = {
  name: string;
  status: string;
  detail: string;
};

export type QueueView = {
  status: string;
  queues: string[];
  failedJobs: string[];
  detail: string;
};

export type LogView = {
  status: string;
  entries: string[];
  detail: string;
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

export function TechnicalHeader({ title }: { title: string }) {
  return (
    <header className="topbar">
      <div>
        <span className="eyebrow">TRUEVINE VOICE · PLATFORM TECHNICAL</span>
        <h1>{title}</h1>
      </div>
      <Link className="quiet-button" href="/">
        Operations home
      </Link>
    </header>
  );
}

export function TechnicalNav({
  current,
}: {
  current: 'overview' | 'providers' | 'queues' | 'audit';
}) {
  const sections: Array<{ key: typeof current; href: string; label: string }> = [
    { key: 'overview', href: '/technical', label: 'Overview' },
    { key: 'providers', href: '/technical/providers', label: 'Providers' },
    { key: 'queues', href: '/technical/queues', label: 'Queues' },
    { key: 'audit', href: '/technical/audit', label: 'Audit' },
  ];

  return (
    <nav className="technical-nav" aria-label="Technical sections">
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

export function TechnicalAccessNotice({ status }: { status: number | null }) {
  if (status === 401) {
    return (
      <p className="notice" role="status">
        Sign in with a technical account from the <Link href="/">operations home</Link>.
      </p>
    );
  }
  if (status === 403) {
    return (
      <p className="notice" role="status">
        This account does not have Technical Admin access.
      </p>
    );
  }
  if (status !== null) {
    return (
      <p className="notice" role="status">
        Technical diagnostics are temporarily unavailable.
      </p>
    );
  }
  return null;
}

export function Status({ value }: { value: string }) {
  return <span className={`status status-${value.toLowerCase()}`}>{value}</span>;
}

export function OverviewPanels({ overview }: { overview: OverviewView }) {
  const dependencies = Object.entries(overview.application.dependencies);
  return (
    <>
      <section className="health-grid" aria-label="Application health">
        <HealthCard label="Application" value={overview.application.status} />
        {dependencies.map(([name, dependency]) => (
          <HealthCard key={name} label={name} value={dependency.status} />
        ))}
      </section>
      <section className="health-grid" aria-label="Subsystem availability">
        <SubsystemCard label="Voice provider" subsystem={overview.subsystems.voiceProvider} />
        <SubsystemCard label="Queues" subsystem={overview.subsystems.queues} />
        <SubsystemCard label="Log storage" subsystem={overview.subsystems.logStorage} />
      </section>
      <div className="kv-grid" aria-label="Process facts">
        <Metric label="Service" value={overview.application.service} />
        <Metric label="Version" value={overview.application.version} />
        <Metric label="Environment" value={overview.application.environment} />
        <Metric label="Uptime (s)" value={String(overview.application.uptimeSeconds)} />
      </div>
      <p className="footnote">
        Not modelled yet, so not shown: {overview.notAvailable.join(', ')}. A subsystem marked
        not_integrated or not_configured has no data behind it - it is not an empty result.
      </p>
    </>
  );
}

export function ProvidersTable({ providers }: { providers: ProviderRow[] }) {
  if (providers.length === 0) {
    return <p className="footnote">No providers are declared.</p>;
  }
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Provider</th>
            <th>Status</th>
            <th>Detail</th>
          </tr>
        </thead>
        <tbody>
          {providers.map((provider) => (
            <tr key={provider.name}>
              <td>
                <strong>{provider.name}</strong>
              </td>
              <td>
                <Status value={provider.status} />
              </td>
              <td>{provider.detail}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function QueuesPanel({ queues }: { queues: QueueView }) {
  return (
    <div className="card">
      <div className="section-heading">
        <h2>Queues</h2>
        <Status value={queues.status} />
      </div>
      <p>{queues.detail}</p>
      {queues.queues.length === 0 ? (
        <p className="footnote">No queues are registered.</p>
      ) : (
        <ul>
          {queues.queues.map((queue) => (
            <li key={queue}>{queue}</li>
          ))}
        </ul>
      )}
      <div className="section-heading">
        <h2>Failed jobs</h2>
        <span>{queues.failedJobs.length} shown</span>
      </div>
      {queues.failedJobs.length === 0 ? (
        <p className="footnote">
          No failed jobs are reported. This is expected while no queue system is integrated.
        </p>
      ) : (
        <ul>
          {queues.failedJobs.map((job) => (
            <li key={job}>{job}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function LogsPanel({ logs }: { logs: LogView }) {
  return (
    <div className="card">
      <div className="section-heading">
        <h2>Logs</h2>
        <Status value={logs.status} />
      </div>
      <p>{logs.detail}</p>
      {logs.entries.length === 0 ? (
        <p className="footnote">
          No log entries are queryable. This is a missing capability, not an empty log.
        </p>
      ) : (
        <ul>
          {logs.entries.map((entry) => (
            <li key={entry}>{entry}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function TechnicalAuditTable({ events }: { events: AuditEventRow[] }) {
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

function SubsystemCard({ label, subsystem }: { label: string; subsystem: SubsystemStatus }) {
  return (
    <div className="health-card">
      <span>{label}</span>
      <Status value={subsystem.status} />
      {subsystem.detail && <small>{subsystem.detail}</small>}
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
