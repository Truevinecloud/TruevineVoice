#!/usr/bin/env node
/**
 * Security boundaries, verified against a running API with two independent
 * organizations.
 *
 * Each check names the boundary it proves. A failure prints the boundary, so the
 * output is a list of what holds rather than a single pass or fail.
 *
 * Uses throwaway organizations with a run-scoped slug. Nothing here touches a
 * production database or a real account.
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { loadEnvFiles, requireEnv } from '@truevine/shared';

/** Runs a read-only query against the local development database. */
function psql(sql) {
  return execFileSync(
    'docker',
    ['exec', 'truevine-postgres', 'psql', '-U', 'truevine', '-d', 'truevine_voice', '-tAc', sql],
    { encoding: 'utf8' },
  );
}

function report(line) {
  process.stdout.write(`${line}\n`);
}

const API = process.env.API ?? 'http://localhost:3001';
const RUN = process.env.RUN ?? String(process.pid).slice(-6);
const PASSWORD = 'a-verified-security-passphrase';
const ACTIVATION_DIR = join(process.cwd(), '.owner-activation');

let failures = 0;
const cookies = new Map();

function check(boundary, ok, detail = '') {
  if (!ok) failures += 1;
  report(`${ok ? 'PASS' : 'FAIL'}  ${boundary}${detail ? `  -- ${detail}` : ''}`);
}

function capture(response) {
  for (const line of response.headers.getSetCookie?.() ?? []) {
    const [pair] = line.split(';');
    const index = pair.indexOf('=');
    if (index > 0) cookies.set(pair.slice(0, index).trim(), pair.slice(index + 1).trim());
  }
}

