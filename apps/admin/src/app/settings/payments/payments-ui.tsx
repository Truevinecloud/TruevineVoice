'use client';

import { useEffect, useId, useState } from 'react';

import { api } from '../../../lib/api';

/**
 * Payment-provider configuration UI (MTN MoMo / Airtel Money).
 *
 * The page never sees a stored credential. The API returns field *presence*
 * only, so a saved value is represented by its label and "Saved" marker; the
 * inputs start blank and are treated as "replace this value" when filled.
 *
 * Connection testing is rendered disabled with the API's explanation. There is
 * no provider client in this build, and a button that claimed to test a
 * connection would be reporting something that did not happen.
 */

export type PaymentProviderName = 'MTN_MOMO' | 'AIRTEL_MONEY';
export type PaymentEnvironmentName = 'SANDBOX' | 'PRODUCTION';
export type PaymentProviderStatus = 'NOT_CONFIGURED' | 'CONFIGURED' | 'ACTIVE';
export type ActivationBlockedReason = 'credentials_required' | 'callback_url_required';

export type CredentialFieldView = {
  name: string;
  label: string;
  secret: boolean;
  present: boolean;
};

export type PaymentEnvironmentView = {
  provider: PaymentProviderName;
  environment: PaymentEnvironmentName;
  environmentLabel: string;
  status: PaymentProviderStatus;
  active: boolean;
  configured: boolean;
  credentialsPresent: boolean;
  credentialFields: CredentialFieldView[];
  callbackUrl: string | null;
  configuredAt: string | null;
  activatedAt: string | null;
  deactivatedAt: string | null;
  updatedAt: string | null;
  updatedBy: { userId: string; email: string } | null;
  activationBlockedReason: ActivationBlockedReason | null;
};

export type PaymentProviderView = {
  provider: PaymentProviderName;
  displayName: string;
  detail: string;
  environments: PaymentEnvironmentView[];
};

export type ConnectionTestingView = {
  available: boolean;
  code: string;
  reason: string;
};

export type PaymentProvidersView = {
  providers: PaymentProviderView[];
  connectionTesting: ConnectionTestingView;
};

export type Draft = {
  credentials: Record<string, string>;
  callbackUrl: string;
};

export type FormMessage = { kind: 'success' | 'error'; text: string };

export type PendingAction = 'activate' | 'deactivate';

export function environmentKey(
  provider: PaymentProviderName,
  environment: PaymentEnvironmentName,
): string {
  return `${provider}:${environment}`;
}

export function statusLabel(status: PaymentProviderStatus): string {
  if (status === 'ACTIVE') return 'Active';
  if (status === 'CONFIGURED') return 'Configured, not active';
  return 'Not configured';
}

export function formatWhen(value: string | null): string {
  return value ?? '—';
}

/** The same rules the API applies, checked before a request is sent. */
export function callbackProblem(value: string): string | null {
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return 'Enter a full HTTPS URL, for example https://voice.example.com/webhooks/mtn.';
  }
  if (url.protocol !== 'https:') return 'The callback URL must use HTTPS.';
  if (url.username.length > 0 || url.password.length > 0) {
    return 'The callback URL must not contain a username or password.';
  }
  // `href` rather than `search`/`hash`: a bare "?" or "#" has an empty
  // search/hash but the API and database reject it.
  if (url.href.includes('?') || url.href.includes('#')) {
    return 'The callback URL must not contain a query string or fragment.';
  }
  if (url.hostname.length === 0) return 'The callback URL must name a host.';
  if (trimmed.length > 512) return 'The callback URL must be at most 512 characters.';
  return null;
}

export type SavePayload =
  | {
      ok: true;
      body: {
        credentials?: Record<string, string>;
        callbackUrl?: string | null;
      };
    }
  | { ok: false; message: string };

/**
 * Builds the PUT body from a form draft.
 *
 * A blank credential input means "leave the saved value alone", not "clear it":
 * otherwise a partially filled form would silently erase a working secret. The
 * callback URL is only sent when it actually changed.
 */
export function buildSavePayload(draft: Draft, savedCallbackUrl: string | null): SavePayload {
  const credentials: Record<string, string> = {};
  for (const [name, value] of Object.entries(draft.credentials)) {
    if (value.trim().length > 0) credentials[name] = value.trim();
  }

  const callbackChanged = draft.callbackUrl.trim() !== (savedCallbackUrl ?? '');
  if (callbackChanged) {
    const problem = callbackProblem(draft.callbackUrl);
    if (problem) return { ok: false, message: problem };
  }

  if (Object.keys(credentials).length === 0 && !callbackChanged) {
    return {
      ok: false,
      message: 'Enter at least one credential value or change the callback URL.',
    };
  }

  const body: { credentials?: Record<string, string>; callbackUrl?: string | null } = {};
  if (Object.keys(credentials).length > 0) body.credentials = credentials;
  if (callbackChanged)
    body.callbackUrl = draft.callbackUrl.trim() === '' ? null : draft.callbackUrl.trim();
  return { ok: true, body };
}

