/**
 * Conversions between API ISO-8601 instants and the local value a
 * `<input type="datetime-local">` displays.
 *
 * The browser control carries no timezone: `2026-10-27T14:30` means 14:30 on
 * the operator's own wall clock. The API requires an explicit offset.
 *
 * The previous implementation used `new Date(value).toISOString().slice(0, 16)`
 * for both directions, which is wrong twice over:
 *
 * - reading a stored instant produced a **UTC** clock inside a control the
 *   operator reads as local time, so a 14:30 Kampala schedule showed as 11:30;
 * - submitting produced `2026-10-27T14:30`, a string with no offset that the
 *   API rejects because the instant is ambiguous.
 *
 * These two helpers are the only place that conversion happens.
 */

const pad = (value: number): string => String(value).padStart(2, '0');

/** Formats an instant for `<input type="datetime-local">` in the local zone. */
export function localDateTimeValue(iso: string | null | undefined): string {
  if (!iso) return '';

  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';

  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/**
 * Converts a `<input type="datetime-local">` value to an ISO-8601 instant with
 * an explicit `Z`, which is what the API validates.
 *
 * `new Date('2026-10-27T14:30')` is parsed as local time by the ECMAScript
 * date-time grammar, so the returned instant is the same moment the operator
 * picked in their own zone.
 */
export function isoFromLocalDateTime(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;

  const date = new Date(trimmed);
  if (Number.isNaN(date.getTime())) return null;

  return date.toISOString();
}

/** A short, human-readable local rendering of an instant, or a clear fallback. */
export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return 'Not set';

  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return 'Not set';

  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(date);
}

/**
 * The earliest value a new schedule may hold: the API refuses anything less
 * than five minutes ahead, so the control offers the same boundary.
 */
export function minimumScheduleValue(now = new Date()): string {
  return localDateTimeValue(new Date(now.getTime() + 5 * 60_000).toISOString());
}

/** The latest value a new schedule may hold: the API allows one year ahead. */
export function maximumScheduleValue(now = new Date()): string {
  return localDateTimeValue(new Date(now.getTime() + 365 * 24 * 60 * 60_000).toISOString());
}