async function call(method, path, body, jar) {
  const active = jar ?? cookies;
  const headers = { accept: 'application/json' };
  const header = [...active].map(([n, v]) => `${n}=${v}`).join('; ');
  if (header) headers.cookie = header;
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (method !== 'GET' && active.get('tv_csrf')) headers['x-truevine-csrf'] = active.get('tv_csrf');

  const response = await fetch(`${API}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    redirect: 'manual',
  });

  capture(response);

  const text = await response.text();

  // A 204 carries no body. A non-JSON body is returned as text, so a surprise
  // HTML error page reads as itself rather than aborting the whole run.
  const payload = text.length === 0 ? null : safeParse(text);

  return { status: response.status, body: payload };
}

/** Provisions, activates and signs in one owner, returning its cookies. */
async function createOwner(label) {
  const slug = `sec-${label}-${RUN}`;
  const email = `sec-${label}-${RUN}@example.invalid`;

  execFileSync(
    'node',
    [
      'infrastructure/scripts/provision-owner-cli.mjs',
      '--email',
      email,
      '--organization-slug',
      slug,
      '--activation-directory',
      ACTIVATION_DIR,
    ],
    {
      encoding: 'utf8',
      env: { ...process.env, WEB_PUBLIC_URL: API },
    },
  );

  const token = execFileSync(
    'node',
    [
      '-e',
      `
    const {readdirSync,readFileSync}=require('node:fs');
    const files=readdirSync(${JSON.stringify(ACTIVATION_DIR)}).filter(f=>f.includes(${JSON.stringify(slug)}));
    const m=/\\/set-password\\?token=([A-Za-z0-9_-]+)/.exec(readFileSync(${JSON.stringify(ACTIVATION_DIR)}+'/'+files.sort().pop(),'utf8'));
    process.stdout.write(m?m[1]:'');
  `,
    ],
    { encoding: 'utf8' },
  ).trim();

  const jar = new Map();

  const prime = await fetch(`${API}/auth/terms`);
  capture(prime);
  jar.set('tv_csrf', cookies.get('tv_csrf'));

  const activation = await fetch(`${API}/auth/password-reset/complete`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-truevine-csrf': jar.get('tv_csrf'),
      cookie: `tv_csrf=${jar.get('tv_csrf')}`,
    },
    body: JSON.stringify({ token, newPassword: PASSWORD }),
  });

  if (activation.status !== 200)
    throw new Error('Owner activation failed: HTTP ' + activation.status);

  const signedIn = await fetch(`${API}/auth/sign-in`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-truevine-csrf': jar.get('tv_csrf'),
      cookie: `tv_csrf=${jar.get('tv_csrf')}`,
    },
    body: JSON.stringify({ email, password: PASSWORD }),
  });

  if (signedIn.status !== 200)
    throw new Error(
      'Owner sign-in failed: HTTP ' +
        signedIn.status +
        '; retry after the rate-limit window if 429.',
    );

  for (const line of signedIn.headers.getSetCookie?.() ?? []) {
    const [pair] = line.split(';');
    const index = pair.indexOf('=');
    if (index > 0) jar.set(pair.slice(0, index).trim(), pair.slice(index + 1).trim());
  }

  const terms = await call('POST', '/auth/terms/accept', undefined, jar);
  if (terms.status !== 204) throw new Error('Test terms acceptance failed: HTTP ' + terms.status);

  const me = await call('GET', '/me', undefined, jar);

  if (me.status !== 200 || !me.body?.memberships?.length)
    throw new Error('Owner membership lookup failed: HTTP ' + me.status);

  return { slug, email, jar, organizationId: me.body.memberships[0].organizationId };
}

/** Parses JSON, falling back to the raw text. */
function safeParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

const main = async () => {
  loadEnvFiles();
  const databaseUrl = new URL(requireEnv('DATABASE_URL'));
  if (
    process.env.NODE_ENV === 'production' ||
    !['localhost', '127.0.0.1'].includes(databaseUrl.hostname) ||
    databaseUrl.pathname !== '/truevine_voice' ||
    !['localhost', '127.0.0.1'].includes(new URL(API).hostname)
  ) {
    throw new Error('Verification requires the local development database and API origin.');
  }
  report(`\n=== security boundaries (two independent organizations) ===\n`);

  // Keep the real rate limiter enabled during verification.

  const a = await createOwner('a');
  const b = await createOwner('b');

  report(`  org A  ${a.slug}  ${a.organizationId}`);
  report(`  org B  ${b.slug}  ${b.organizationId}\n`);

  // --- tenant isolation ---------------------------------------------------
  const aReadsB = await call('GET', `/organizations/${b.organizationId}`, undefined, a.jar);
  check(
    'Organization A cannot read Organization B',
    aReadsB.status === 403,
    `status ${aReadsB.status}`,
  );

  const aListsBMembers = await call(
    'GET',
    `/organizations/${b.organizationId}/members`,
    undefined,
    a.jar,
  );
  check(
    'Organization A cannot list Organization B members',
    aListsBMembers.status === 403,
    `status ${aListsBMembers.status}`,
  );

  const aInvitesToB = await call(
    'POST',
    `/organizations/${b.organizationId}/invitations`,
    { email: 'x@example.invalid', role: 'ADMIN' },
    a.jar,
  );
  check(
    'Organization A cannot invite into Organization B',
    aInvitesToB.status === 403,
    `status ${aInvitesToB.status}`,
  );

  const bReadsA = await call('GET', '/organizations/' + a.organizationId, undefined, b.jar);
  check(
    'Organization B cannot read Organization A',
    bReadsA.status === 403,
    'status ' + bReadsA.status,
  );

  // --- forged identifiers -------------------------------------------------
  const forged = '00000000-0000-4000-8000-0000000000ff';
  const aForged = await call('GET', `/organizations/${forged}`, undefined, a.jar);
  const aForeign = await call('GET', `/organizations/${b.organizationId}`, undefined, a.jar);
  check('a forged organization id is refused', aForged.status === 403, `status ${aForged.status}`);
  check(
    'a forged id is indistinguishable from another tenant',
    aForged.status === aForeign.status &&
      JSON.stringify(aForged.body) === JSON.stringify(aForeign.body),
  );

  const noBodyRedirect = await call(
    'PATCH',
    `/organizations/${a.organizationId}`,
    { organizationId: b.organizationId, name: 'hijacked' },
    a.jar,
  );
  check(
    'an organization id in the body cannot redirect a write',
    noBodyRedirect.status === 200 && noBodyRedirect.body.id === a.organizationId,
    `status ${noBodyRedirect.status}, wrote to ${noBodyRedirect.body?.id?.slice(0, 8)}`,
  );

  // The PATCH above renamed organization A, which is correct - the path is
  // authoritative. The property under test is that B was never touched, so B is
  // what gets read back.
  const untouchedB = await call('GET', `/organizations/${b.organizationId}`, undefined, b.jar);
  check(
    'Organization B was not renamed by the forged body',
    untouchedB.status === 200 && untouchedB.body.name === b.slug,
    `name is "${untouchedB.body.name}"`,
  );

  // --- unauthenticated ----------------------------------------------------
  const anonymous = new Map();
  const anonymousProfile = await call(
    'GET',
    `/organizations/${a.organizationId}`,
    undefined,
    anonymous,
  );
  check(
    'an unauthenticated request is 401',
    anonymousProfile.status === 401,
    `status ${anonymousProfile.status}`,
  );

  const anonymousMe = await call('GET', '/me', undefined, anonymous);
  check('GET /me without a session is 401', anonymousMe.status === 401);

  // --- CSRF ---------------------------------------------------------------
  const csrfProbe = await fetch(`${API}/auth/terms`);
  const csrfJar = new Map();
  for (const line of csrfProbe.headers.getSetCookie?.() ?? []) {
    const [pair] = line.split(';');
    const i = pair.indexOf('=');
    if (i > 0) csrfJar.set(pair.slice(0, i).trim(), pair.slice(i + 1).trim());
  }

  const noCsrf = await fetch(`${API}/organizations/${a.organizationId}`, {
    method: 'PATCH',
    headers: {
      'content-type': 'application/json',
      cookie: [...a.jar].map(([n, v]) => `${n}=${v}`).join('; '),
    },
    body: JSON.stringify({ name: 'csrf-attempt' }),
  });
  check(
    'a mutation with no CSRF header is refused',
    noCsrf.status === 403,
    `status ${noCsrf.status}`,
  );

  const wrongCsrf = await fetch(`${API}/organizations/${a.organizationId}`, {
    method: 'PATCH',
    headers: {
      'content-type': 'application/json',
      'x-truevine-csrf': 'a-token-that-is-not-the-cookie',
      cookie: [...a.jar].map(([n, v]) => `${n}=${v}`).join('; '),
    },
    body: JSON.stringify({ name: 'csrf-attempt' }),
  });
  check(
    'a mutation with a mismatched CSRF token is refused',
    wrongCsrf.status === 403,
    `status ${wrongCsrf.status}`,
  );

  const notHijacked = await call('GET', `/organizations/${a.organizationId}`, undefined, a.jar);
  check(
    'neither CSRF attempt changed anything',
    notHijacked.body.name !== 'csrf-attempt',
    `name is "${notHijacked.body.name}"`,
  );
  void csrfJar;

  // --- platform administration -------------------------------------------
  // No platform route exists: 404 proves absence, not authorization of a future route.
  const platformAttempt = await call('GET', '/platform/tenants', undefined, a.jar);
  check(
    'the platform API path is absent (404; no platform authorization claim)',
    platformAttempt.status === 404,
    `status ${platformAttempt.status} (no platform route exists)`,
  );

  // --- ownership transfer -------------------------------------------------
  const transferToSelf = await call(
    'POST',
    `/organizations/${a.organizationId}/ownership/transfer`,
    { newOwnerId: (await call('GET', '/me', undefined, a.jar)).body.userId },
    a.jar,
  );
  check(
    'ownership cannot be transferred to yourself',
    transferToSelf.status === 409,
    `status ${transferToSelf.status}`,
  );

  const transferToStranger = await call(
    'POST',
    `/organizations/${a.organizationId}/ownership/transfer`,
    { newOwnerId: '00000000-0000-4000-8000-0000000000cc' },
    a.jar,
  );
  check(
    'ownership cannot be transferred to a non-member',
    transferToStranger.status === 404,
    `status ${transferToStranger.status}`,
  );

  const stillOwner = await call('GET', '/me', undefined, a.jar);
  check(
    'the original Owner still owns the organization after both attempts',
    stillOwner.body.memberships[0].role === 'OWNER',
  );

  // --- invitation lifecycle ----------------------------------------------
  const invitation = await call(
    'POST',
    `/organizations/${a.organizationId}/invitations`,
    { email: `invitee-${RUN}@example.invalid`, role: 'VIEWER' },
    a.jar,
  );
  check(
    'an Owner can invite a VIEWER',
    invitation.status === 201 && invitation.body.role === 'VIEWER',
    `status ${invitation.status}`,
  );

  const inviteOwner = await call(
    'POST',
    `/organizations/${a.organizationId}/invitations`,
    { email: `owner-${RUN}@example.invalid`, role: 'OWNER' },
    a.jar,
  );
  check(
    'an OWNER invitation is refused',
    inviteOwner.status === 403,
    `status ${inviteOwner.status}`,
  );

  const revoked = await call(
    'DELETE',
    `/organizations/${a.organizationId}/invitations/${invitation.body.id}`,
    undefined,
    a.jar,
  );
  check(
    'an outstanding invitation can be revoked',
    revoked.status === 204,
    `status ${revoked.status}`,
  );

  const afterRevoke = await call(
    'GET',
    `/organizations/${a.organizationId}/invitations`,
    undefined,
    a.jar,
  );
  const entry = afterRevoke.body.find((entry) => entry.id === invitation.body.id);
  check(
    'the revoked invitation is no longer outstanding',
    entry?.outstanding === false,
    `outstanding ${entry?.outstanding}`,
  );

  // --- audit --------------------------------------------------------------
  // Read with `psql` rather than the ORM: `$queryRaw` is a template tag in this
  // Prisma version, and shelling out makes the evidence readable as SQL.
  const organizationId = a.organizationId;
  const ownerId = (await call('GET', '/me', undefined, a.jar)).body.userId;

  const auditRows = psql(
    `SELECT organization_id::text || '|' || action || '|' || outcome FROM security_audit_events ` +
      `WHERE organization_id IN ('${a.organizationId}', '${b.organizationId}') ORDER BY occurred_at;`,
  )
    .split('\n')
    .filter((line) => line.trim().length > 0);

  const denied = auditRows.filter((line) => line.endsWith('|DENIED'));

  check(
    'sensitive actions produced audit rows',
    auditRows.length > 0,
    `${auditRows.length} row(s)`,
  );
  check('denied attempts are audited', denied.length > 0, `${denied.length} DENIED`);

  // A cross-tenant denial is recorded against the tenant that was *probed*, not
  // the tenant the prober belongs to. See ADR 0009.
  const bDenials = auditRows.filter((line) =>
    line.startsWith(`${b.organizationId}|authorization.denied|DENIED`),
  );
  check(
    'the cross-tenant probe is on the record, filed against the targeted tenant',
    bDenials.length > 0,
    `${bDenials.length} row(s) on organization B`,
  );

  const aOwnDenials = auditRows.filter((line) =>
    line.startsWith(`${a.organizationId}|authorization.denied|DENIED`),
  );
  check(
    'the reverse cross-tenant probe is audited against Organization A',
    aOwnDenials.length === 1,
    `${aOwnDenials.length} row(s) on organization A`,
  );

  const identityRows = psql(
    `SELECT action FROM identity_audit_events WHERE actor_user_id = '${ownerId}' ORDER BY occurred_at;`,
  )
    .split('\n')
    .filter((line) => line.trim().length > 0);

  check(
    'sign-in is audited on the identity trail',
    identityRows.includes('auth.sign_in.succeeded'),
    identityRows.join(', '),
  );
  check(
    'provisioning is audited on the identity trail',
    identityRows.includes('auth.owner_provisioned'),
  );
  check('terms acceptance is audited', identityRows.includes('terms.accepted'));

  const refused = spawnSync(
    'docker',
    [
      'exec',
      'truevine-postgres',
      'psql',
      '-U',
      'truevine',
      '-d',
      'truevine_voice',
      '-tAc',
      `DELETE FROM security_audit_events WHERE organization_id = '${organizationId}'`,
    ],
    { encoding: 'utf8' },
  );

  check(
    'audit rows cannot be deleted, even by an operator with psql',
    `${refused.stdout}${refused.stderr}`.includes('append-only'),
    `${refused.stdout}${refused.stderr}`.split('\n')[0],
  );

  report(`\n=== boundaries ${failures === 0 ? 'ALL HOLD' : `${failures} FAILED`} ===`);
  report(`org A ${a.slug}\norg B ${b.slug}\n`);

  process.exit(failures === 0 ? 0 : 1);
};

main().catch((error) => {
  process.stderr.write(`verification aborted: ${error.message}\n`);
  process.exit(1);
});
