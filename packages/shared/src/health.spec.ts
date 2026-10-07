import { describe, expect, it } from 'vitest';

import { HEALTH_STATUS_HTTP_CODE, overallStatusFrom, type DependencyHealth } from './health.js';

const up: DependencyHealth = { status: 'up', latencyMs: 1 };
const down: DependencyHealth = { status: 'down', latencyMs: 1, error: 'unreachable' };

describe('overallStatusFrom', () => {
  it('is ok when every dependency is up', () => {
    expect(overallStatusFrom({ postgres: up, redis: up })).toBe('ok');
  });

  it('is degraded when any dependency is down', () => {
    expect(overallStatusFrom({ postgres: up, redis: down })).toBe('degraded');
  });

  it('is ok when there are no dependencies to probe', () => {
    expect(overallStatusFrom({})).toBe('ok');
  });
});

describe('HEALTH_STATUS_HTTP_CODE', () => {
  it('maps a fully healthy service to 200 and a degraded one to 503', () => {
    expect(HEALTH_STATUS_HTTP_CODE.ok).toBe(200);
    expect(HEALTH_STATUS_HTTP_CODE.degraded).toBe(503);
  });
});
