import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import {
  ActivationControls,
  ConnectionTestingNotice,
  EnvironmentPanel,
  PaymentProvidersFailure,
  PaymentProvidersLoading,
  ProviderCard,
  buildSavePayload,
  callbackProblem,
  describeFailure,
  formatWhen,
  statusLabel,
  type ConnectionTestingView,
  type PaymentEnvironmentView,
  type PaymentProviderView,
} from './payments-ui';

const connectionTesting: ConnectionTestingView = {
  available: false,
  code: 'not_available',
  reason: 'No reviewed MTN or Airtel client is linked in this build.',
};

function anEnvironment(overrides: Partial<PaymentEnvironmentView> = {}): PaymentEnvironmentView {
  return {
    provider: 'MTN_MOMO',
    environment: 'SANDBOX',
    environmentLabel: 'Sandbox',
    status: 'NOT_CONFIGURED',
    active: false,
    configured: false,
    credentialsPresent: false,
    credentialFields: [
      { name: 'subscriptionKey', label: 'Subscription key', secret: true, present: false },
      { name: 'apiUser', label: 'API user', secret: true, present: false },
      { name: 'apiKey', label: 'API key', secret: true, present: false },
    ],
    callbackUrl: null,
    configuredAt: null,
    activatedAt: null,
    deactivatedAt: null,
    updatedAt: null,
    updatedBy: null,
    activationBlockedReason: 'credentials_required',
    ...overrides,
  };
}

const provider: PaymentProviderView = {
  provider: 'MTN_MOMO',
  displayName: 'MTN Mobile Money',
  detail: 'MTN MoMo Collections credentials.',
  environments: [
    anEnvironment(),
    anEnvironment({ environment: 'PRODUCTION', environmentLabel: 'Production' }),
  ],
};

const noop = () => undefined;

function panel(
  environment: PaymentEnvironmentView,
  extra: Partial<Parameters<typeof EnvironmentPanel>[0]> = {},
) {
  return renderToStaticMarkup(
    <EnvironmentPanel
      provider={provider}
      environment={environment}
      connectionTesting={connectionTesting}
      draft={{ credentials: {}, callbackUrl: environment.callbackUrl ?? '' }}
      busy={false}
      message={null}
      pending={null}
      onChangeCredential={noop}
      onChangeCallback={noop}
      onSave={noop}
      onRequestActivation={noop}
      onCancelActivation={noop}
      onConfirmActivation={noop}
      {...extra}
    />,
  );
}

describe('ConnectionTestingNotice', () => {
  it('states that connection testing is unavailable and why', () => {
    const markup = renderToStaticMarkup(
      <ConnectionTestingNotice connectionTesting={connectionTesting} />,
    );
    expect(markup).toContain('Test connection is unavailable');
    expect(markup).toContain('No reviewed MTN or Airtel client');
  });
});

describe('EnvironmentPanel', () => {
  it('renders labelled secret inputs, save, and a disabled test button with an explanation', () => {
    const markup = panel(anEnvironment());

    expect(markup).toContain('Subscription key');
    expect(markup).toContain('type="password"');
    expect(markup).toContain('autoComplete="new-password"');
    expect(markup).toContain('Save credentials');
    expect(markup).toContain('Test connection');
    expect(markup).toMatch(/Test connection<\/button>/);
    expect(markup).toContain('disabled');
    expect(markup).toContain('No reviewed MTN or Airtel client');
    expect(markup).toContain('aria-describedby');
  });

  it('marks a saved credential by presence without rendering a value', () => {
    const markup = panel(
      anEnvironment({
        status: 'CONFIGURED',
        configured: true,
        credentialsPresent: true,
        credentialFields: [
          { name: 'subscriptionKey', label: 'Subscription key', secret: true, present: true },
          { name: 'apiUser', label: 'API user', secret: true, present: true },
          { name: 'apiKey', label: 'API key', secret: true, present: false },
        ],
        activationBlockedReason: 'callback_url_required',
      }),
    );

    expect(markup).toContain('Saved');
    expect(markup).toContain('Configured');
    expect(markup).not.toContain('subscription-value');
    expect(markup).toContain('Save a callback URL before activating');
  });

  it('keeps the activation button disabled until credentials and callback are saved', () => {
    const markup = panel(anEnvironment());
    expect(markup).toMatch(/<button[^>]*disabled[^>]*>Activate<\/button>/);
    expect(markup).toContain('Save credentials and a callback URL before activating');
  });

  it('replaces the form with a deactivation path for an active environment', () => {
    const markup = panel(
      anEnvironment({
        status: 'ACTIVE',
        active: true,
        configured: true,
        credentialsPresent: true,
        callbackUrl: 'https://voice.example.test/webhooks/mtn',
        activatedAt: '2026-10-30T10:00:00.000Z',
        updatedAt: '2026-10-30T10:00:00.000Z',
        updatedBy: { userId: 'user-1', email: 'owner@truevine.test' },
        activationBlockedReason: null,
      }),
    );

    expect(markup).toContain('Active since 2026-10-30T10:00:00.000Z');
    expect(markup).toContain('Deactivate');
    expect(markup).toContain('Active credentials cannot be replaced');
    expect(markup).not.toContain('Save credentials');
  });

  it('renders an error message as an alert and a success message as status', () => {
    const error = panel(anEnvironment(), {
      message: { kind: 'error' as const, text: 'Some values were rejected.' },
    });
    expect(error).toContain('role="alert"');
    expect(error).toContain('Some values were rejected.');

    const success = panel(anEnvironment(), {
      message: { kind: 'success' as const, text: 'Credentials saved.' },
    });
    expect(success).toContain('role="status"');
    expect(success).toContain('Credentials saved.');
  });
});