/** A user-facing explanation for a failed request, without echoing upstream detail. */
export function describeFailure(status: number): string {
  if (status === 401) return 'Your session has expired. Sign in again.';
  if (status === 403) return 'This account does not have payment configuration access.';
  if (status === 409) {
    return 'The configuration changed or an environment is already active. Reload the page and try again.';
  }
  if (status === 503) {
    return 'Credential encryption is not configured on the server. No change was made.';
  }
  if (status === 400) return 'Some values were rejected. Check the fields and try again.';
  return 'The request did not complete. No change was confirmed.';
}

export function PaymentProvidersLoading() {
  return (
    <p className="notice" role="status">
      Loading payment integrations…
    </p>
  );
}

export function PaymentProvidersFailure({ status }: { status: number }) {
  return (
    <p className={`notice ${status === 400 ? 'form-error' : ''}`} role="alert">
      {describeFailure(status)}
    </p>
  );
}

export function ConnectionTestingNotice({
  connectionTesting,
}: {
  connectionTesting: ConnectionTestingView;
}) {
  if (connectionTesting.available) {
    return (
      <p className="notice" role="status">
        Connection testing is available.
      </p>
    );
  }
  return (
    <p className="notice" id="connection-testing-unavailable" role="status">
      <strong>Test connection is unavailable.</strong> {connectionTesting.reason}
    </p>
  );
}

