import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { PlatformAdminConfirmation, type RoleActionPreview } from './platform-admin-ui';

const grantPreview: RoleActionPreview = {
  action: 'grant',
  userId: 'user-123',
  email: 'operator@example.com',
  role: 'AUDITOR',
  reasonCode: 'security_incident',
  justification: 'Incident response review',
};

const revokePreview: RoleActionPreview = {
  action: 'revoke',
  userId: 'user-123',
  email: 'operator@example.com',
  role: 'AUDITOR',
  reasonCode: 'routine_administration',
  justification: '',
};

describe('PlatformAdminConfirmation interactions', () => {
  it('calls onConfirm exactly once when confirm button is clicked (grant)', async () => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    render(
      <PlatformAdminConfirmation
        preview={grantPreview}
        busy={false}
        error=""
        onConfirm={onConfirm}
        onCancel={onCancel}
      />,
    );

    await userEvent.click(screen.getByRole('button', { name: 'Confirm grant' }));

    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onCancel).not.toHaveBeenCalled();
  });

  it('calls onConfirm exactly once when confirm button is clicked (revoke)', async () => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    render(
      <PlatformAdminConfirmation
        preview={revokePreview}
        busy={false}
        error=""
        onConfirm={onConfirm}
        onCancel={onCancel}
      />,
    );

    await userEvent.click(screen.getByRole('button', { name: 'Confirm revoke' }));

    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onCancel).not.toHaveBeenCalled();
  });

  it('calls onCancel exactly once when cancel button is clicked', async () => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    render(
      <PlatformAdminConfirmation
        preview={grantPreview}
        busy={false}
        error=""
        onConfirm={onConfirm}
        onCancel={onCancel}
      />,
    );

    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('does not call onConfirm again when confirm button is clicked while busy', async () => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    render(
      <PlatformAdminConfirmation
        preview={grantPreview}
        busy={true}
        error=""
        onConfirm={onConfirm}
        onCancel={onCancel}
      />,
    );

    // Button should be disabled when busy
    const confirmButton = screen.getByRole('button', { name: 'Saving…' });
    expect(confirmButton).toBeDisabled();

    // Even if we try to click, it should not fire
    await userEvent.click(confirmButton);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('shows error message when error prop is provided', () => {
    render(
      <PlatformAdminConfirmation
        preview={grantPreview}
        busy={false}
        error="Last platform owner cannot be removed"
        onConfirm={() => {}}
        onCancel={() => {}}
      />,
    );

    expect(screen.getByRole('alert')).toHaveTextContent('Last platform owner cannot be removed');
  });

  it('displays preview details correctly for grant', () => {
    render(
      <PlatformAdminConfirmation
        preview={grantPreview}
        busy={false}
        error=""
        onConfirm={() => {}}
        onCancel={() => {}}
      />,
    );

    expect(screen.getByText('operator@example.com')).toBeInTheDocument();
    expect(screen.getByText('AUDITOR')).toBeInTheDocument();
    expect(screen.getByText('Grant')).toBeInTheDocument();
    expect(screen.getByText('security_incident')).toBeInTheDocument();
    expect(screen.getByText('Incident response review')).toBeInTheDocument();
  });

  it('displays preview details correctly for revoke', () => {
    render(
      <PlatformAdminConfirmation
        preview={revokePreview}
        busy={false}
        error=""
        onConfirm={() => {}}
        onCancel={() => {}}
      />,
    );

    expect(screen.getByText('operator@example.com')).toBeInTheDocument();
    expect(screen.getByText('AUDITOR')).toBeInTheDocument();
    expect(screen.getByText('Revoke')).toBeInTheDocument();
    expect(screen.getByText('routine_administration')).toBeInTheDocument();
    expect(screen.getByText('—')).toBeInTheDocument();
  });
});