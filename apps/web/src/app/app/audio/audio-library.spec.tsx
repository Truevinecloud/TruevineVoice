// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AudioLibrary } from './audio-library';

const api = vi.hoisted(() => ({
  request: vi.fn(),
  upload: vi.fn(),
  messageFor: vi.fn(() => 'Request failed.'),
}));
vi.mock('../../../lib/api', () => api);

class FakeMediaRecorder {
  static isTypeSupported(): boolean {
    return true;
  }
  mimeType = 'audio/webm;codecs=opus';
  ondataavailable: ((event: { data: Blob }) => void) | null = null;
  onstop: (() => void) | null = null;
  constructor(_stream: MediaStream, _options?: MediaRecorderOptions) {}
  start(): void {}
  stop(): void {
    this.ondataavailable?.({
      data: new Blob([Uint8Array.from([0x1a, 0x45, 0xdf, 0xa3])], { type: this.mimeType }),
    });
    this.onstop?.();
  }
}

describe('audio library UI', () => {
  let container: HTMLDivElement;
  let root: Root;
  beforeEach(async () => {
    vi.clearAllMocks();
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    globalThis.MediaRecorder = FakeMediaRecorder as unknown as typeof MediaRecorder;
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: { getUserMedia: vi.fn(async () => ({ getTracks: () => [{ stop: vi.fn() }] })) },
    });
    api.request.mockImplementation(async (path: string) => {
      if (path.endsWith('/voices'))
        return {
          available: true,
          storageAvailable: true,
          voices: [{ id: 'Joanna', label: 'Joanna', language: 'en-US' }],
        };
      if (path.endsWith('/audio-assets')) return [];
      return {};
    });
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    await act(async () => {
      root.render(<AudioLibrary organizationId="tenant-a" canCreate />);
    });
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  it('sends bounded TTS input through the same-origin API with an idempotency key', async () => {
    const name = container.querySelector('input')!;
    const script = container.querySelector('textarea')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(
        name,
        'Welcome',
      );
      name.dispatchEvent(new Event('input', { bubbles: true }));
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(
        script,
        'Hello there',
      );
      script.dispatchEvent(new Event('input', { bubbles: true }));
    });
    const button = [...container.querySelectorAll('button')].find(
      (item) => item.textContent === 'Generate and save',
    )!;
    await act(async () => {
      button.click();
    });
    expect(api.request).toHaveBeenCalledWith(
      '/organizations/tenant-a/audio-assets/tts',
      expect.objectContaining({
        method: 'POST',
        headers: { 'idempotency-key': expect.any(String) },
        body: { name: 'Welcome', text: 'Hello there', voice: 'Joanna' },
      }),
    );
  });

  it('records microphone audio and uploads it using multipart handling', async () => {
    await act(async () => {
      [...container.querySelectorAll('button')]
        .find((item) => item.textContent === 'Start recording')!
        .click();
    });
    await act(async () => {
      [...container.querySelectorAll('button')]
        .find((item) => item.textContent === 'Stop and save recording')!
        .click();
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(api.upload).toHaveBeenCalledWith(
      '/organizations/tenant-a/audio-assets/recordings',
      expect.any(Blob),
      expect.stringMatching(/^Recording /),
      expect.any(String),
    );
  });
});
