/**
 * Backend-for-frontend proxy to the NestJS API.
 *
 * WHY A PROXY AT ALL
 * ------------------
 * The API sets its session cookie as HTTP-only on its own origin. If the browser
 * talked to the API directly, every request would need CORS with credentials and
 * an exact origin, and the deployment topology would have to guarantee the API is
 * browser-reachable. Proxying through the Next origin means the browser only
 * ever speaks to one origin: no CORS, and no assumption about how the API is
 * exposed behind Nginx.
 *
 * WHY IT DOES NOT WEAKEN CSRF
 * ---------------------------
 * The obvious convenience - "read the CSRF cookie here and set the header" -
 * would defeat the double-submit pattern completely, because the proxy runs on
 * the same origin as the attacker-controlled page's target. The cookie would be
 * attached and the header fabricated, and every mutation would be forgeable.
 *
 * So the proxy does exactly three things: forward the cookies, forward whatever
 * headers the client sent, and forward the response. **It never adds a CSRF
 * header.** The browser reads the `tv_csrf` cookie itself - it is deliberately
 * not HTTP-only - and echoes it. That keeps the check genuinely double-submit.
 *
 * The session token never enters JavaScript either: it is set as an HTTP-only
 * cookie by the API and only ever travels as a cookie header.
 */

import { NextResponse, type NextRequest } from 'next/server';

import { apiRequest } from '../../../lib/api-target';

/**
 * The API paths this proxy will forward.
 *
 * An open proxy on a server that holds an HTTP-only session cookie would be a
 * serious vulnerability, so the allowlist is explicit and exact. Anything not
 * listed is refused here rather than forwarded and hoped for.
 *
 * Patterns use `:name` for a single path segment. They are matched against the
 * *method-qualified* path (`GET /organizations/1`) so that `DELETE
 * /organizations/1` cannot be satisfied by a `GET` rule.
 */
const ALLOWED_ROUTES: ReadonlyArray<{ readonly method: string; readonly pattern: RegExp }> = [
  // Authentication. Mutations are reachable, but the API's CSRF guard applies.
  { method: 'POST', pattern: /^\/auth\/sign-in$/ },
  { method: 'POST', pattern: /^\/auth\/sign-out$/ },
  { method: 'POST', pattern: /^\/auth\/terms\/accept$/ },
  { method: 'GET', pattern: /^\/auth\/terms$/ },
  { method: 'POST', pattern: /^\/auth\/password-reset\/request$/ },
  { method: 'POST', pattern: /^\/auth\/password-reset\/complete$/ },

  // The caller.
  { method: 'GET', pattern: /^\/me$/ },

  // Organization resources.
  { method: 'GET', pattern: /^\/organizations\/[^/]+$/ },
  { method: 'PATCH', pattern: /^\/organizations\/[^/]+$/ },
  { method: 'GET', pattern: /^\/organizations\/[^/]+\/members$/ },
  { method: 'PATCH', pattern: /^\/organizations\/[^/]+\/members\/[^/]+$/ },
  { method: 'DELETE', pattern: /^\/organizations\/[^/]+\/members\/[^/]+$/ },
  { method: 'GET', pattern: /^\/organizations\/[^/]+\/invitations$/ },
  { method: 'POST', pattern: /^\/organizations\/[^/]+\/invitations$/ },
  { method: 'DELETE', pattern: /^\/organizations\/[^/]+\/invitations\/[^/]+$/ },
  { method: 'POST', pattern: /^\/organizations\/[^/]+\/ownership\/transfer$/ },

  // Invitation acceptance.
  { method: 'POST', pattern: /^\/invitations\/accept$/ },
];

/** Headers the proxy passes through untouched. */
const FORWARDED_REQUEST_HEADERS = [
  'content-type',
  'x-truevine-csrf',
  'accept',
  'accept-language',
] as const;

/** Response headers passed back, so the API can set its cookies. */
const FORWARDED_RESPONSE_HEADERS = ['content-type', 'set-cookie', 'cache-control'] as const;

/** Whether this method and path may be proxied. */
export function isAllowed(method: string, path: string): boolean {
  return ALLOWED_ROUTES.some((route) => route.method === method && route.pattern.test(path));
}

/** The route table, exported so a test can assert the allowlist has not grown. */
export function allowedRoutes(): readonly string[] {
  return ALLOWED_ROUTES.map((route) => `${route.method} ${route.pattern.source}`);
}

async function proxy(request: NextRequest): Promise<NextResponse> {
  const path = request.nextUrl.pathname.replace(/^\/api/, '') || '/';

  if (!isAllowed(request.method, path)) {
    // 404 rather than 403: a caller should not be able to probe which API
    // operations exist through this proxy.
    return NextResponse.json(
      { error: { code: 'not_found', message: 'Not found.' } },
      { status: 404 },
    );
  }

  const target = apiRequest(path);

  const headers = new Headers();
  for (const name of FORWARDED_REQUEST_HEADERS) {
    const value = request.headers.get(name);
    if (value !== null) headers.set(name, value);
  }

  // Forward cookies verbatim. The session token stays a cookie and is never
  // exposed to script, here or anywhere else.
  const cookie = request.headers.get('cookie');
  if (cookie !== null) headers.set('cookie', cookie);

  const body =
    request.method === 'GET' || request.method === 'HEAD' ? undefined : await request.text();

  let upstream: Response;

  try {
    upstream = await fetch(target, {
      method: request.method,
      headers,
      body,
      redirect: 'manual',
      cache: 'no-store',
    });
  } catch {
    // The API being unreachable is not the browser's fault, and leaking the
    // internal URL or the connection error would help somebody map the network.
    return NextResponse.json(
      {
        error: {
          code: 'upstream_unavailable',
          message: 'The service is temporarily unavailable. Please try again.',
        },
      },
      { status: 502 },
    );
  }

  return buildUpstreamResponse(upstream);
}

/**
 * Translates an upstream API response into one this proxy can return.
 *
 * Split out from `proxy` so it can be tested directly. The 204 case below is a
 * genuine defect this function exists to prevent: the proxy's own allowlist
 * covers five operations that answer 204, and every one of them returned 500
 * through the browser until this was fixed. An allowlist test cannot see that,
 * because the failure is in how the response is *constructed*, not in what was
 * permitted.
 */
export async function buildUpstreamResponse(upstream: Response): Promise<NextResponse> {
  const responseHeaders = new Headers();
  for (const name of FORWARDED_RESPONSE_HEADERS) {
    const value = upstream.headers.get(name);
    if (value !== null) responseHeaders.set(name, value);
  }

  // Never cache an authenticated response.
  responseHeaders.set('cache-control', 'no-store');

  // 204 and 304 must be constructed with a null body. Passing even an empty
  // string throws `Invalid response status code 204`, which surfaces as a 500
  // from the proxy for every sign-out, terms acceptance, member removal and
  // invitation revocation - the whole write side of the application.
  const bodiless = upstream.status === 204 || upstream.status === 304;
  const payload = bodiless ? null : await upstream.text();

  return new NextResponse(payload, {
    status: upstream.status,
    headers: responseHeaders,
  });
}

export const GET = proxy;
export const POST = proxy;
export const PATCH = proxy;
export const PUT = proxy;
export const DELETE = proxy;
