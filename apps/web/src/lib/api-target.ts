/**
 * Where the API lives, and how this application talks to it.
 *
 * `NEXT_PUBLIC_API_URL` is a **relative** path by default (`/api`), which routes
 * through the same-origin proxy in `src/app/api/[...path]/route.ts`. That is the
 * default on purpose: it needs no CORS configuration and no knowledge of how the
 * API is exposed behind Nginx.
 *
 * A server-side caller (a Server Component) can point `TRUEVINE_API_URL` directly
 * at the API origin, because the server-to-server call has no cookie-origin
 * problem and skipping the proxy hop is simpler. It must never be a
 * `NEXT_PUBLIC_` value: that would put an internal address in the browser bundle.
 */

/** Public base path the browser uses. Always same-origin. */
export function publicApiBase(): string {
  const configured = process.env['NEXT_PUBLIC_API_URL'];

  if (configured === undefined || configured.trim().length === 0) return '/api';

  if (!configured.startsWith('/')) {
    throw new Error(
      'NEXT_PUBLIC_API_URL must be a path beginning with "/". An absolute URL would send the ' +
        'browser to another origin, which requires credentialed CORS and defeats the same-origin ' +
        'proxy.',
    );
  }

  return configured.replace(/\/$/, '');
}

/** Server-side base URL for the API. Never exposed to the browser. */
function serverApiBase(): string {
  const configured = process.env['TRUEVINE_API_URL'];

  if (configured === undefined || configured.trim().length === 0) {
    throw new Error(
      'TRUEVINE_API_URL is not set. Server-side rendering cannot reach the API without it.',
    );
  }

  return configured.replace(/\/$/, '');
}

/** Absolute API URL for a server-side fetch. */
export function apiRequest(path: string): string {
  return `${serverApiBase()}${path.startsWith('/') ? path : `/${path}`}`;
}

/** Browser-facing URL for an API path. */
export function browserApiUrl(path: string): string {
  return `${publicApiBase()}${path.startsWith('/') ? path : `/${path}`}`;
}