export function ActivationControls({
  environment,
  pending,
  busy,
  onRequest,
  onCancel,
  onConfirm,
}: {
  environment: PaymentEnvironmentView;
  pending: PendingAction | null;
  busy: boolean;
  onRequest: (action: PendingAction) => void;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const confirmationId = useId();

  if (pending) {
    const verb = pending === 'activate' ? 'Activate' : 'Deactivate';
    return (
      <div className="inline-confirm" role="group" aria-labelledby={confirmationId}>
        <p id={confirmationId}>
          {verb} {environment.environmentLabel} for this provider?{' '}
          {pending === 'activate'
            ? 'Only one environment can be active at a time.'
            : 'Payment traffic will stop using these credentials.'}
        </p>
        <div className="button-row">
          <button type="button" className="danger-button" disabled={busy} onClick={onConfirm}>
            {busy ? 'Working…' : `Confirm ${verb.toLowerCase()}`}
          </button>
          <button type="button" className="quiet-button" disabled={busy} onClick={onCancel}>
            Cancel
          </button>
        </div>
      </div>
    );
  }

  if (environment.active) {
    return (
      <div className="button-row">
        <p className="footnote">
          Active since {formatWhen(environment.activatedAt)}. Deactivate before changing
          credentials.
        </p>
        <button
          type="button"
          className="danger-button"
          disabled={busy}
          onClick={() => onRequest('deactivate')}
        >
          Deactivate
        </button>
      </div>
    );
  }

  const blocked =
    environment.activationBlockedReason === 'credentials_required'
      ? 'Save credentials and a callback URL before activating.'
      : environment.activationBlockedReason === 'callback_url_required'
        ? 'Save a callback URL before activating.'
        : null;

  return (
    <div className="button-row">
      <button
        type="button"
        disabled={busy || blocked !== null}
        aria-describedby={blocked ? `${confirmationId}-blocked` : undefined}
        onClick={() => onRequest('activate')}
      >
        Activate
      </button>
      {blocked && (
        <p className="footnote" id={`${confirmationId}-blocked`}>
          {blocked}
        </p>
      )}
    </div>
  );
}

export function EnvironmentPanel({
  provider,
  environment,
  connectionTesting,
  draft,
  busy,
  message,
  pending,
  onChangeCredential,
  onChangeCallback,
  onSave,
  onRequestActivation,
  onCancelActivation,
  onConfirmActivation,
}: {
  provider: PaymentProviderView;
  environment: PaymentEnvironmentView;
  connectionTesting: ConnectionTestingView;
  draft: Draft;
  busy: boolean;
  message: FormMessage | null;
  pending: PendingAction | null;
  onChangeCredential: (name: string, value: string) => void;
  onChangeCallback: (value: string) => void;
  onSave: () => void;
  onRequestActivation: (action: PendingAction) => void;
  onCancelActivation: () => void;
  onConfirmActivation: () => void;
}) {
  const id = environmentKey(provider.provider, environment.environment);
  const helpId = `${id}-test-reason`;

  return (
    <section className="payment-environment" aria-labelledby={`${id}-heading`}>
      <div className="section-heading">
        <h3 id={`${id}-heading`}>{environment.environmentLabel}</h3>
        <span className={`status status-${environment.status.toLowerCase()}`}>
          {statusLabel(environment.status)}
        </span>
      </div>

      <dl className="kv-grid payment-meta">
        <div className="kv">
          <dt>Credentials</dt>
          <dd>{environment.credentialsPresent ? 'Configured' : 'Not configured'}</dd>
        </div>
        <div className="kv">
          <dt>Last updated</dt>
          <dd>{formatWhen(environment.updatedAt)}</dd>
        </div>
        <div className="kv">
          <dt>Updated by</dt>
          <dd>{environment.updatedBy?.email ?? '—'}</dd>
        </div>
        <div className="kv">
          <dt>Callback URL</dt>
          <dd>{environment.callbackUrl ?? 'Not set'}</dd>
        </div>
      </dl>

      {environment.active ? (
        <p className="footnote">
          Active credentials cannot be replaced. Deactivate this environment first.
        </p>
      ) : (
        <form
          className="credential-form"
          onSubmit={(event) => {
            event.preventDefault();
            onSave();
          }}
        >
          {environment.credentialFields.map((field) => (
            <label key={field.name} htmlFor={`${id}-${field.name}`}>
              <span>
                {field.label}
                {field.present && <small className="presence"> · Saved</small>}
              </span>
              <input
                id={`${id}-${field.name}`}
                name={field.name}
                type={field.secret ? 'password' : 'text'}
                autoComplete="new-password"
                spellCheck={false}
                value={draft.credentials[field.name] ?? ''}
                onChange={(event) => onChangeCredential(field.name, event.target.value)}
                placeholder={field.present ? 'Replace saved value' : 'Required'}
                disabled={busy}
              />
            </label>
          ))}

          <label htmlFor={`${id}-callback`}>
            <span>Callback URL</span>
            <input
              id={`${id}-callback`}
              name="callbackUrl"
              type="url"
              inputMode="url"
              value={draft.callbackUrl}
              onChange={(event) => onChangeCallback(event.target.value)}
              placeholder="https://voice.example.com/webhooks/provider"
              disabled={busy}
              aria-describedby={`${id}-callback-help`}
            />
            <small id={`${id}-callback-help`} className="footnote">
              HTTPS only; no query string or fragment.
            </small>
          </label>

          <div className="button-row">
            <button type="submit" disabled={busy}>
              {busy ? 'Saving…' : 'Save credentials'}
            </button>
            <button
              type="button"
              className="quiet-button"
              disabled
              aria-describedby={helpId}
              title={connectionTesting.reason}
            >
              Test connection
            </button>
          </div>
          <p className="footnote" id={helpId}>
            {connectionTesting.available
              ? 'Connection testing is available.'
              : connectionTesting.reason}
          </p>
          {message && (
            <p
              className={message.kind === 'error' ? 'form-error' : 'form-success'}
              role={message.kind === 'error' ? 'alert' : 'status'}
              aria-live="polite"
            >
              {message.text}
            </p>
          )}
        </form>
      )}

      {environment.active && message && (
        <p
          className={message.kind === 'error' ? 'form-error' : 'form-success'}
          role={message.kind === 'error' ? 'alert' : 'status'}
          aria-live="polite"
        >
          {message.text}
        </p>
      )}

      <ActivationControls
        environment={environment}
        pending={pending}
        busy={busy}
        onRequest={onRequestActivation}
        onCancel={onCancelActivation}
        onConfirm={onConfirmActivation}
      />
    </section>
  );
}

function initialDrafts(provider: PaymentProviderView): Record<string, Draft> {
  const drafts: Record<string, Draft> = {};
  for (const environment of provider.environments) {
    drafts[environmentKey(provider.provider, environment.environment)] = {
      credentials: {},
      callbackUrl: environment.callbackUrl ?? '',
    };
  }
  return drafts;
}

/** One provider card with an independent state machine per environment. */
export function ProviderCard({
  provider,
  connectionTesting,
  onChanged,
}: {
  provider: PaymentProviderView;
  connectionTesting: ConnectionTestingView;
  onChanged: () => void;
}) {
  const [drafts, setDrafts] = useState<Record<string, Draft>>(() => initialDrafts(provider));
  const [busy, setBusy] = useState<string | null>(null);
  const [pending, setPending] = useState<Record<string, PendingAction | null>>({});
  const [messages, setMessages] = useState<Record<string, FormMessage | null>>({});

  // A refreshed view is the source of truth again: discard stale drafts rather
  // than letting an old callback URL linger after a successful save elsewhere.
  // Messages are deliberately kept: clearing them here would erase the success
  // or error the operator just triggered by refreshing the view.
  useEffect(() => {
    setDrafts(initialDrafts(provider));
    setPending({});
  }, [provider]);

  function updateDraft(key: string, change: (draft: Draft) => Draft) {
    setDrafts((current) => ({
      ...current,
      [key]: change(current[key] ?? { credentials: {}, callbackUrl: '' }),
    }));
  }

  async function save(environment: PaymentEnvironmentView) {
    const key = environmentKey(provider.provider, environment.environment);
    const draft = drafts[key] ?? { credentials: {}, callbackUrl: '' };
    const payload = buildSavePayload(draft, environment.callbackUrl);
    if (!payload.ok) {
      setMessages((current) => ({ ...current, [key]: { kind: 'error', text: payload.message } }));
      return;
    }

    setBusy(key);
    setMessages((current) => ({ ...current, [key]: null }));
    try {
      await api(
        `/platform/payments/providers/${provider.provider}/environments/${environment.environment}`,
        { method: 'PUT', body: JSON.stringify(payload.body) },
      );
      setMessages((current) => ({
        ...current,
        [key]: {
          kind: 'success',
          text: 'Credentials saved. The environment is not active until you activate it.',
        },
      }));
      onChanged();
    } catch (error) {
      setMessages((current) => ({
        ...current,
        [key]: {
          kind: 'error',
          text: describeFailure((error as { status?: number }).status ?? 500),
        },
      }));
    } finally {
      setBusy(null);
    }
  }

  async function applyActivation(environment: PaymentEnvironmentView) {
    const key = environmentKey(provider.provider, environment.environment);
    const action = pending[key];
    if (!action) return;

    setBusy(key);
    setPending((current) => ({ ...current, [key]: null }));
    setMessages((current) => ({ ...current, [key]: null }));
    try {
      await api(
        `/platform/payments/providers/${provider.provider}/environments/${environment.environment}/activation`,
        { method: 'PUT', body: JSON.stringify({ active: action === 'activate' }) },
      );
      setMessages((current) => ({
        ...current,
        [key]: {
          kind: 'success',
          text:
            action === 'activate'
              ? `${environment.environmentLabel} activated.`
              : `${environment.environmentLabel} deactivated.`,
        },
      }));
      onChanged();
    } catch (error) {
      setMessages((current) => ({
        ...current,
        [key]: {
          kind: 'error',
          text: describeFailure((error as { status?: number }).status ?? 500),
        },
      }));
    } finally {
      setBusy(null);
    }
  }

  return (
    <section className="card payment-card" aria-labelledby={`${provider.provider}-heading`}>
      <div className="section-heading">
        <div>
          <h2 id={`${provider.provider}-heading`}>{provider.displayName}</h2>
          <p className="footnote">{provider.detail}</p>
        </div>
        <code>{provider.provider}</code>
      </div>
      <div className="payment-environments">
        {provider.environments.map((environment) => {
          const key = environmentKey(provider.provider, environment.environment);
          return (
            <EnvironmentPanel
              key={key}
              provider={provider}
              environment={environment}
              connectionTesting={connectionTesting}
              draft={drafts[key] ?? { credentials: {}, callbackUrl: '' }}
              busy={busy === key}
              message={messages[key] ?? null}
              pending={pending[key] ?? null}
              onChangeCredential={(name, value) =>
                updateDraft(key, (draft) => ({
                  ...draft,
                  credentials: { ...draft.credentials, [name]: value },
                }))
              }
              onChangeCallback={(value) =>
                updateDraft(key, (draft) => ({ ...draft, callbackUrl: value }))
              }
              onSave={() => void save(environment)}
              onRequestActivation={(action) =>
                setPending((current) => ({ ...current, [key]: action }))
              }
              onCancelActivation={() => setPending((current) => ({ ...current, [key]: null }))}
              onConfirmActivation={() => void applyActivation(environment)}
            />
          );
        })}
      </div>
    </section>
  );
}
