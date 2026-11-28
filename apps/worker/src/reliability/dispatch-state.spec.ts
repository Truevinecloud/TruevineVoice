import { describe, expect, it } from 'vitest';

import { dispatchVerdict } from './dispatch-state.js';

describe('dispatchVerdict', () => {
  it('treats an emergency marker as terminal cancellation', () => {
    expect(
      dispatchVerdict({
        status: 'COMPLETED',
        dispatchState: 'RUNNING',
        emergencyStoppedAt: new Date(),
      }),
    ).toBe('cancelled');
  });

  it('uses the explicit dispatch fields rather than legacy record status', () => {
    expect(dispatchVerdict({ status: 'ACTIVE', dispatchState: 'PAUSED' })).toBe('paused');
    expect(dispatchVerdict({ status: 'ACTIVE', dispatchState: 'CANCELLED' })).toBe('cancelled');
    expect(dispatchVerdict({ status: 'ACTIVE', dispatchState: 'RUNNING' })).toBe('running');
  });

  it('refuses a record that is not active', () => {
    expect(dispatchVerdict({ status: 'DRAFT', dispatchState: 'RUNNING' })).toBe('not_active');
  });
});
