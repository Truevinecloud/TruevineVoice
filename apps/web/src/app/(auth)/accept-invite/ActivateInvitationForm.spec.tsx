import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

vi.mock('next/navigation', () => ({ useRouter: () => ({ replace: vi.fn() }) }));
vi.mock('../../../lib/api', () => ({
  ApiError: class ApiError extends Error {},
  ensureCsrfToken: vi.fn(),
  messageFor: vi.fn(() => 'Request failed.'),
  request: vi.fn(),
}));

import { ActivateInvitationForm } from './ActivateInvitationForm';

describe('invitee activation form', () => {
  it('asks a new invitee to set and confirm a password without offering role or tenant selection', () => {
    const markup = renderToStaticMarkup(<ActivateInvitationForm token="opaque-invitation-token" />);
    expect(markup).toContain('Set a password to activate the account invited to this organization');
    expect(markup).toContain('New password');
    expect(markup).toContain('Confirm password');
    expect(markup).not.toContain('Organization role');
    expect(markup).not.toContain('Organization ID');
  });
});
