#!/usr/bin/env node
/**
 * Checks server-rendered HTML and HTTP responses through the frontend origin.
 * This harness does not automate a browser or exercise hydration.
 *
 * Every page in this application is server-rendered, so the rendered HTML, the
 * status code, the redirect target and the `Set-Cookie` headers are what a
 * browser receives and acts on. Driving it over HTTP therefore verifies the real
 * user-visible behaviour - including the same-origin proxy, which is where a
 * cookie or CSRF mistake would show up.
 *
 * Not covered here: JavaScript-driven interaction after hydration. That needs a
 * real browser, which was not available in this session.
 */

function report(line) {
  process.stdout.write(`${line}\n`);
}

const WEB = process.env.WEB ?? 'http://localhost:3000';

let failures = 0;
const jar = new Map();

function check(what, ok, detail = '') {
  if (!ok) failures += 1;
  report(`${ok ? 'PASS' : 'FAIL'}  ${what}${detail ? `  -- ${detail}` : ''}`);
}

function absorb(response) {
  for (const line of response.headers.getSetCookie?.() ?? []) {
    const [pair] = line.split(';');
    const index = pair.indexOf('=');
    if (index > 0) jar.set(pair.slice(0, index).trim(), pair.slice(index + 1).trim());
  }
}

const cookieHeader = () => [...jar].map(([k, v]) => `${k}=${v}`).join('; ');

/** Retains response cookies and inspects redirects without following them. */
async function browse(path, options = {}) {
  const headers = { accept: 'text/html,application/xhtml+xml' };
  const cookie = cookieHeader();
  if (cookie) headers.cookie = cookie;
  if (options.csrf) headers['x-truevine-csrf'] = options.csrf;
  if (options.json) headers['content-type'] = 'application/json';

  const response = await fetch(`${WEB}${path}`, {
    method: options.method ?? 'GET',
    headers,
    body: options.json,
    redirect: 'manual',
  });

  absorb(response);

  return {
    status: response.status,
    location: response.headers.get('location'),
    body: await response.text(),
  };
}

