'use client';

import { useEffect, useRef, useState, type FormEvent } from 'react';

import { api } from '../../../lib/api';
import { SettingsHeader, SettingsNav } from '../settings-ui';

type Environment = 'SANDBOX' | 'PRODUCTION';
type Configuration = {
  environment: Environment;
  username: string;
  voiceNumber: string;
  enabled: boolean;
  keyPresent: boolean;
  checkedAt: string | null;
  checkResult: 'verified' | 'rejected' | 'unavailable' | null;
};

export default function VoiceProvidersPage() {
  const [environment, setEnvironment] = useState<Environment>('SANDBOX');
  const [configurations, setConfigurations] = useState<Configuration[]>([]);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const secret = useRef<HTMLInputElement>(null);
  const configuration = configurations.find((item) => item.environment === environment);

  useEffect(() => {
    let disposed = false;
    void api<Configuration[]>('/platform/voice-providers').then(
      (data) => { if (!disposed) setConfigurations(data); },
      () => { if (!disposed) setMessage('Voice settings could not be loaded. Platform Owner access is required.'); },
    );
    return () => { disposed = true; };
  }, []);

  async function update(suffix: string, body?: object, successMessage = 'Provider status updated.') {
    setBusy(true);
    setMessage('');
    try {
      const result = await api<Configuration>(`/platform/voice-providers/${environment}${suffix}`, {
        method: 'PUT',
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      setConfigurations((current) => current.map((item) => item.environment === result.environment ? result : item));
      setMessage(successMessage);
    } catch {
      setMessage('The request failed. Check your access and configuration, then try again.');
    } finally {
      setBusy(false);
    }
  }

  function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const apiKey = secret.current?.value;
    if (secret.current) secret.current.value = '';
    void update('', {
      username: data.get('username'),
      voiceNumber: data.get('voiceNumber'),
      ...(apiKey ? { apiKey } : {}),
    }, apiKey
      ? 'API key saved. The field was cleared for safety; leave it blank to keep this key.'
      : 'Provider status updated.');
  }

  return (
    <main>
      <SettingsHeader title="Voice Providers" />
      <SettingsNav current="voice-providers" />
      <section className="card">
        <h2>Africa’s Talking</h2>
        <label>
          Environment
          <select value={environment} disabled={busy} onChange={(event) => {
            setEnvironment(event.target.value === 'PRODUCTION' ? 'PRODUCTION' : 'SANDBOX');
            setMessage('');
          }}>
            <option value="SANDBOX">Sandbox</option>
            <option value="PRODUCTION">Production</option>
          </select>
        </label>
        {configuration && (
          <>
            <p>{configuration.enabled ? 'Enabled' : configuration.keyPresent ? 'Configured, disabled' : 'Not configured'}</p>
            <form key={environment} onSubmit={save}>
              <fieldset disabled={busy}>
                <label>Application username
                  <input name="username" defaultValue={configuration.username || (environment === 'SANDBOX' ? 'sandbox' : '')} required maxLength={128} />
                </label>
                <label>Provider-issued voice number {environment === 'SANDBOX' && '(optional for credential check)'}
                  <input name="voiceNumber" type="tel" defaultValue={configuration.voiceNumber} placeholder="+256…" required={environment === 'PRODUCTION'} maxLength={16} />
                </label>
                <label>{configuration.keyPresent ? 'Replace API key' : 'API key'}
                  <input ref={secret} type="password" autoComplete="new-password" required={!configuration.keyPresent} maxLength={512} />
                </label>
                {configuration.keyPresent && <p>API key saved. Leave the replacement field blank to keep it.</p>}
                <button className="primary-button" type="submit">Save configuration</button>
              </fieldset>
            </form>
            <p>
              Application credentials: {configuration.checkResult ?? 'untested'}
              {configuration.checkedAt && <> · <time dateTime={configuration.checkedAt}>{new Date(configuration.checkedAt).toLocaleString()}</time></>}
            </p>
            <button className="quiet-button" disabled={busy || !configuration.keyPresent} onClick={() => void update('/connection')}>Test Connection</button>
            <button className="quiet-button" disabled={busy || (!configuration.enabled && configuration.checkResult !== 'verified')}
              onClick={() => void update('/activation', { enabled: !configuration.enabled })}>
              {configuration.enabled ? 'Deactivate' : 'Activate'}
            </button>
          </>
        )}
        <p>Test Connection checks application credentials. Voice routing and outbound dispatch are unavailable in this release.</p>
        <p>Callback and events URLs will be listed here when HTTPS callback handling is available.</p>
        {message && <p role="status">{message}</p>}
      </section>
    </main>
  );
}
