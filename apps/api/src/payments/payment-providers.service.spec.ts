import { HttpException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';

import { FakeAuditStore } from '../../test/fakes/auth.fakes.js';
import { FakePaymentProviderStore } from '../../test/fakes/payment-providers.fakes.js';
import { AesPaymentCredentialCipher } from './credential-cipher.js';
import { PaymentProvidersService } from './payment-providers.service.js';

const KEY = Buffer.alloc(32, 3).toString('base64');
const MTN = {
  subscriptionKey: 'subscription-value',
  apiUser: 'api-user-value',
  apiKey: 'api-key-value',
};
const AIRTEL = { clientId: 'client-id-value', clientSecret: 'client-secret-value' };
const CALLBACK = 'https://voice.example.test/webhooks/mtn';

function setup(cipher: AesPaymentCredentialCipher = new AesPaymentCredentialCipher(KEY)) {
  const store = new FakePaymentProviderStore();
  const audit = new FakeAuditStore();
  const service = new PaymentProvidersService(store, cipher, audit);
  return { store, audit, service };
}

async function expectHttpError(
  run: () => Promise<unknown>,
  status: number,
  code: string,
): Promise<void> {
  try {
    await run();
  } catch (error) {
    expect(error).toBeInstanceOf(HttpException);
    const exception = error as HttpException;
    expect(exception.getStatus()).toBe(status);
    expect((exception.getResponse() as { error?: { code?: string } }).error?.code).toBe(code);
    return;
  }
  throw new Error(`Expected ${status} ${code} but the call succeeded.`);
}

describe('PaymentProvidersService', () => {
  it('returns both providers and both environments with no configuration yet', async () => {
    const { service, audit } = setup();
    const view = await service.list('actor-1');

    expect(view.providers.map((entry) => entry.provider)).toEqual(['MTN_MOMO', 'AIRTEL_MONEY']);
    for (const provider of view.providers) {
      expect(provider.environments.map((entry) => entry.environment)).toEqual([
        'SANDBOX',
        'PRODUCTION',
      ]);
      for (const environment of provider.environments) {
        expect(environment.status).toBe('NOT_CONFIGURED');
        expect(environment.credentialsPresent).toBe(false);
        expect(environment.activationBlockedReason).toBe('credentials_required');
      }
    }
    expect(view.connectionTesting).toMatchObject({ available: false, code: 'not_available' });
    expect(audit.identityEvents.map((event) => event.action)).toEqual([
      'platform.payment_provider.configurations_viewed',
    ]);
  });

  it('refuses to save credentials when no encryption key is configured', async () => {
    const { service, store } = setup(new AesPaymentCredentialCipher(null));

    await expectHttpError(
      () => service.save('actor-1', 'MTN_MOMO', 'SANDBOX', { credentials: MTN }),
      503,
      'credential_encryption_unavailable',
    );
    expect(store.rows).toEqual([]);
  });

  it('rejects an unknown provider, environment or credential field', async () => {
    const { service } = setup();

    await expectHttpError(
      () => service.save('actor-1', 'STRIPE', 'SANDBOX', { credentials: MTN }),
      400,
      'invalid_provider',
    );
    await expectHttpError(
      () => service.save('actor-1', 'MTN_MOMO', 'STAGING', { credentials: MTN }),
      400,
      'invalid_environment',
    );
    await expectHttpError(
      () =>
        service.save('actor-1', 'MTN_MOMO', 'SANDBOX', {
          credentials: { ...MTN, surprise: 'value' },
        }),
      400,
      'invalid_credentials',
    );
    await expectHttpError(
      () =>
        service.save('actor-1', 'MTN_MOMO', 'SANDBOX', {
          credentials: { subscriptionKey: MTN.subscriptionKey, apiUser: MTN.apiUser },
        }),
      400,
      'invalid_credentials',
    );
    await expectHttpError(
      () =>
        service.save('actor-1', 'MTN_MOMO', 'SANDBOX', {
          credentials: { ...MTN, apiKey: 'bad\nkey' },
        }),
      400,
      'invalid_credentials',
    );
    await expectHttpError(
      () =>
        service.save('actor-1', 'MTN_MOMO', 'SANDBOX', {
          credentials: { ...MTN, apiKey: 'x'.repeat(257) },
        }),
      400,
      'invalid_credentials',
    );
  });

  it('accepts only an HTTPS callback URL with no credentials, query or fragment', async () => {
    for (const callbackUrl of [
      'http://voice.example.test/webhooks/mtn',
      'https://user:pass@voice.example.test/webhooks/mtn',
      'https://voice.example.test/webhooks/mtn?token=abc',
      'https://voice.example.test/webhooks/mtn#fragment',
      'https://voice.example.test/webhooks/mtn?',
      'https://voice.example.test/webhooks/mtn#',
      'not-a-url',
    ]) {
      const { service } = setup();
      await expectHttpError(
        () => service.save('actor-1', 'MTN_MOMO', 'SANDBOX', { credentials: MTN, callbackUrl }),
        400,
        'invalid_callback_url',
      );
    }
  });

  it('encrypts credentials at rest and never returns a secret', async () => {
    const { service, store } = setup();
    const result = await service.save('actor-1', 'MTN_MOMO', 'SANDBOX', {
      credentials: MTN,
      callbackUrl: CALLBACK,
    });

    const stored = store.rows[0]!;
    expect(stored.credentialsCiphertext).toBeTruthy();
    expect(stored.credentialsCiphertext).not.toContain('subscription-value');
    expect(stored.credentialsCiphertext).not.toContain('api-key-value');
    expect(stored.active).toBe(false);
    expect(stored.credentialFields).toEqual(['subscriptionKey', 'apiUser', 'apiKey']);

    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain('subscription-value');
    expect(serialized).not.toContain('api-user-value');
    expect(serialized).not.toContain('api-key-value');
    expect(result.configuration.credentialsPresent).toBe(true);
    expect(result.configuration.credentialFields.map((field) => field.present)).toEqual([
      true,
      true,
      true,
    ]);
  });

  it('does not activate a configuration just because credentials were saved', async () => {
    const { service, audit } = setup();
    const result = await service.save('actor-1', 'MTN_MOMO', 'PRODUCTION', {
      credentials: MTN,
      callbackUrl: CALLBACK,
    });

    expect(result.configuration.status).toBe('CONFIGURED');
    expect(result.configuration.active).toBe(false);
    expect(result.configuration.activatedAt).toBeNull();
    expect(audit.identityEvents).toEqual([]);
  });

  it('keeps sandbox and production credentials independent', async () => {
    const { service } = setup();
    await service.save('actor-1', 'MTN_MOMO', 'SANDBOX', {
      credentials: MTN,
      callbackUrl: CALLBACK,
    });

    const view = await service.list('actor-1');
    const mtn = view.providers.find((entry) => entry.provider === 'MTN_MOMO')!;
    expect(mtn.environments[0]!.status).toBe('CONFIGURED');
    expect(mtn.environments[1]!.status).toBe('NOT_CONFIGURED');
    expect(mtn.environments[1]!.credentialsPresent).toBe(false);

    const airtel = view.providers.find((entry) => entry.provider === 'AIRTEL_MONEY')!;
    for (const environment of airtel.environments) {
      expect(environment.status).toBe('NOT_CONFIGURED');
    }

    const production = await service.save('actor-1', 'MTN_MOMO', 'PRODUCTION', {
      credentials: {
        subscriptionKey: 'production-subscription',
        apiUser: 'production-user',
        apiKey: 'production-key',
      },
      callbackUrl: 'https://voice.example.test/webhooks/mtn/production',
    });
    expect(production.configuration.status).toBe('CONFIGURED');
    expect((await service.read('actor-1', 'MTN_MOMO', 'SANDBOX')).configuration.status).toBe(
      'CONFIGURED',
    );
  });

  it('requires credentials and a callback URL before activation', async () => {
    const { service } = setup();
    await expectHttpError(
      () => service.setActive('actor-1', 'AIRTEL_MONEY', 'SANDBOX', { active: true }),
      409,
      'not_configured',
    );

    await service.save('actor-1', 'AIRTEL_MONEY', 'SANDBOX', { credentials: AIRTEL });
    await expectHttpError(
      () => service.setActive('actor-1', 'AIRTEL_MONEY', 'SANDBOX', { active: true }),
      409,
      'callback_url_required',
    );

    await service.save('actor-1', 'AIRTEL_MONEY', 'SANDBOX', { callbackUrl: CALLBACK });
    const activated = await service.setActive('actor-1', 'AIRTEL_MONEY', 'SANDBOX', {
      active: true,
    });
    expect(activated.configuration).toMatchObject({ status: 'ACTIVE', active: true });
    expect(activated.configuration.activatedAt).not.toBeNull();
  });

  it('allows only one active environment per provider', async () => {
    const { service } = setup();
    await service.save('actor-1', 'MTN_MOMO', 'SANDBOX', {
      credentials: MTN,
      callbackUrl: CALLBACK,
    });
    await service.save('actor-1', 'MTN_MOMO', 'PRODUCTION', {
      credentials: MTN,
      callbackUrl: CALLBACK,
    });

    await service.setActive('actor-1', 'MTN_MOMO', 'SANDBOX', { active: true });
    await expectHttpError(
      () => service.setActive('actor-1', 'MTN_MOMO', 'PRODUCTION', { active: true }),
      409,
      'other_environment_active',
    );

    await service.setActive('actor-1', 'MTN_MOMO', 'SANDBOX', { active: false });
    const production = await service.setActive('actor-1', 'MTN_MOMO', 'PRODUCTION', {
      active: true,
    });
    expect(production.configuration.status).toBe('ACTIVE');
  });

  it('refuses credential changes on an active environment', async () => {
    const { service } = setup();
    await service.save('actor-1', 'MTN_MOMO', 'SANDBOX', {
      credentials: MTN,
      callbackUrl: CALLBACK,
    });
    await service.setActive('actor-1', 'MTN_MOMO', 'SANDBOX', { active: true });

    await expectHttpError(
      () => service.save('actor-1', 'MTN_MOMO', 'SANDBOX', { credentials: MTN }),
      409,
      'provider_active',
    );
  });

  it('records activation and deactivation without credential values', async () => {
    const { service, audit, store } = setup();
    await service.save('actor-1', 'AIRTEL_MONEY', 'SANDBOX', {
      credentials: AIRTEL,
      callbackUrl: CALLBACK,
    });
    await service.setActive('actor-1', 'AIRTEL_MONEY', 'SANDBOX', { active: true });
    await service.setActive('actor-1', 'AIRTEL_MONEY', 'SANDBOX', { active: false });

    expect(store.audits.map((entry) => entry.action)).toEqual([
      'platform.payment_provider.configured',
      'platform.payment_provider.activated',
      'platform.payment_provider.deactivated',
    ]);

    const serialized = JSON.stringify(store.audits);
    expect(serialized).not.toContain('client-id-value');
    expect(serialized).not.toContain('client-secret-value');
    expect(audit.identityEvents).toEqual([]);
  });

  it('reports a stored credential set it cannot decrypt instead of overwriting it', async () => {
    const store = new FakePaymentProviderStore();
    const audit = new FakeAuditStore();
    await new PaymentProvidersService(store, new AesPaymentCredentialCipher(KEY), audit).save(
      'actor-1',
      'MTN_MOMO',
      'SANDBOX',
      { credentials: MTN, callbackUrl: CALLBACK },
    );

    const otherKeyService = new PaymentProvidersService(
      store,
      new AesPaymentCredentialCipher(Buffer.alloc(32, 5).toString('base64')),
      audit,
    );
    await expectHttpError(
      () =>
        otherKeyService.save('actor-1', 'MTN_MOMO', 'SANDBOX', {
          credentials: { ...MTN, apiKey: 'new-key' },
        }),
      500,
      'credential_decryption_failed',
    );
  });

  it('reports a concurrent configuration change instead of overwriting it', async () => {
    const { service, store } = setup();
    await service.save('actor-1', 'MTN_MOMO', 'SANDBOX', {
      credentials: MTN,
      callbackUrl: CALLBACK,
    });

    // Another operator saved in between: the version this request read is stale.
    const current = store.rows[0]!;
    store.rows[0] = { ...current, version: 2 };
    vi.spyOn(store, 'find').mockResolvedValueOnce({ ...current, version: 1 });

    await expectHttpError(
      () => service.save('actor-1', 'MTN_MOMO', 'SANDBOX', { credentials: MTN }),
      409,
      'configuration_changed',
    );
  });
});
