import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { WalletAdjustmentConfirmation, type WalletAdjustmentPreview } from './billing-ui';

const preview: WalletAdjustmentPreview = {
  organizationId: 'org-123',
  organizationName: 'Test Org',
  amountMinor: '5000',
  currency: 'UGX',
  reason: 'Correction for overcharge',
};

describe('WalletAdjustmentConfirmation interactions', () => {
  it('calls onConfirm exactly once when confirm button is clicked', async () => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    render(
      <WalletAdjustmentConfirmation
        preview={preview}
        busy={false}
        error=""
        onConfirm={onConfirm}
        onCancel={onCancel}
      />,
    );

    await userEvent.click(screen.getByRole('button', { name: 'Confirm adjustment' }));

    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onCancel).not.toHaveBeenCalled();
  });

  it('calls onCancel exactly once when cancel button is clicked', async () => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    render(
      <WalletAdjustmentConfirmation
        preview={preview}
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
      <WalletAdjustmentConfirmation
        preview={preview}
        busy={true}
        error=""
        onConfirm={onConfirm}
        onCancel={onCancel}
      />,
    );

    // Button should be disabled when busy
    const confirmButton = screen.getByRole('button', { name: 'Recording…' });
    expect(confirmButton).toBeDisabled();

    // Even if we try to click, it should not fire
    await userEvent.click(confirmButton);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('shows error message when error prop is provided', () => {
    render(
      <WalletAdjustmentConfirmation
        preview={preview}
        busy={false}
        error="Insufficient balance"
        onConfirm={() => {}}
        onCancel={() => {}}
      />,
    );

    expect(screen.getByRole('alert')).toHaveTextContent('Insufficient balance');
  });

  it('displays preview details correctly', () => {
    render(
      <WalletAdjustmentConfirmation
        preview={preview}
        busy={false}
        error=""
        onConfirm={() => {}}
        onCancel={() => {}}
      />,
    );

    expect(screen.getByText('Test Org')).toBeInTheDocument();
    expect(screen.getByText('5000 UGX (minor units)')).toBeInTheDocument();
    expect(screen.getByText('Correction for overcharge')).toBeInTheDocument();
  });
});