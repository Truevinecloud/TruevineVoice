import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { WalletAdjustmentConfirmation, type WalletAdjustmentPreview } from './billing-ui';

const preview: WalletAdjustmentPreview = {
  organizationId: 'org-123',
  organizationName: 'Test Org',
  amountMinor: '5000',
  currency: 'UGX',
  reason: 'Correction for overcharge',
};

describe('WalletAdjustmentConfirmation', () => {
  it('renders confirmation dialog with preview details', () => {
    const markup = renderToStaticMarkup(
      <WalletAdjustmentConfirmation
        preview={preview}
        busy={false}
        error=""
        onConfirm={() => {}}
        onCancel={() => {}}
      />,
    );
    expect(markup).toContain('Confirm wallet adjustment');
    expect(markup).toContain('Test Org');
    expect(markup).toContain('5000 UGX (minor units)');
    expect(markup).toContain('Correction for overcharge');
    expect(markup).toContain('append-only ledger entry');
    expect(markup).toContain('role="alertdialog"');
    expect(markup).toContain('aria-labelledby');
    expect(markup).toContain('aria-describedby');
  });

  it('shows loading state when busy', () => {
    const markup = renderToStaticMarkup(
      <WalletAdjustmentConfirmation
        preview={preview}
        busy={true}
        error=""
        onConfirm={() => {}}
        onCancel={() => {}}
      />,
    );
    expect(markup).toContain('Recording…');
    expect(markup).not.toContain('Confirm adjustment');
  });

  it('displays error when provided', () => {
    const markup = renderToStaticMarkup(
      <WalletAdjustmentConfirmation
        preview={preview}
        busy={false}
        error="Insufficient balance"
        onConfirm={() => {}}
        onCancel={() => {}}
      />,
    );
    expect(markup).toContain('Insufficient balance');
    expect(markup).toContain('role="alert"');
  });

  it('has confirm and cancel buttons', () => {
    const markup = renderToStaticMarkup(
      <WalletAdjustmentConfirmation
        preview={preview}
        busy={false}
        error=""
        onConfirm={() => {}}
        onCancel={() => {}}
      />,
    );
    expect(markup).toContain('Confirm adjustment');
    expect(markup).toContain('Cancel');
    expect(markup).toContain('danger-button');
    expect(markup).toContain('quiet-button');
  });

  it('disables buttons when busy', () => {
    const markup = renderToStaticMarkup(
      <WalletAdjustmentConfirmation
        preview={preview}
        busy={true}
        error=""
        onConfirm={() => {}}
        onCancel={() => {}}
      />,
    );
    expect(markup).toContain('disabled=""');
  });
});