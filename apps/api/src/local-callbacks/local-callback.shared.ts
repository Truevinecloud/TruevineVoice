/** Shared constants and pure checks for the local-only synthetic callback route. */

export const LOCAL_CALLBACK_PATH = '/local/callbacks/synthetic';
export const LOCAL_CALLBACK_KEY_HEADER = 'x-truevine-local-callback-key';

/** Express reports IPv4-mapped IPv6 loopback as `::ffff:127.0.0.1`. */
export function isLoopbackAddress(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  const address = value.trim().toLowerCase().replace(/^::ffff:/, '');
  return (
    address === 'localhost' ||
    address === '::1' ||
    address === '[::1]' ||
    /^127(?:\.\d{1,3}){3}$/.test(address)
  );
}

/** The test contract accepts exactly one media type, with no parameters. */
export function hasJsonContentType(value: unknown): boolean {
  return typeof value === 'string' && value.trim().toLowerCase() === 'application/json';
}
