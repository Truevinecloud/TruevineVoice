import { describe, expect, it } from 'vitest';

import nextConfig from '../../next.config';

describe('admin local development origins', () => {
  it('allows the loopback login URL without allowing arbitrary origins', () => {
    expect(nextConfig.allowedDevOrigins).toEqual(['127.0.0.1']);
    expect(nextConfig.basePath).toBe('/admin');
  });
});
