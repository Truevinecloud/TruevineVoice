/**
 * The password policy, mirrored for the browser.
 *
 * Kept beside the form rather than imported from `@truevine/auth` because that
 * module's entry point is safe in a browser but this file sits next to the
 * component that needs it, and a client component importing a workspace package
 * pulls its whole module graph into the bundle.
 *
 * The server enforces the same minimum through `checkPassword` in
 * `@truevine/auth/passwords`. This copy exists only so the form can disable its
 * submit button before a pointless round trip - it is never the authority.
 */
export const MIN_PASSWORD_LENGTH = 12;
