import { describe, expect, it } from 'vitest';
import { selectMembership } from './organization-context';
import type { MembershipSummary } from './session';
const a: MembershipSummary = {
  organizationId: 'a',
  organizationName: 'Alpha',
  organizationSlug: 'alpha',
  role: 'OWNER',
  permissions: [],
};
const b: MembershipSummary = {
  ...a,
  organizationId: 'b',
  organizationName: 'Beta',
  role: 'VIEWER',
};
describe('organization URL context', () => {
  it('defaults only when the organization parameter is absent', () => {
    expect(selectMembership([a, b], undefined)).toBe(a);
    expect(selectMembership([a, b], null)).toBe(a);
    expect(selectMembership([a, b], '')).toBeUndefined();
    expect(selectMembership([a, b], 'foreign')).toBeUndefined();
    expect(selectMembership([], undefined)).toBeUndefined();
  });
  it('selects the exact authenticated membership and rejects ambiguous repeated parameters', () => {
    expect(selectMembership([a, b], 'b')).toBe(b);
    expect(selectMembership([a, b], ['b'])).toBe(b);
    expect(selectMembership([a, b], ['a', 'b'])).toBeUndefined();
    expect(selectMembership([a, b], ['foreign'])).toBeUndefined();
    expect(selectMembership([{ ...a, organizationStatus: 'SUSPENDED' }, b], undefined)).toBe(b);
    expect(selectMembership([{ ...a, organizationStatus: 'SUSPENDED' }, b], 'a')).toBeUndefined();
  });
});