describe('ActivationControls', () => {
  it('asks for confirmation before activating', () => {
    const markup = renderToStaticMarkup(
      <ActivationControls
        environment={anEnvironment({
          status: 'CONFIGURED',
          configured: true,
          credentialsPresent: true,
          callbackUrl: 'https://voice.example.test/webhooks/mtn',
          activationBlockedReason: null,
        })}
        pending="activate"
        busy={false}
        onRequest={noop}
        onCancel={noop}
        onConfirm={noop}
      />,
    );

    expect(markup).toContain('Activate Sandbox for this provider?');
    expect(markup).toContain('Only one environment can be active at a time.');
    expect(markup).toContain('Confirm activate');
    expect(markup).toContain('Cancel');
  });

  it('asks for confirmation before deactivating', () => {
    const markup = renderToStaticMarkup(
      <ActivationControls
        environment={anEnvironment({
          status: 'ACTIVE',
          active: true,
          activationBlockedReason: null,
        })}
        pending="deactivate"
        busy={false}
        onRequest={noop}
        onCancel={noop}
        onConfirm={noop}
      />,
    );

    expect(markup).toContain('Deactivate Sandbox for this provider?');
    expect(markup).toContain('Confirm deactivate');
  });
});

describe('buildSavePayload', () => {
  it('sends only filled credentials and leaves blank inputs alone', () => {
    expect(
      buildSavePayload(
        { credentials: { subscriptionKey: ' new-key ', apiUser: '   ' }, callbackUrl: '' },
        null,
      ),
    ).toEqual({ ok: true, body: { credentials: { subscriptionKey: 'new-key' } } });
  });

  it('sends a changed callback URL and a cleared one as null', () => {
    expect(
      buildSavePayload(
        { credentials: {}, callbackUrl: 'https://voice.example.test/hook' },
        'https://old.example.test/hook',
      ),
    ).toEqual({ ok: true, body: { callbackUrl: 'https://voice.example.test/hook' } });

    expect(
      buildSavePayload({ credentials: {}, callbackUrl: '' }, 'https://old.example.test/hook'),
    ).toEqual({ ok: true, body: { callbackUrl: null } });
  });

  it('refuses an empty submission instead of sending a no-op update', () => {
    const result = buildSavePayload({ credentials: { apiKey: '' }, callbackUrl: '' }, null);
    expect(result.ok).toBe(false);
  });

  it('refuses an invalid callback URL before sending it', () => {
    expect(
      buildSavePayload({ credentials: { apiKey: 'x' }, callbackUrl: 'http://insecure.test' }, null)
        .ok,
    ).toBe(false);
    expect(callbackProblem('https://voice.example.test/hook?token=x')).toContain('query');
    expect(callbackProblem('https://voice.example.test/hook#fragment')).toContain('fragment');
    expect(callbackProblem('https://voice.example.test/hook?')).toContain('query');
    expect(callbackProblem('https://voice.example.test/hook#')).toContain('fragment');
    expect(callbackProblem('https://user:pass@voice.example.test/hook')).toContain('password');
    expect(callbackProblem('https://voice.example.test/hook')).toBeNull();
    expect(callbackProblem('')).toBeNull();
  });
});

describe('describeFailure', () => {
  it.each([
    [401, 'session has expired'],
    [403, 'does not have payment configuration access'],
    [409, 'changed or an environment is already active'],
    [503, 'Credential encryption is not configured'],
    [500, 'did not complete'],
  ])('maps %s to a user-facing message', (status, fragment) => {
    expect(describeFailure(status)).toContain(fragment);
  });
});

describe('status helpers', () => {
  it('names the three states without inventing a fourth', () => {
    expect(statusLabel('ACTIVE')).toBe('Active');
    expect(statusLabel('CONFIGURED')).toBe('Configured, not active');
    expect(statusLabel('NOT_CONFIGURED')).toBe('Not configured');
  });

  it('shows a dash when a timestamp is absent', () => {
    expect(formatWhen(null)).toBe('—');
    expect(formatWhen('2026-10-30T10:00:00.000Z')).toBe('2026-10-30T10:00:00.000Z');
  });
});

describe('page states', () => {
  it('announces loading as a status', () => {
    expect(renderToStaticMarkup(<PaymentProvidersLoading />)).toContain(
      'Loading payment integrations',
    );
  });

  it('renders a failure without echoing internal detail', () => {
    const markup = renderToStaticMarkup(<PaymentProvidersFailure status={503} />);
    expect(markup).toContain('role="alert"');
    expect(markup).toContain('Credential encryption is not configured');
  });
});

describe('ProviderCard', () => {
  it('renders both environments for a provider, with no stored credential echoed', () => {
    const markup = renderToStaticMarkup(
      <ProviderCard provider={provider} connectionTesting={connectionTesting} onChanged={noop} />,
    );

    expect(markup).toContain('MTN Mobile Money');
    expect(markup).toContain('MTN_MOMO');
    expect(markup).toContain('Sandbox');
    expect(markup).toContain('Production');
    expect(markup.match(/Test connection/g)).toHaveLength(2);
    expect(markup).not.toContain('type="text"');
  });
});
