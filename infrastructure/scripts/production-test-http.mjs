import { randomBytes } from 'node:crypto';
import { ORGANIZATION_ROLE_PERMISSIONS, PLATFORM_ROLE_PERMISSIONS } from '@truevine/auth';
import { executeRollout, ROLLOUT_ACCOUNTS, validateRollout } from './production-test-rollout.mjs';

const assert = (condition, context = '') => { if (!condition) throw new Error(`Private HTTP verification failed${context ? ` (${context})` : ''}; no secrets reported.`); };

/** Native fetch verifies TLS by default. Redirects, timeouts and unexpected
 * responses fail closed. Cookies/body data never leave this private client. */
export function privateHttpClient(origin, transport = fetch, controls = {}) {
  const jar = new Map();
  let sessionAttributes = false;
  async function call(method, path, body) {
    assert((path === '/health' || path.startsWith('/api/')) && !path.includes('?') && !path.includes('#'));
    if (controls.expiresAt) assert(Date.parse(controls.expiresAt) > Date.now());
    if (controls.intervalMs) await new Promise(resolve => setTimeout(resolve, controls.intervalMs));
    if (controls.expiresAt) assert(Date.parse(controls.expiresAt) > Date.now());
    const headers = { 'content-type': 'application/json', origin };
    if (jar.size) headers.cookie = [...jar].map(([key, value]) => `${key}=${value}`).join('; ');
    if (method !== 'GET' && jar.get('tv_csrf')) headers['x-truevine-csrf'] = jar.get('tv_csrf');
    const route = path === '/health' ? 'health' : path === '/api/auth/terms' ? 'terms'
      : path === '/api/auth/sign-in' ? 'sign-in' : path === '/api/auth/sign-out' ? 'sign-out'
        : path === '/api/auth/password-reset/complete' ? 'password-reset' : 'authorization';
    let response;
    try {
      response = await transport(`${origin}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body),
        redirect: 'error', signal: AbortSignal.timeout(15000) });
    } catch (error) {
      const codes = [];
      for (let current = error, depth = 0; current && depth < 5; current = current.cause, depth++)
        if (typeof current.code === 'string') codes.push(current.code);
      const undiciCode = codes.find(code => ['UND_ERR_SOCKET', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT',
        'UND_ERR_BODY_TIMEOUT', 'UND_ERR_ABORTED'].includes(code));
      const kind = codes.some(code => /^(?:ERR_TLS|ERR_SSL|CERT_|SELF_SIGNED|UNABLE_TO_VERIFY|UNABLE_TO_GET_ISSUER)/.test(code)) ? 'tls'
        : codes.some(code => /^(?:ECONN|ETIMEDOUT|EHOST|ENET|EAI_)/.test(code)) ? 'network'
          : undiciCode ? undiciCode.toLowerCase() : 'unknown';
      throw new Error(`Private HTTP verification failed (${route}:transport-${kind}); no secrets reported.`, { cause: error });
    }
    assert(!response.redirected && (response.status < 300 || response.status >= 400));
    for (const cookie of response.headers.getSetCookie()) {
      const pair = cookie.split(';')[0];
      const index = pair.indexOf('=');
      if (index < 1) continue;
      const name = pair.slice(0, index);
      const value = pair.slice(index + 1);
      if (!['tv_csrf', 'tv_session'].includes(name)) continue;
      assert(!/;\s*domain=/i.test(cookie));
      if (name === 'tv_csrf' && value) assert(/;\s*secure(?:;|$)/i.test(cookie) &&
        !/;\s*httponly(?:;|$)/i.test(cookie) && /;\s*samesite=lax(?:;|$)/i.test(cookie) && /;\s*path=\/(?:;|$)/i.test(cookie));
      if (value === '') jar.delete(name); else jar.set(name, value);
      if (name === 'tv_session' && value) {
        sessionAttributes = /;\s*secure(?:;|$)/i.test(cookie) && /;\s*httponly(?:;|$)/i.test(cookie) &&
          /;\s*samesite=lax(?:;|$)/i.test(cookie) && /;\s*path=\/(?:;|$)/i.test(cookie);
      }
    }
    const text = await response.text();
    assert(text.length < 1048576);
    if (jar.get('tv_session')) assert(!text.includes(jar.get('tv_session')));
    let payload;
    try { payload = text ? JSON.parse(text) : undefined; } catch { assert(false); }
    return { status: response.status, payload };
  }
  return {
    call,
    hasCsrf: () => Boolean(jar.get('tv_csrf')),
    hasSecureSession: () => Boolean(jar.get('tv_session')) && sessionAttributes,
    snapshot: () => {
      const previous = new Map(jar);
      return async () => {
        // Explicit stale-cookie probe: do not expose the copied cookie to logs.
        const response = await transport(`${origin}/api/me`, { headers: { cookie: [...previous].map(([key, value]) => `${key}=${value}`).join('; ') }, redirect: 'error', signal: AbortSignal.timeout(15000) });
        assert(!response.redirected && response.status === 401);
      };
    },
  };
}

function permissionProbes(organizationId) {
  return [
    ['organization', 'organization:read', `/api/organizations/${organizationId}`],
    ['organization', 'member:read', `/api/organizations/${organizationId}/members`],
    ['organization', 'campaign:read', `/api/organizations/${organizationId}/campaigns`],
    ['organization', 'reporting:read', `/api/organizations/${organizationId}/reports/campaign-status`],
    ['organization', 'wallet:read', `/api/organizations/${organizationId}/wallet`],
    ['organization', 'billing:read', `/api/organizations/${organizationId}/billing`],
    ['platform', 'platform:operations:read', '/api/platform/operations/me'],
    ['platform', 'platform:support:read', '/api/platform/support/me'],
    ['platform', 'platform:technical:read', '/api/platform/technical/me'],
    ['platform', 'platform:audit:read', '/api/platform/audit/me'],
  ];
}

/** Runs only after database/claim/identity/password preflight. No email request,
 * auto terms acceptance, paid action, fixture mutation or secret-bearing URL. */
export async function executePrivateHttp(approval, credentials, options = {}, dependencies = {}) {
  const environment = dependencies.environment ?? process.env;
  let phase = 'authorization-validation';
  try {
  const validation = validateRollout(approval, credentials, environment, options.confirmProduction);
  const { origin } = validation;
  assert(['initialize', 'http'].includes(approval.action));
  const inspect = dependencies.inspect ?? executeRollout;
  phase = 'database-preflight';
  const state = await inspect(approval, credentials, options, dependencies);
  const controls = { expiresAt: approval.expiresAt, intervalMs: approval.environment === 'production' ? 1000 : 0 };
  phase = 'health-probe';
  const health = await privateHttpClient(origin, dependencies.transport, controls).call('GET', '/health');
  assert(health.status === 200, 'health:status');
  assert(health.payload?.version === approval.releaseSha, 'health:version');
  assert(health.payload?.environment === approval.environment, 'health:environment');
  if (approval.action === 'initialize') {
    if (!state.initialized) {
      const client = privateHttpClient(origin, dependencies.transport, controls);
      phase = 'terms-probe';
      assert((await client.call('GET', '/api/auth/terms')).status === 200 && client.hasCsrf());
      const raw = new URL(options.artifact.activationUrl).searchParams.get('token');
      phase = 'password-initialization';
      const result = await client.call('POST', '/api/auth/password-reset/complete', {
        token: raw, newPassword: credentials.passwords['qa-platform-owner@truevoice.com'],
      });
      assert(result.status === 200 && result.payload?.ok === true);
      phase = 'initialization-reconciliation';
      const after = await inspect(approval, credentials, { ...options, authorizationReconciliation: true }, dependencies);
      assert(after.initialized);
    }
    return { operationId: approval.operationId, ownerInitialized: true };
  }
  const results = [];
  for (const account of ROLLOUT_ACCOUNTS) {
    phase = 'account-http-verification';
    assert(Date.parse(approval.expiresAt) > Date.now());
    const client = privateHttpClient(origin, dependencies.transport, controls);
    assert((await client.call('GET', '/api/auth/terms')).status === 200 && client.hasCsrf());
    const incorrect = await client.call('POST', '/api/auth/sign-in', { email: account.email, password: randomBytes(32).toString('base64url') });
    assert(incorrect.status === 401 && incorrect.payload?.error?.code === 'invalid_credentials' && !client.hasSecureSession());
    const signIn = await client.call('POST', '/api/auth/sign-in', { email: account.email, password: credentials.passwords[account.email] });
    assert(signIn.status === 200 && signIn.payload?.ok === true && client.hasSecureSession());
    const context = await client.call('GET', '/api/me');
    assert(context.status === 200 && context.payload?.email === account.email);
    const me = context.payload;
    // SessionGuard enforces accepted terms before organization permission
    // checks even for platform-only users. Require that precondition for every
    // identity so a terms refusal cannot masquerade as an RBAC denial.
    assert(me.termsAccepted === true, `${account.role}:accepted-terms`);
    const expected = account.scope === 'organization' ? ORGANIZATION_ROLE_PERMISSIONS[account.role] : PLATFORM_ROLE_PERMISSIONS[account.role];
    if (account.scope === 'organization') {
      assert(me.platformRole === null && me.memberships?.length === 1);
      const member = me.memberships[0];
      assert(member.organizationId === state.organizationId && member.role === account.role &&
        JSON.stringify([...member.permissions].sort()) === JSON.stringify([...expected].sort()));
    } else assert(me.platformRole === account.role && me.memberships?.length === 0);
    for (const [scope, permission, path] of permissionProbes(state.organizationId)) {
      const allowed = account.scope === scope && expected.includes(permission);
      const response = await client.call('GET', path);
      assert(response.status === (allowed ? 200 : 403), `${account.role}:${permission}:status`);
      if (!allowed) assert(response.payload?.error?.code === 'permission_denied', `${account.role}:${permission}:denial-code`);
    }
    const foreign = await client.call('GET', `/api/organizations/${state.isolationOrganizationId}`);
    assert(foreign.status === 403 && foreign.payload?.error?.code === 'permission_denied');
    const stale = client.snapshot();
    assert((await client.call('POST', '/api/auth/sign-out')).status === 204);
    await stale();
    results.push({ email: account.email, role: account.role, httpSignIn: 'passed', incorrectPassword: 'denied',
      roleAndReadPermissions: 'passed', tenantBoundary: 'denied', logoutInvalidation: 'passed' });
  }
  return { operationId: approval.operationId, accounts: results, mutationCoverage: 'not-exercised',
    ...(validation.ownerAuthorization ? { ownerAuthorizationKeyId: validation.ownerAuthorization.keyId,
      ownerAuthorizationDigest: validation.ownerAuthorization.digest } : {}),
    limitations: ['Platform billing/refund, tenant suspension, technical writes and admin management have no consuming endpoints.',
      'Custodians must accept terms through the normal interface before organization HTTP verification.',
      'Browser interface rendering and privileged mutations require separate approved checks.'] };
  } catch (error) {
    if (error instanceof Error && /^Private HTTP verification failed(?: \([A-Za-z0-9:_-]+\))?; no secrets reported\.$/.test(error.message)) throw error;
    if (environment.ROLLOUT_E2E_DISPOSABLE === '1' && environment.NODE_ENV === 'test')
      throw new Error(`Disposable private HTTP execution failed during ${phase}.`, { cause: error });
    throw error;
  }
}