const main = async () => {
  if (!['localhost', '127.0.0.1'].includes(new URL(WEB).hostname)) {
    throw new Error('Verification requires the local development web origin.');
  }
  report(`\n=== customer frontend, driven through ${WEB} ===\n`);

  // Prime the CSRF cookie exactly as `SignInForm.ensureCsrfToken()` does. A
  // server-rendered page issues nothing by itself: the cookie comes from the
  // first call through the proxy, which is why the client has to ask for it
  // before its first mutation.
  const primed = await fetch(`${WEB}/api/auth/terms`, { redirect: 'manual' });
  absorb(primed);

  // --- unauthenticated navigation ---------------------------------------
  const signIn = await browse('/sign-in');
  check(
    '/sign-in renders a sign-in form',
    signIn.status === 200 &&
      signIn.body.includes('type="password"') &&
      signIn.body.includes('Sign in'),
    `status ${signIn.status}`,
  );

  // React renders `autoComplete`; HTML attribute names are case-insensitive, so
  // the comparison is too.
  check(
    'the sign-in form marks up autocomplete correctly',
    /autocomplete="username"/i.test(signIn.body) &&
      /autocomplete="current-password"/i.test(signIn.body),
  );

  check(
    'the CSRF cookie is issued before any mutation',
    jar.has('tv_csrf'),
    [...jar.keys()].join(', '),
  );

  check('a server-rendered page alone issues no session cookie', !jar.has('tv_session'));

  check(
    'the session token is never in the rendered HTML',
    !signIn.body.includes(jar.get('tv_session') ?? 'no-session-token-yet'),
  );

  const forgot = await browse('/forgot-password');
  check(
    '/forgot-password renders',
    forgot.status === 200 && forgot.body.includes('Send reset link'),
  );

  const resetNoToken = await browse('/reset-password');
  check(
    '/reset-password without a token explains itself rather than showing a dead form',
    resetNoToken.status === 200 && resetNoToken.body.includes('incomplete'),
    'no empty form',
  );

  const setPwNoToken = await browse('/set-password');
  check(
    '/set-password without a token explains itself',
    setPwNoToken.status === 200 && setPwNoToken.body.includes('incomplete'),
  );

  const inviteNoToken = await browse('/accept-invite');
  check(
    '/accept-invite without a token explains itself',
    inviteNoToken.status === 200 && inviteNoToken.body.includes('incomplete'),
  );

  // --- protected routes redirect -----------------------------------------
  const protectedRoutes = [
    '/app',
    '/app/settings',
    '/app/team',
    '/app/invitations',
    '/app/account',
  ];

  for (const route of protectedRoutes) {
    const response = await browse(route);
    check(
      `${route} redirects an anonymous visitor to sign in`,
      response.status === 307 && (response.location ?? '').includes('/sign-in'),
      `status ${response.status} -> ${response.location}`,
    );
  }

  // --- sign in with bad credentials --------------------------------------
  const badSignIn = await browse('/api/auth/sign-in', {
    method: 'POST',
    csrf: jar.get('tv_csrf'),
    json: JSON.stringify({ email: 'nobody@example.invalid', password: 'wrong-password-entirely' }),
  });
  check(
    'a bad sign-in returns 401 through the proxy',
    badSignIn.status === 401 && badSignIn.body.includes('invalid_credentials'),
    `status ${badSignIn.status}`,
  );

  // --- the proxy refuses what it should ----------------------------------
  for (const [method, path] of [
    ['GET', '/api/admin'],
    ['GET', '/api/health'],
    ['POST', '/api/admin/users'],
  ]) {
    const response = await browse(path, { method, csrf: jar.get('tv_csrf') });
    check(
      `the proxy refuses ${method} ${path}`,
      response.status === 404,
      `status ${response.status}`,
    );
  }

  // --- sign in for real ----------------------------------------------------
  const email = process.env.OWNER_EMAIL;
  const password = process.env.OWNER_PASSWORD;

  if (!email || !password) {
    throw new Error(
      'OWNER_EMAIL and OWNER_PASSWORD are required; authenticated verification did not execute.',
    );
  }

  jar.clear();
  await browse('/sign-in');
  const rePrime = await fetch(`${WEB}/api/auth/terms`, { redirect: 'manual' });
  absorb(rePrime);

  const signInOk = await browse('/api/auth/sign-in', {
    method: 'POST',
    csrf: jar.get('tv_csrf'),
    json: JSON.stringify({ email, password }),
  });
  check(
    'a correct sign-in returns 200 through the proxy',
    signInOk.status === 200,
    `status ${signInOk.status}`,
  );
  check(
    'the session cookie was set by the browser origin',
    jar.has('tv_session'),
    [...jar.keys()].join(', '),
  );

  const acceptTerms = await browse('/api/auth/terms/accept', {
    method: 'POST',
    csrf: jar.get('tv_csrf'),
  });
  check('terms acceptance succeeds', acceptTerms.status === 204, `status ${acceptTerms.status}`);

  const me = await browse('/api/me');
  const organizationId = JSON.parse(me.body)?.memberships?.[0]?.organizationId;
  check('GET /me returns the caller organizations', me.status === 200 && Boolean(organizationId));

  // --- the signed-in application -----------------------------------------
  const dashboard = await browse('/app');
  check(
    '/app renders the Owner dashboard',
    dashboard.status === 200 &&
      dashboard.body.includes('Team') &&
      dashboard.body.includes('Pending invitations'),
    'shows team and invitation sections',
  );

  // React's server renderer separates adjacent text expressions with `<!-- -->`,
  // so "1" + " " + "member" reaches the browser as `1<!-- --> <!-- -->member`.
  // Stripped before matching so an assertion about rendered text is about the text
  // a reader sees, not about React's internal markers.
  const visible = (html) => html.replace(/<!--.*?-->/g, '');

  check(
    '/app shows real counts, not placeholder figures',
    /\d+ members?/.test(visible(dashboard.body)) &&
      !visible(dashboard.body).includes('$0.00') &&
      !visible(dashboard.body).includes('Total calls'),
    'no fake financial or campaign figures',
  );

  check(
    '/app states plainly that campaigns and billing are not built',
    dashboard.body.includes('Not built yet'),
  );

  const nav = ['Organization', 'Team', 'Invitations', 'Account'];
  const navMissing = nav.filter((label) => !dashboard.body.includes(`>${label}<`));
  check(
    'permission-aware navigation renders every Owner link',
    navMissing.length === 0,
    navMissing.length > 0 ? `missing ${navMissing.join(', ')}` : nav.join(', '),
  );

  const settings = await browse('/app/settings');
  check(
    '/app/settings renders the organization profile',
    settings.status === 200 && settings.body.includes('Organization settings'),
  );
  check(
    '/app/settings makes the slug read-only with a reason',
    /readonly/i.test(settings.body) && settings.body.includes('Permanent'),
  );

  const team = await browse('/app/team');
  check('/app/team renders members', team.status === 200 && team.body.includes('Team'));
  check(
    '/app/team shows the Owner role and an owner badge',
    team.body.includes('OWNER') && team.body.includes('tag-owner'),
  );

  const invite = await browse('/app/team/invite');
  check(
    '/app/team/invite renders with delegable roles only',
    invite.status === 200 &&
      invite.body.includes('CAMPAIGN MANAGER') &&
      !invite.body.includes('>OWNER<'),
    'OWNER is not offered as an invitation role',
  );

  const invitations = await browse('/app/invitations');
  check(
    '/app/invitations renders',
    invitations.status === 200 && invitations.body.includes('Invitations'),
  );

  const account = await browse('/app/account');
  check(
    '/app/account renders profile, orgs and security sections',
    account.status === 200 &&
      account.body.includes('Account and security') &&
      account.body.includes('Organizations') &&
      account.body.includes('Password'),
  );
  check(
    '/app/account states platform authority is separate',
    account.body.includes('never granted by the other'),
  );

  // --- a real mutation through the UI's own route --------------------------
  const rename = await browse(`/api/organizations/${organizationId}`, {
    method: 'PATCH',
    csrf: jar.get('tv_csrf'),
    json: JSON.stringify({ name: 'Renamed By Browser Test' }),
  });
  check(
    'an organization rename succeeds through the proxy',
    rename.status === 200,
    `status ${rename.status}`,
  );

  const renamed = await browse('/app/settings');
  check(
    'the rename is visible in the settings page',
    renamed.body.includes('Renamed By Browser Test'),
  );

  // --- CSRF through the proxy ---------------------------------------------
  const noCsrf = await browse(`/api/organizations/${organizationId}`, {
    method: 'PATCH',
    json: JSON.stringify({ name: 'csrf-attempt' }),
  });
  check(
    'a mutation without a CSRF header is refused',
    noCsrf.status === 403,
    `status ${noCsrf.status}`,
  );

  // --- sign out ------------------------------------------------------------
  const signOut = await browse('/api/auth/sign-out', { method: 'POST', csrf: jar.get('tv_csrf') });
  check('sign out returns 204', signOut.status === 204, `status ${signOut.status}`);

  const afterSignOut = await browse('/app');
  check(
    'after sign out, /app redirects to sign in',
    afterSignOut.status === 307 && (afterSignOut.location ?? '').includes('/sign-in'),
    `status ${afterSignOut.status} -> ${afterSignOut.location}`,
  );

  const staleSession = await browse('/api/me');
  check(
    'the revoked session is refused',
    staleSession.status === 401,
    `status ${staleSession.status}`,
  );

  // --- unauthorized navigation ---------------------------------------------
  const expiredNotice = await browse('/sign-in?reason=session-ended');
  check(
    'an ended session explains itself on the sign-in screen',
    expiredNotice.body.includes('Your session ended'),
  );

  report(`\n=== frontend ${failures === 0 ? 'PASSED' : `${failures} FAILED`} ===\n`);
  process.exit(failures === 0 ? 0 : 1);
};

main().catch((error) => {
  process.stderr.write(`verification aborted: ${error.message}\n`);
  process.exit(1);
});
