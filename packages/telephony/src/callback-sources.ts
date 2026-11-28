/**
 * Durable callback namespaces.
 *
 * A receipt may only resolve against a binding created by the same trusted
 * dispatch source. These values are part of the database identity of both
 * `voice_callback_bindings` and `voice_callback_receipts`, so they must stay
 * explicit and stable. No inference by session ID alone is permitted.
 */

export const CALLBACK_SOURCES = Object.freeze({
  africasTalking: 'africas-talking',
  fake: 'fake',
  synthetic: 'synthetic',
} as const);

export type CallbackSource = (typeof CALLBACK_SOURCES)[keyof typeof CALLBACK_SOURCES];

const VALUES: ReadonlySet<string> = new Set(Object.values(CALLBACK_SOURCES));

/** Rejects an untrusted or unknown source before it reaches a database query. */
export function parseCallbackSource(value: string): CallbackSource {
  if (typeof value !== 'string' || !VALUES.has(value))
    throw new TypeError('invalid_callback_source');
  return value as CallbackSource;
}
