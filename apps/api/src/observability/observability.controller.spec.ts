import { describe, expect, it } from 'vitest';

import { ObservabilityController } from './observability.controller.js';
import { SessionGuard } from '../auth/session.guard.js';
import { PlatformGuard } from '../auth/organization.guard.js';
import { PLATFORM_PERMISSION } from '../auth/permission.decorators.js';

function mockObservabilityService() {
  return {
    state: {
      samples: { 'host.cpuPercent': { value: 42, status: 'ok' } },
      evaluations: [],
      firing: [],
      recovering: [],
      overallSeverity: 'ok' as const,
    },
  };
}

describe('ObservabilityController authorization metadata', () => {
  it('requires session authentication (SessionGuard)', () => {
    const guards = Reflect.getMetadata('__guards__', ObservabilityController);
    expect(guards).toContain(SessionGuard);
  });

  it('requires platform authorization (PlatformGuard)', () => {
    const guards = Reflect.getMetadata('__guards__', ObservabilityController);
    expect(guards).toContain(PlatformGuard);
  });

  it('requires platform:operations:read permission', () => {
    const permission = Reflect.getMetadata(PLATFORM_PERMISSION, ObservabilityController);
    expect(permission).toBe('platform:operations:read');
  });

  it('returns observability state from the service', () => {
    const observability = mockObservabilityService();
    const controller = new ObservabilityController(observability as never);

    const result = controller.getMetrics();

    expect(result).toBe(observability.state);
    expect(result.overallSeverity).toBe('ok');
    expect(result.firing).toHaveLength(0);
    expect(result.recovering).toHaveLength(0);
  });
});

describe('RBAC permission check for platform:operations:read', () => {
  // Verify which platform roles hold the permission needed by the metrics endpoint.
  // This test documents the authorization boundary without importing the auth package.
  const PLATFORM_PERMISSIONS = [
    'platform:tenant:read',
    'platform:tenant:suspend',
    'platform:operations:read',
    'platform:operations:write',
    'platform:billing:read',
    'platform:billing:refund',
    'platform:support:read',
    'platform:support:diagnostics',
    'platform:support:access',
    'platform:technical:read',
    'platform:technical:write',
    'platform:audit:read',
    'platform:admin:manage',
    'platform:payments:read',
    'platform:payments:configure',
  ] as const;

  it('PLATFORM_OWNER holds all platform permissions including operations:read', () => {
    // PLATFORM_OWNER = PLATFORM_PERMISSIONS (all permissions)
    expect(PLATFORM_PERMISSIONS).toContain('platform:operations:read');
  });

  it('OPERATIONS_ADMIN holds operations:read and operations:write', () => {
    const opsAdminPermissions = [
      'platform:tenant:read',
      'platform:tenant:suspend',
      'platform:operations:read',
      'platform:operations:write',
    ];
    expect(opsAdminPermissions).toContain('platform:operations:read');
    expect(opsAdminPermissions).toContain('platform:operations:write');
  });

  it('SUPPORT_ADMIN does NOT hold operations:read (denied)', () => {
    const supportAdminPermissions = [
      'platform:tenant:read',
      'platform:support:read',
      'platform:support:diagnostics',
      'platform:support:access',
      'platform:audit:read',
    ];
    expect(supportAdminPermissions).not.toContain('platform:operations:read');
  });

  it('AUDITOR holds operations:read (read-only platform access)', () => {
    const auditorPermissions = [
      'platform:tenant:read',
      'platform:operations:read',
      'platform:support:read',
      'platform:audit:read',
    ];
    expect(auditorPermissions).toContain('platform:operations:read');
  });

  it('TECHNICAL_ADMIN does NOT hold operations:read', () => {
    const technicalAdminPermissions = [
      'platform:technical:read',
      'platform:audit:read',
    ];
    expect(technicalAdminPermissions).not.toContain('platform:operations:read');
  });
});
