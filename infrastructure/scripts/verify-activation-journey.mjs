#!/usr/bin/env node
/**
 * Walks the complete Organization Owner activation journey against a running API.
 *
 * Verifies each numbered step the task calls for and prints PASS/FAIL per step,
 * so a failure names the step that broke rather than "the journey failed".
 *
 * Uses an isolated organization slug and a throwaway password that is never a
 * credential for anything real.
 */

import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadEnvFiles, requireEnv } from '@truevine/shared';
import { createDatabaseClient } from '@truevine/database';

function report(line) {
  process.stdout.write(`${line}\n`);
}

const API = `${process.env.WEB ?? 'http://localhost:3000'}/api`;
const WEB = process.env.WEB ?? 'http://localhost:3000';
const RUN = process.env.RUN ?? String(process.pid).slice(-6);
const SLUG = `journey-${RUN}`;
const EMAIL = `journey-${RUN}@example.invalid`;
const PASSWORD = 'a-verified-activation-passphrase';
const ACTIVATION_DIR = join(process.cwd(), '.owner-activation');

let step = 0;
let failures = 0;
let sessionHttpOnly = false;
const cookies = new Map();

function say(label, ok, detail = '') {
  step += 1;
  if (!ok) failures += 1;
  report(
    `${ok ? 'PASS' : 'FAIL'}  ${String(step).padStart(2)}. ${label}${detail ? `  -- ${detail}` : ''}`,
  );
}

/** Minimal cookie jar so a session persists across calls like a browser would. */
function captureCookies(response) {
  const raw = response.headers.getSetCookie?.() ?? [];
  for (const line of raw) {
    if (line.startsWith('tv_session=') && /;\s*HttpOnly/i.test(line)) sessionHttpOnly = true;
    const [pair] = line.split(';');
    const index = pair.indexOf('=');
    if (index > 0) cookies.set(pair.slice(0, index).trim(), pair.slice(index + 1).trim());
  }
}

function cookieHeader() {
  return [...cookies].map(([name, value]) => `${name}=${value}`).join('; ');
}

function csrf() {
  return cookies.get('tv_csrf');
}

