import { describe, expect, it } from 'vitest';

import { assertStagingProvisioningEnvironment } from './provision-operations-admin-uat.mjs';

describe('Operations Admin UAT provisioning guard', () => {
  const ciEnvironment = {
    NODE_ENV: 'staging',
    UAT_PROVISIONING_ENABLED: '1',
    GITHUB_ACTIONS: 'true',
  };

  it('allows only the isolated CI UAT database on the loopback test port', () => {
    expect(
      assertStagingProvisioningEnvironment(
        ciEnvironment,
        'postgresql://truevine:truevine@localhost:55432/truevine_uat_provisioning?schema=public',
      ),
    ).toEqual({ databaseName: 'truevine_uat_provisioning', host: 'localhost' });
  });

  it('refuses production and ordinary local development databases', () => {
    expect(() =>
      assertStagingProvisioningEnvironment(
        ciEnvironment,
        'postgresql://user:pass@db.example/truevine_production',
      ),
    ).toThrow(/allowlist|production/i);
    expect(() =>
      assertStagingProvisioningEnvironment(
        ciEnvironment,
        'postgresql://truevine:truevine@localhost:55432/truevine_voice',
      ),
    ).toThrow(/allowlist/);
  });

  it('requires explicit staging opt-in', () => {
    expect(() =>
      assertStagingProvisioningEnvironment(
        { NODE_ENV: 'production', UAT_PROVISIONING_ENABLED: '1' },
        'postgresql://staging-db/truevine_staging',
      ),
    ).toThrow(/NODE_ENV=staging/);
  });
});
