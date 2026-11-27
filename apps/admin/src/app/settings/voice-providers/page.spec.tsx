import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { api } from '../../../lib/api';
import VoiceProvidersPage from './page';

vi.mock('../../../lib/api', () => ({ api: vi.fn() }));
afterEach(cleanup);

describe('Voice Providers settings', () => {
  it('keeps the stored key out of the form and clears a replacement on submission', async () => {
    const configuration = {
      environment: 'SANDBOX',
      username: 'sandbox',
      voiceNumber: '+256700000000',
      keyPresent: true,
      enabled: false,
      checkedAt: null,
      checkResult: null,
    };
    vi.mocked(api).mockResolvedValueOnce([configuration]).mockResolvedValueOnce(configuration);
    render(<VoiceProvidersPage />);
    const key = await screen.findByLabelText('Replace API key') as HTMLInputElement;
    expect(key.type).toBe('password');
    expect(key.value).toBe('');
    fireEvent.change(key, { target: { value: 'synthetic-replacement' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save configuration' }));
    await waitFor(() => expect(api).toHaveBeenCalledWith('/platform/voice-providers/SANDBOX', {
      method: 'PUT',
      body: JSON.stringify({ username: 'sandbox', voiceNumber: '+256700000000', apiKey: 'synthetic-replacement' }),
    }));
    expect(key.value).toBe('');
    expect(await screen.findByText(/API key saved\. The field was cleared for safety/)).toBeTruthy();
  });
});
