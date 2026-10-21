import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import {
  LogsPanel,
  OverviewPanels,
  ProvidersTable,
  QueuesPanel,
  TechnicalAccessNotice,
  TechnicalAuditTable,
  TechnicalHeader,
  TechnicalNav,
  type OverviewView,
} from './technical-ui';

const overview: OverviewView = {
  application: {
    status: 'ok',
    service: 'truevine-voice-api',
    version: '0.1.0-test',
    environment: 'test',
    uptimeSeconds: 42,
    timestamp: '2026-10-20T00:00:00.000Z',
    dependencies: {
      postgres: { status: 'up', latencyMs: 1 },
      redis: { status: 'up', latencyMs: 2 },
    },
  },
  subsystems: {
    voiceProvider: { status: 'not_integrated', detail: 'No voice provider integration is configured.' },
    queues: { status: 'not_integrated', detail: 'No business queues are registered yet.' },
    logStorage: { status: 'not_configured', detail: 'Logs go to stdout only.' },
  },
  notAvailable: ['voice_calls', 'log_storage'],
};

describe('TechnicalHeader', () => {
  it('renders the title inside the technical workspace', () => {
    const markup = renderToStaticMarkup(<TechnicalHeader title="Technical overview" />);
    expect(markup).toContain('PLATFORM TECHNICAL');
    expect(markup).toContain('Technical overview');
  });
});

describe('TechnicalNav', () => {
  it('marks the active section', () => {
    const markup = renderToStaticMarkup(<TechnicalNav current="queues" />);
    expect(markup).toContain('aria-current="page"');
    expect(markup).toContain('/technical/queues');
  });
});

describe('TechnicalAccessNotice', () => {
  it('renders nothing when access is established', () => {
    expect(renderToStaticMarkup(<TechnicalAccessNotice status={null} />)).toBe('');
  });

  it('explains a 403 without leaking internal detail', () => {
    const markup = renderToStaticMarkup(<TechnicalAccessNotice status={403} />);
    expect(markup).toContain('does not have Technical Admin access');
  });

  it('points unauthenticated operators at sign-in', () => {
    const markup = renderToStaticMarkup(<TechnicalAccessNotice status={401} />);
    expect(markup).toContain('Sign in');
  });
});

describe('OverviewPanels', () => {
  it('renders application status and dependency probes', () => {
    const markup = renderToStaticMarkup(<OverviewPanels overview={overview} />);
    expect(markup).toContain('truevine-voice-api');
    expect(markup).toContain('postgres');
    expect(markup).toContain('redis');
  });

  it('names unmodelled domains instead of silently omitting them', () => {
    const markup = renderToStaticMarkup(<OverviewPanels overview={overview} />);
    expect(markup).toContain('voice_calls');
    expect(markup).toContain('log_storage');
  });

  it('marks subsystems as not_integrated rather than empty', () => {
    const markup = renderToStaticMarkup(<OverviewPanels overview={overview} />);
    expect(markup).toContain('not_integrated');
    expect(markup).toContain('not_configured');
  });
});

describe('ProvidersTable', () => {
  it('renders each provider with its integration status', () => {
    const markup = renderToStaticMarkup(
      <ProvidersTable
        providers={[
          { name: 'africas_talking_voice', status: 'not_integrated', detail: 'Interface only.' },
        ]}
      />,
    );
    expect(markup).toContain('africas_talking_voice');
    expect(markup).toContain('not_integrated');
  });

  it('reports no declared providers explicitly', () => {
    expect(renderToStaticMarkup(<ProvidersTable providers={[]} />)).toContain(
      'No providers are declared',
    );
  });
});

describe('QueuesPanel', () => {
  it('states the queue system is not integrated rather than showing an empty list', () => {
    const markup = renderToStaticMarkup(
      <QueuesPanel
        queues={{ status: 'not_integrated', queues: [], failedJobs: [], detail: 'No queues.' }}
      />,
    );
    expect(markup).toContain('not_integrated');
    expect(markup).toContain('No queues are registered');
    expect(markup).toContain('No failed jobs are reported');
  });
});

describe('LogsPanel', () => {
  it('states there is no queryable log rather than an empty one', () => {
    const markup = renderToStaticMarkup(
      <LogsPanel logs={{ status: 'not_configured', entries: [], detail: 'stdout only' }} />,
    );
    expect(markup).toContain('not_configured');
    expect(markup).toContain('missing capability');
  });
});

describe('TechnicalAuditTable', () => {
  it('renders the trail tag, actor identity and outcome', () => {
    const markup = renderToStaticMarkup(
      <TechnicalAuditTable
        events={[
          {
            id: 'evt-1',
            trail: 'identity',
            action: 'platform.technical.overview_viewed',
            outcome: 'SUCCESS',
            scope: null,
            targetType: null,
            targetId: null,
            occurredAt: '2026-10-20T00:00:00.000Z',
            actor: { userId: 'actor-1', email: 'technical@example.com' },
            metadata: {},
          },
        ]}
      />,
    );
    expect(markup).toContain('platform.technical.overview_viewed');
    expect(markup).toContain('technical@example.com');
    expect(markup).toContain('identity trail');
  });

  it('reports an empty trail explicitly', () => {
    expect(renderToStaticMarkup(<TechnicalAuditTable events={[]} />)).toContain(
      'No platform audit events',
    );
  });
});
