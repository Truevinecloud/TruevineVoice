import { describe, expect, it, vi } from 'vitest';

import { hashPassword, verifyPassword } from '@truevine/auth/passwords';

import {
  ACCOUNT_EMAIL,
  APPROVAL_FLAG,
  AUDIT_ACTION,
  ROLE,
  assertLocalAdminProxyUrl,
  generateOwnerPassword,
  grantLocalPlatformOwner,
  parseArguments,
  validateTarget,
} from './grant-local-platform-owner.mjs';

const approval = Object.freeze({
  approved: true as const,
  approvalReference: 'LOCAL-OWNER-AUTHORIZED-20261119',
  operatorReference: 'OPENCODE-LOCAL-OPERATOR',
});

const environment = Object.freeze({
  NODE_ENV: 'development',
  LOCAL_QA_PROVISIONING_ENABLED: 'true',
  DATABASE_URL: 'postgresql://truevine:truevine@localhost:55600/truevine_voice?schema=public',
});

interface FakeResponse {
  readonly ok: boolean;
  readonly status: number;
  readonly headers: { getSetCookie(): string[] };
  text(): Promise<string>;
}

function response(status: number, cookies: string[] = []): FakeResponse {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { getSetCookie: () => cookies },
    text: async () => '{}',
  };
}

function fakeFetch() {
  return vi.fn(async (url: string, init: { method?: string; headers: Record<string, string> }) => {
    if (url.endsWith('/auth/terms')) return response(200, ['tv_csrf=csrf-value; Path=/']);
    if (url.endsWith('/auth/sign-in')) {
      expect(init.headers['x-truevine-csrf']).toBe('csrf-value');
      return response(200, ['tv_session=session-value; Path=/']);
    }
    if (url.endsWith('/auth/terms/accept')) return response(204);
    if (url.endsWith('/platform/payments/me')) {
      expect(url).toBe('http://localhost:3002/admin/api/platform/payments/me');
      expect(init.headers['cookie']).toContain('tv_session=session-value');
      return response(200);
    }
    throw new Error(`Unexpected request: ${url}`);
  });
}

interface FakeDatabase {
  user: { findUnique: ReturnType<typeof vi.fn>; create: ReturnType<typeof vi.fn> };
  platformRoleAssignment: { create: ReturnType<typeof vi.fn> };
  identityAuditEvent: { create: ReturnType<typeof vi.fn> };
  $queryRaw: ReturnType<typeof vi.fn>;
  $transaction: (work: (tx: unknown) => Promise<unknown>) => Promise<unknown>;
  $disconnect: ReturnType<typeof vi.fn>;
}

function fakeDatabase(existing: { passwordHash: string } | null = null): FakeDatabase {
  let user = existing
    ? { id: 'existing-user', email: ACCOUNT_EMAIL, status: 'ACTIVE', passwordHash: existing.passwordHash,
        platformRole: { role: ROLE, revokedAt: null } }
    : null;
  const database = {
    user: {
      findUnique: vi.fn(async () => user),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        user = { id: data['id'], email: data['email'], status: data['status'],
          passwordHash: data['passwordHash'], platformRole: { role: ROLE, revokedAt: null } };
      }),
    },
    platformRoleAssignment: { create: vi.fn(async () => undefined) },
    identityAuditEvent: { create: vi.fn(async () => undefined) },
    $queryRaw: vi.fn(async () => [{ name: 'truevine_voice' }]),
    $transaction: async (work: (tx: unknown) => Promise<unknown>) => work(database),
    $disconnect: vi.fn(async () => undefined),
  };
  return database;
}

describe('grant-local-platform-owner arguments', () => {
  it('requires the explicit approval flag and both references', () => {
    expect(() => parseArguments([])).toThrow(/approval/i);
    expect(() => parseArguments([APPROVAL_FLAG])).toThrow(/reference/i);
    expect(parseArguments([
      APPROVAL_FLAG, '--approval-reference', 'LOCAL-APPROVED-1',
      '--operator-reference', 'LOCAL-OPERATOR-1',
    ])).toMatchObject({ approved: true, approvalReference: 'LOCAL-APPROVED-1' });
  });
});

describe('grant-local-platform-owner verification target', () => {
  it('accepts only the loopback admin proxy', () => {
    expect(() => assertLocalAdminProxyUrl('http://localhost:3002/admin/api')).not.toThrow();
    expect(() => assertLocalAdminProxyUrl('http://localhost:3000/api')).toThrow();
    expect(() => assertLocalAdminProxyUrl('https://localhost:3002/admin/api')).toThrow();
  });
});

describe('grant-local-platform-owner target', () => {
  it('accepts only the local development database', () => {
    expect(validateTarget(environment)).toEqual({ name: 'truevine_voice' });
    expect(() => validateTarget({ ...environment, NODE_ENV: 'production' })).toThrow();
    expect(() => validateTarget({ ...environment, LOCAL_QA_PROVISIONING_ENABLED: undefined })).toThrow();
    expect(() => validateTarget({ ...environment, DATABASE_URL: 'postgresql://db/other?schema=public' })).toThrow();
    expect(() => validateTarget({ ...environment, DATABASE_URL: 'postgresql://db/truevine_voice?sslmode=require' })).toThrow();
  });
});

describe('grant-local-platform-owner password', () => {
  it('generates unique policy-valid values', async () => {
    const taken = generateOwnerPassword();
    const fresh = generateOwnerPassword([taken]);
    expect(fresh).not.toBe(taken);
    expect(await verifyPassword(await hashPassword(fresh), fresh)).toBe(true);
  });
});

describe('grantLocalPlatformOwner', () => {
  it('creates and verifies a platform owner with an audit record', async () => {
    const database = fakeDatabase();
    const store: Record<string, unknown> = {};
    const result = await grantLocalPlatformOwner(
      { approval, baseUrl: 'http://localhost:3000/api' },
      {
        environment,
        fetchImpl: fakeFetch(),
        createDatabaseClient: () => database,
        hashPassword,
        readCredentials: () => store,
        writeCredentials: (records: Record<string, unknown>) => Object.assign(store, records),
      },
    );
    expect(result).toMatchObject({ status: 'created', role: ROLE, loginVerified: true, settingsVerified: true });
    expect(database.platformRoleAssignment.create).toHaveBeenCalledOnce();
    expect(database.identityAuditEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: AUDIT_ACTION,
        metadata: expect.objectContaining({ approvalReference: approval.approvalReference, role: ROLE }),
      }),
    });
    expect(Object.keys(store)).toContain(ACCOUNT_EMAIL);
  });

  it('verifies an existing account without changing it', async () => {
    const password = generateOwnerPassword();
    const database = fakeDatabase({ passwordHash: await hashPassword(password) });
    const store = { [ACCOUNT_EMAIL]: { password } };
    const write = vi.fn();
    const result = await grantLocalPlatformOwner(
      { approval, baseUrl: 'http://localhost:3000/api' },
      {
        environment,
        fetchImpl: fakeFetch(),
        createDatabaseClient: () => database,
        hashPassword,
        readCredentials: () => store,
        writeCredentials: write,
      },
    );
    expect(result.status).toBe('unchanged');
    expect(database.user.create).not.toHaveBeenCalled();
    expect(database.platformRoleAssignment.create).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
  });
});
