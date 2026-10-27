import { describe, expect, it } from 'vitest';

import {
  formatDateTime,
  isoFromLocalDateTime,
  localDateTimeValue,
  maximumScheduleValue,
  minimumScheduleValue,
} from './datetime';

/** The local wall clock a `datetime-local` control would display for an instant. */
function expectedLocal(iso: string): string {
  const date = new Date(iso);
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

describe('datetime-local conversion', () => {
  it('round-trips a local wall-clock value through an ISO instant', () => {
    const value = '2026-11-05T14:30';
    const iso = isoFromLocalDateTime(value);

    expect(iso).not.toBeNull();
    expect(localDateTimeValue(iso)).toBe(value);
  });

  it('displays a stored instant in the operator’s local zone, not UTC', () => {
    // Regression: `toISOString().slice(0, 16)` put the UTC clock into a control
    // the operator reads as local time, shifting the schedule by the offset.
    const iso = '2026-10-27T11:30:00.000Z';

    expect(localDateTimeValue(iso)).toBe(expectedLocal(iso));
  });

  it('submits an instant with an explicit offset instead of a bare local string', () => {
    const iso = isoFromLocalDateTime('2026-10-27T14:30');

    // The API rejects an instant it cannot place on the timeline.
    expect(iso).toMatch(/Z$/);
    expect(iso).toBe(new Date('2026-10-27T14:30').toISOString());
  });

  it('returns null or an empty string for missing and invalid values', () => {
    expect(isoFromLocalDateTime('')).toBeNull();
    expect(isoFromLocalDateTime('   ')).toBeNull();
    expect(isoFromLocalDateTime('not-a-date')).toBeNull();
    expect(localDateTimeValue(null)).toBe('');
    expect(localDateTimeValue(undefined)).toBe('');
    expect(localDateTimeValue('not-a-date')).toBe('');
    expect(formatDateTime(null)).toBe('Not set');
    expect(formatDateTime('not-a-date')).toBe('Not set');
  });

  it('formats a real instant for review', () => {
    expect(formatDateTime('2026-10-27T11:30:00.000Z')).not.toBe('Not set');
  });

  it('offers schedule boundaries the API accepts', () => {
    const now = new Date('2026-10-27T10:00:00.000Z');
    const minimum = isoFromLocalDateTime(minimumScheduleValue(now));
    const maximum = isoFromLocalDateTime(maximumScheduleValue(now));

    expect(new Date(minimum!)).toEqual(new Date(now.getTime() + 5 * 60_000));
    expect(new Date(maximum!)).toEqual(new Date(now.getTime() + 365 * 24 * 60 * 60_000));
  });
});
