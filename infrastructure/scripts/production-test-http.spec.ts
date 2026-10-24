import { randomBytes, randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { ORGANIZATION_ROLE_PERMISSIONS, PLATFORM_ROLE_PERMISSIONS } from '@truevine/auth';
const modulePath = './production-test-http.mjs';
const rolloutPath = './production-test-rollout.mjs';
const { executePrivateHttp, privateHttpClient } = await import(modulePath);
const { INVENTORY_DIGEST, ROLLOUT_ACCOUNTS } = await import(rolloutPath);

function fixture() {
  const credentials = { version: 1, reference: 'CREDENTIALS-TEST', passwords: Object.fromEntries(ROLLOUT_ACCOUNTS.map(account => [account.email, randomBytes(24).toString('base64url')])) };
  const environment = { TEST_ACCOUNT_ROLLOUT_ENABLED: '1', NODE_ENV: 'test', APP_VERSION: 'a'.repeat(40), ROLLOUT_E2E_DISPOSABLE: '1',
    DATABASE_URL: 'postgresql://127.0.0.1/truevine_bootstrap_test_0123456789abcdef', WEB_PUBLIC_URL: 'http://127.0.0.1:3100' };
  const approval = { version: 1, action: 'http', environment: 'test', releaseSha: environment.APP_VERSION, provisioningReleaseSha: environment.APP_VERSION,
    operationId: randomUUID(), bootstrapOperationId: randomUUID(), provisionOperationId: randomUUID(), inventoryDigest: INVENTORY_DIGEST, credentialReference: 'CREDENTIALS-TEST',
    email: 'qa-platform-owner@truevoice.com', actorUserId: randomUUID(), preservedAdmin: { userId: randomUUID(), organizationId: randomUUID() },
    isolationOrganizationId: randomUUID(), isolationFixtureAuthorized: true,
    approvalReference: 'APPROVAL-TEST', operatorReference: 'OPERATOR-TEST', rehearsalReference: 'REHEARSAL-TEST',
    expiresAt: new Date(Date.now() + 3600000).toISOString(), httpAuthorized: true, applicationOrigin: environment.WEB_PUBLIC_URL,
    database: { hostname: '127.0.0.1', port: '5432', name: 'truevine_bootstrap_test_0123456789abcdef', systemIdentifier: '12345678901234567' } };
  const state = { organizationId: randomUUID(), isolationOrganizationId: randomUUID() };
  const inspect = vi.fn(async () => state);
  const sessions = new Map();
  const transport = vi.fn(async (input, options) => {
    const path = new URL(input).pathname;
    const cookie = options.headers.cookie ?? '';
    const sessionId = /(?:^|; )tv_session=([^;]+)/.exec(cookie)?.[1];
    const account = sessions.get(sessionId);
    const headers = new Headers();
    const response = (status, payload) => new Response(payload === undefined ? null : JSON.stringify(payload), { status, headers });
    if (path === '/health') return response(200, { version: approval.releaseSha, environment: approval.environment });
    if (path === '/api/auth/terms') { headers.append('set-cookie', `tv_csrf=${randomBytes(32).toString('base64url')}; Secure; SameSite=Lax; Path=/`); return response(200, { version: 'test' }); }
    if (path === '/api/auth/sign-in') {
      const body = JSON.parse(options.body);
      if (credentials.passwords[body.email] !== body.password) return response(401, { error: { code: 'invalid_credentials' } });
      const id = randomBytes(32).toString('base64url');
      sessions.set(id, ROLLOUT_ACCOUNTS.find(item => item.email === body.email));
      headers.append('set-cookie', `tv_session=${id}; Secure; HttpOnly; SameSite=Lax; Path=/`);
      return response(200, { ok: true });
    }
    if (!account) return response(401, { error: { code: 'session_revoked' } });
    if (path === '/api/auth/sign-out') { sessions.delete(sessionId); headers.append('set-cookie', 'tv_session=; Secure; HttpOnly; SameSite=Lax; Path=/'); return response(204); }
    if (path === '/api/me') return response(200, { email: account.email, termsAccepted: true,
      platformRole: account.scope === 'platform' ? account.role : null,
      memberships: account.scope === 'organization' ? [{ organizationId: state.organizationId, role: account.role, permissions: ORGANIZATION_ROLE_PERMISSIONS[account.role] }] : [] });
    const suffix = path.split(`/api/organizations/${state.organizationId}`)[1];
    const orgPermission = { '': 'organization:read', '/members': 'member:read', '/campaigns': 'campaign:read', '/reports/campaign-status': 'reporting:read', '/wallet': 'wallet:read', '/billing': 'billing:read' }[suffix];
    const platformPermission = { '/api/platform/operations/me': 'platform:operations:read', '/api/platform/support/me': 'platform:support:read', '/api/platform/technical/me': 'platform:technical:read', '/api/platform/audit/me': 'platform:audit:read' }[path];
    const allowed = account.scope === 'organization' ? Boolean(orgPermission && ORGANIZATION_ROLE_PERMISSIONS[account.role].includes(orgPermission)) : Boolean(platformPermission && PLATFORM_ROLE_PERMISSIONS[account.role].includes(platformPermission));
    return response(allowed ? 200 : 403, allowed ? {} : { error: { code: 'permission_denied' } });
  });
  return { approval, credentials, environment, state, inspect, transport, dependencies: { environment, inspect, transport } };
}

describe('private rollout HTTP verifier', () => {
  it('checks every identity through isolated cookie sessions, actual protocol contracts, permission probes and logout', async () => {
    const f = fixture();
    const result = await executePrivateHttp(f.approval, f.credentials, {}, f.dependencies);
    expect(result.accounts).toHaveLength(11);
    expect(result.accounts.every(account => account.httpSignIn === 'passed')).toBe(true);
    expect(f.transport.mock.calls.every(call => call[1].redirect === 'error')).toBe(true);
    expect(f.inspect).toHaveBeenCalledOnce();
  });
  it('rejects unapproved HTTP use before database or network access', async () => {
    const f = fixture(); f.approval.httpAuthorized = false;
    await expect(executePrivateHttp(f.approval, f.credentials, {}, f.dependencies)).rejects.toThrow();
    expect(f.inspect).not.toHaveBeenCalled(); expect(f.transport).not.toHaveBeenCalled();
  });
  it.each(['role', 'terms', 'platform-terms', 'wrong-denial', 'insecure-cookie', 'insecure-csrf', 'throttle', 'release-health'])('fails rather than reporting success for %s', async problem => {
    const f = fixture();
    const original = f.transport.getMockImplementation();
    f.transport.mockImplementation(async (url, options) => {
      const response = await original(url, options);
      const path = new URL(url).pathname;
      if (problem === 'insecure-csrf' && path === '/api/auth/terms') return new Response('{}', { headers: { 'set-cookie': 'tv_csrf=synthetic; Secure; HttpOnly; SameSite=Lax; Path=/' } });
      if (problem === 'release-health' && path === '/health') return new Response('{"version":"wrong","environment":"test"}');
      if (problem === 'throttle' && path === '/api/auth/sign-in') return new Response('{}', { status: 429 });
      if (problem === 'insecure-cookie' && path === '/api/auth/sign-in' && response.status === 200) {
        return new Response('{"ok":true}', { headers: { 'set-cookie': 'tv_session=synthetic; Path=/' } });
      }
      if (path === '/api/me' && response.status === 200 && ['role', 'terms', 'platform-terms'].includes(problem)) {
        const body = await response.json();
        if (problem === 'role') body.memberships[0].role = 'VIEWER';
        else if (problem === 'terms' || body.platformRole) body.termsAccepted = false;
        return new Response(JSON.stringify(body));
      }
      if (problem === 'wrong-denial' && response.status === 403) return new Response('{"error":{"code":"csrf_token_invalid"}}', { status: 403 });
      return response;
    });
    await expect(executePrivateHttp(f.approval, f.credentials, {}, f.dependencies)).rejects.toThrow();
  });
  it('refuses redirects and credential-bearing URL paths', async () => {
    const transport = vi.fn(async () => new Response(null, { status: 302, headers: { location: 'https://other.invalid' } }));
    const client = privateHttpClient('https://voice.truevinecloud.online', transport);
    await expect(client.call('GET', '/api/auth/terms')).rejects.toThrow();
    await expect(client.call('POST', '/api/auth/sign-in?password=not-allowed')).rejects.toThrow();
    expect(transport).toHaveBeenCalledOnce();
  });
  it('classifies TLS transport failures without exposing underlying details', async () => {
    const cause = Object.assign(new Error('private TLS detail'), { code: 'ERR_TLS_CERT_ALTNAME_INVALID' });
    const transport = vi.fn(async () => { throw Object.assign(new Error('private fetch detail'), { cause }); });
    const client = privateHttpClient('https://127.0.0.1', transport);
    let message = '';
    try { await client.call('GET', '/health'); } catch (error) { message = (error as Error).message; }
    expect(message).toContain('health:transport-tls');
    expect(message).not.toContain('private TLS detail');
    expect(message).not.toContain('private fetch detail');
  });
  it('classifies known Undici socket failures without exposing socket details', async () => {
    const cause = Object.assign(new Error('private socket detail'), { code: 'UND_ERR_SOCKET' });
    const transport = vi.fn(async () => { throw Object.assign(new Error('private fetch detail'), { cause }); });
    const client = privateHttpClient('https://127.0.0.1', transport);
    await expect(client.call('GET', '/health')).rejects.toThrow('health:transport-und_err_socket');
  });
  it('initializes only the approved owner through password-reset completion and reconciles its outcome', async () => {
    const f = fixture(); f.approval.action = 'initialize';
    f.inspect.mockResolvedValueOnce({ initialized: false }).mockResolvedValueOnce({ initialized: true });
    const raw = randomBytes(32).toString('base64url');
    const transport = vi.fn(async (url, options) => {
      if (new URL(url).pathname === '/health') return new Response(JSON.stringify({ version: f.approval.releaseSha, environment: f.approval.environment }));
      if (new URL(url).pathname === '/api/auth/terms') return new Response('{}', { headers: { 'set-cookie': 'tv_csrf=synthetic; Secure; SameSite=Lax; Path=/' } });
      const body = JSON.parse(options.body);
      expect(body.token === raw).toBe(true);
      expect(body.newPassword === f.credentials.passwords[f.approval.email]).toBe(true);
      return new Response('{"ok":true}');
    });
    const result = await executePrivateHttp(f.approval, f.credentials, { artifact: { activationUrl: `https://localhost/set-password?token=${raw}` } }, { ...f.dependencies, transport });
    expect(result.ownerInitialized).toBe(true); expect(f.inspect).toHaveBeenCalledTimes(2);
  });
});