async function call(method, path, body) {
  const headers = { accept: 'application/json' };
  if (cookies.size > 0) headers.cookie = cookieHeader();
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (method !== 'GET' && csrf()) headers['x-truevine-csrf'] = csrf();

  const response = await fetch(`${API}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    redirect: 'manual',
  });

  captureCookies(response);

  const text = await response.text();

  // A 204 carries no body, so parsing is skipped rather than caught. A non-JSON
  // body is returned as text: the harness asserts on status and error code far
  // more than on parsed structure, and a surprise HTML error page should read as
  // itself rather than blow up mid-run.
  const payload = text.length === 0 ? null : safeParse(text);

  return { status: response.status, body: payload };
}

/** Parses JSON, falling back to the raw text. */
function safeParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/** Fetches a CSRF cookie by making any request. */
async function primeCsrf() {
  await call('GET', '/auth/terms');
}

const main = async () => {
  loadEnvFiles();
  const databaseUrl = new URL(requireEnv('DATABASE_URL'));
  if (
    process.env.NODE_ENV === 'production' ||
    !['localhost', '127.0.0.1'].includes(databaseUrl.hostname) ||
    databaseUrl.pathname !== '/truevine_voice' ||
    !['localhost', '127.0.0.1'].includes(new URL(WEB).hostname)
  ) {
    throw new Error('Verification requires the local development database and web origin.');
  }
  report(`\n=== Organization Owner activation journey ===`);
  report(`API      ${API}`);
  report(`slug     ${SLUG}`);
  report(`email    ${EMAIL}\n`);

  // 1. Provision via the operator CLI -------------------------------------
  let provisioned = false;
  try {
    const output = execFileSync(
      'node',
      [
        'infrastructure/scripts/provision-owner-cli.mjs',
        '--email',
        EMAIL,
        '--organization-slug',
        SLUG,
        '--organization-name',
        'Journey Org',
        '--activation-directory',
        ACTIVATION_DIR,
        '--base-url',
        WEB,
      ],
      { encoding: 'utf8' },
    );
    provisioned = output.includes('First Organization Owner provisioned.');
  } catch (error) {
    say(
      'provision a new organization and its first Owner',
      false,
      String(error.stdout ?? error.message).slice(0, 160),
    );
  }
  if (provisioned) say('provision a new organization and its first Owner', true, SLUG);

  const tokenLine = execFileSync(
    'node',
    [
      '-e',
      `
    const {readdirSync,readFileSync}=require('node:fs');
    const files=readdirSync(${JSON.stringify(ACTIVATION_DIR)}).filter(f=>f.includes(${JSON.stringify(SLUG)}));
    if(!files.length){process.exit(1)}
    const m=/\\/set-password\\?token=([A-Za-z0-9_-]+)/.exec(readFileSync(${JSON.stringify(ACTIVATION_DIR)}+'/'+files.sort().pop(),'utf8'));
    process.stdout.write(m?m[1]:'');
  `,
    ],
    { encoding: 'utf8' },
  ).trim();

  // 3. Retrieve the activation token from the secure file ---------------
  say(
    'retrieve the activation token from the secure file',
    tokenLine.length > 20,
    `${tokenLine.length} characters`,
  );

  // 2. Cannot authenticate before activation ------------------------------
  await primeCsrf();
  const beforeActivation = await call('POST', '/auth/sign-in', {
    email: EMAIL,
    password: PASSWORD,
  });
  say(
    'account cannot authenticate before activation',
    beforeActivation.status === 401,
    `status ${beforeActivation.status}, code ${beforeActivation.body?.error?.code}`,
  );

  const beforeActivationGuessed = await call('POST', '/auth/sign-in', {
    email: EMAIL,
    password: 'anything-at-all',
  });
  say(
    'no operator-chosen password works before activation',
    beforeActivationGuessed.status === 401,
    `status ${beforeActivationGuessed.status}`,
  );

  // 4. Complete password setup through the running API --------------------
  await primeCsrf();
  const activation = await call('POST', '/auth/password-reset/complete', {
    token: tokenLine,
    newPassword: PASSWORD,
  });
  say(
    'complete password setup through the running API',
    activation.status === 200,
    `status ${activation.status}${activation.body?.error ? ` code ${activation.body.error.code}` : ''}`,
  );

  // 5. Token cannot be reused --------------------------------------------
  const reuse = await call('POST', '/auth/password-reset/complete', {
    token: tokenLine,
    newPassword: 'a-different-passphrase-entirely',
  });
  say(
    'activation token cannot be reused',
    reuse.status === 400 && reuse.body?.error?.code === 'token_already_used',
    `status ${reuse.status}, code ${reuse.body?.error?.code}`,
  );

  const reuseAfterPasswordChange = await call('POST', '/auth/sign-in', {
    email: EMAIL,
    password: 'a-different-passphrase-entirely',
  });
  say(
    'the reused token did not change the password',
    reuseAfterPasswordChange.status === 401,
    `status ${reuseAfterPasswordChange.status}`,
  );

  // 6. Sign in with the activated account --------------------------------
  cookies.clear();
  await primeCsrf();
  const signIn = await call('POST', '/auth/sign-in', { email: EMAIL, password: PASSWORD });
  say(
    'sign in with the newly activated account',
    signIn.status === 200,
    `status ${signIn.status}${signIn.body?.error ? ` code ${signIn.body.error.code}` : ''}`,
  );

  // 7. Secure session creation -------------------------------------------
  say(
    'session cookie is HTTP-only',
    cookies.has('tv_session') && sessionHttpOnly,
    'token never appeared in a response body',
  );
  say(
    'session token is absent from the sign-in body',
    !JSON.stringify(signIn.body ?? {}).includes(cookies.get('tv_session') ?? 'nope'),
  );

  const me = await call('GET', '/me');
  say(
    'session resolves to the activated user',
    me.status === 200 && me.body?.email === EMAIL,
    me.body?.email ?? `status ${me.status}`,
  );

  const membership = me.body?.memberships?.[0];
  say(
    'membership is OWNER in the provisioned organization',
    membership?.role === 'OWNER' && membership?.organizationSlug === SLUG,
    `${membership?.role} in ${membership?.organizationSlug}`,
  );

  // 8. Terms acceptance ----------------------------------------------------
  const termsVersion = me.body?.termsVersion;
  say(
    'terms version is explicitly identified',
    typeof termsVersion === 'string' && termsVersion.length > 0,
    `version ${termsVersion}`,
  );

  const accept = await call('POST', '/auth/terms/accept');
  say('terms acceptance recorded', accept.status === 204, `status ${accept.status}`);

  const meAfterTerms = await call('GET', '/me');
  say('terms now show as accepted', meAfterTerms.body?.termsAccepted === true);

  // 9. Owner dashboard -----------------------------------------------------
  const orgId = membership?.organizationId;
  const org = await call('GET', `/organizations/${orgId}`);
  say('Owner can read the organization profile', org.status === 200 && org.body?.slug === SLUG);

  const members = await call('GET', `/organizations/${orgId}/members`);
  say(
    'Owner can list members',
    members.status === 200 && members.body?.length === 1,
    `${members.body?.length} member(s)`,
  );

  const membersLeak = JSON.stringify(members.body ?? {});
  say('member listing contains no password hash', !membersLeak.includes('argon2'));

  const dashboard = await fetch(WEB + '/app', {
    headers: { cookie: cookieHeader() },
    redirect: 'manual',
  });
  say(
    'dashboard renders through the frontend',
    dashboard.status === 200 && (await dashboard.text()).includes('Pending invitations'),
  );
  const renamed = await call('PATCH', '/organizations/' + orgId, { name: 'Journey Verified' });
  say(
    'update organization settings through the frontend proxy',
    renamed.status === 200 && renamed.body?.name === 'Journey Verified',
  );

  // Provision an independent account that can accept an invitation as a teammate.
  const teammateEmail = 'teammate-' + RUN + '@example.invalid';
  execFileSync(
    'node',
    [
      'infrastructure/scripts/provision-owner-cli.mjs',
      '--email',
      teammateEmail,
      '--organization-slug',
      'teammate-' + RUN,
      '--activation-directory',
      ACTIVATION_DIR,
    ],
    { encoding: 'utf8' },
  );
  const activationFile = readdirSync(ACTIVATION_DIR)
    .filter((f) => f.includes('teammate-' + RUN))
    .sort()
    .pop();
  const teammateToken = /\/set-password\?token=([A-Za-z0-9_-]+)/.exec(
    readFileSync(join(ACTIVATION_DIR, activationFile), 'utf8'),
  )?.[1];
  const ownerCookies = new Map(cookies);
  cookies.clear();
  await primeCsrf();
  const teammateActivation = await call('POST', '/auth/password-reset/complete', {
    token: teammateToken,
    newPassword: PASSWORD,
  });
  say('activate the independent teammate account', teammateActivation.status === 200);
  const teammateSignIn = await call('POST', '/auth/sign-in', {
    email: teammateEmail,
    password: PASSWORD,
  });
  say('sign in as the teammate', teammateSignIn.status === 200);
  await call('POST', '/auth/terms/accept');
  const teammate = await call('GET', '/me');
  const teammateCookies = new Map(cookies);
  cookies.clear();
  ownerCookies.forEach((v, k) => cookies.set(k, v));
  const invitation = await call('POST', '/organizations/' + orgId + '/invitations', {
    email: teammateEmail,
    role: 'VIEWER',
  });
  say('create a team invitation', invitation.status === 201);
  const captureDirectory =
    process.env.EMAIL_CAPTURE_DIRECTORY ?? join(process.cwd(), '.email-capture');
  const messages = readdirSync(captureDirectory)
    .sort()
    .reverse()
    .map((f) => readFileSync(join(captureDirectory, f), 'utf8'));
  const message = messages.find(
    (body) => body.includes(teammateEmail) && body.includes('/accept-invite?token='),
  );
  const invitationToken = /\/accept-invite\?token=([A-Za-z0-9_-]+)/.exec(message ?? '')?.[1];
  if (!invitationToken)
    throw new Error('Invitation capture missing; acceptance and transfer have not executed.');
  cookies.clear();
  teammateCookies.forEach((v, k) => cookies.set(k, v));
  const accepted = await call('POST', '/invitations/accept', { token: invitationToken });
  say(
    'teammate accepts invitation through the frontend proxy',
    accepted.status === 200 && accepted.body?.organizationId === orgId,
  );
  cookies.clear();
  ownerCookies.forEach((v, k) => cookies.set(k, v));
  const role = await call('PATCH', '/organizations/' + orgId + '/members/' + teammate.body.userId, {
    role: 'ADMIN',
  });
  say('Owner changes a team member role', role.status === 200);
  const pending = await call('POST', '/organizations/' + orgId + '/invitations', {
    email: 'pending-' + RUN + '@example.invalid',
    role: 'VIEWER',
  });
  const revoked = await call(
    'DELETE',
    '/organizations/' + orgId + '/invitations/' + pending.body?.id,
  );
  say(
    'Owner revokes a pending invitation with HTTP 204',
    pending.status === 201 && revoked.status === 204,
  );
  const transfer = await call('POST', '/organizations/' + orgId + '/ownership/transfer', {
    newOwnerId: teammate.body.userId,
  });
  const transferredMembers = await call('GET', '/organizations/' + orgId + '/members');
  say(
    'transfer ownership and verify both resulting roles',
    transfer.status === 200 &&
      transferredMembers.body?.find((m) => m.userId === teammate.body.userId)?.role === 'OWNER' &&
      transferredMembers.body?.find((m) => m.userId === me.body.userId)?.role === 'ADMIN',
  );

  cookies.clear();
  teammateCookies.forEach((v, k) => cookies.set(k, v));
  const removed = await call('DELETE', '/organizations/' + orgId + '/members/' + me.body.userId);
  say('new Owner removes the former Owner with HTTP 204', removed.status === 204);
  cookies.clear();
  ownerCookies.forEach((v, k) => cookies.set(k, v));
  const removedAccess = await call('GET', '/organizations/' + orgId);
  say('removed member immediately loses organization access', removedAccess.status === 403);

  // Password reset must consume a distinct token once and revoke the old session.
  const resetRequest = await call('POST', '/auth/password-reset/request', { email: EMAIL });
  say('request a captured password reset', resetRequest.status === 202);
  const resetMessage = readdirSync(captureDirectory)
    .sort()
    .reverse()
    .map((f) => readFileSync(join(captureDirectory, f), 'utf8'))
    .find((body) => body.includes(EMAIL) && body.includes('/reset-password?token='));
  const resetToken = /\/reset-password\?token=([A-Za-z0-9_-]+)/.exec(resetMessage ?? '')?.[1];
  if (!resetToken)
    throw new Error('Reset capture missing; reset reuse verification has not executed.');
  const staleCookies = cookieHeader();
  const reset = await call('POST', '/auth/password-reset/complete', {
    token: resetToken,
    newPassword: PASSWORD,
  });
  say('complete a real password reset', reset.status === 200);
  const resetReuse = await call('POST', '/auth/password-reset/complete', {
    token: resetToken,
    newPassword: PASSWORD,
  });
  say(
    'password reset token cannot be reused',
    resetReuse.status === 400 && resetReuse.body?.error?.code === 'token_already_used',
  );
  const stale = await fetch(API + '/me', { headers: { cookie: staleCookies } });
  say('password reset revokes the captured prior session', stale.status === 401);
  await primeCsrf();
  const finalSignIn = await call('POST', '/auth/sign-in', { email: EMAIL, password: PASSWORD });
  say('sign in after reset', finalSignIn.status === 200);
  const beforeSignOut = cookieHeader();

  // 10. Sign out -----------------------------------------------------------
  const signOut = await call('POST', '/auth/sign-out');
  say('sign out succeeds', signOut.status === 204, `status ${signOut.status}`);

  const afterSignOut = await fetch(API + '/me', { headers: { cookie: beforeSignOut } });
  say(
    'session is revoked after sign out',
    afterSignOut.status === 401,
    `status ${afterSignOut.status}`,
  );

  const database = createDatabaseClient(requireEnv('DATABASE_URL'));
  try {
    const events = await database.securityAuditEvent.findMany({ where: { organizationId: orgId } });
    for (const action of [
      'organization.profile_updated',
      'organization.member.invited',
      'organization.invitation.accepted',
      'organization.member.role_changed',
      'organization.invitation.revoked',
      'organization.ownership.transferred',
      'organization.member.removed',
    ]) {
      say(
        'sensitive action audited: ' + action,
        events.some((e) => e.action === action && e.outcome === 'SUCCESS'),
      );
    }
  } finally {
    await database.$disconnect();
  }

  report(`\n=== journey ${failures === 0 ? 'PASSED' : `FAILED (${failures} step(s))`} ===`);
  report(`slug=${SLUG} email=${EMAIL}\n`);

  process.exit(failures === 0 ? 0 : 1);
};

main().catch((error) => {
  process.stderr.write(`verification aborted: ${error.message}\n`);
  process.exit(1);
});
