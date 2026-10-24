import { describe, expect, it } from 'vitest';

import { AudioValidationError, validateAudioBytes, validateTtsRequest } from './audio.port.js';

describe('audio validation', () => {
  it('accepts a matching WebM signature and rejects MIME spoofing', () => {
    const webm = Uint8Array.from([0x1a, 0x45, 0xdf, 0xa3, 0x00]);
    expect(validateAudioBytes(webm, 'audio/webm')).toBe('audio/webm');
    expect(() => validateAudioBytes(webm, 'audio/mpeg')).toThrow(AudioValidationError);
  });

  it('rejects empty and oversized files', () => {
    expect(() => validateAudioBytes(new Uint8Array(), 'audio/wav')).toThrow(/between/);
    expect(() => validateAudioBytes(new Uint8Array(10 * 1024 * 1024 + 1), 'audio/wav')).toThrow(
      /between/,
    );
  });

  it('trims bounded TTS text and rejects empty or oversized text', () => {
    expect(validateTtsRequest(' hello ', 'Joanna')).toEqual({ text: 'hello', voice: 'Joanna' });
    expect(() => validateTtsRequest('  ', 'Joanna')).toThrow(/Enter text/);
    expect(() => validateTtsRequest('x'.repeat(3001), 'Joanna')).toThrow(/3000/);
  });
});
