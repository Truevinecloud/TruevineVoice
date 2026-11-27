import { RequestMethod } from '@nestjs/common';
import { ACCEPTED_TERMS, ORGANIZATION_PERMISSION } from '../auth/permission.decorators.js';
import {
  GUARDS_METADATA,
  METHOD_METADATA,
  MODULE_METADATA,
  PATH_METADATA,
} from '@nestjs/common/constants';
import { describe, expect, it } from 'vitest';

import { AppModule } from '../app.module.js';
import { CsrfGuard } from '../auth/csrf.guard.js';
import { OrganizationGuard } from '../auth/organization.guard.js';
import { SessionGuard } from '../auth/session.guard.js';

import { AnalyticsController } from './analytics.controller.js';
import { AnalyticsModule } from './analytics.module.js';
import { AnalyticsService } from './analytics.service.js';
import { ANALYTICS_READER } from './analytics.tokens.js';

const EXPECTED_ROUTES: Readonly<Record<string, string>> = {
  summary: 'organizations/:organizationId/analytics/summary',
  campaigns: 'organizations/:organizationId/analytics/campaigns',
  campaign: 'organizations/:organizationId/analytics/campaigns/:campaignId',
  callLogs: 'organizations/:organizationId/analytics/calls',
  campaignCallLogs: 'organizations/:organizationId/analytics/campaigns/:campaignId/calls',
  csv: 'organizations/:organizationId/analytics/calls.csv',
};

function handler(name: keyof typeof EXPECTED_ROUTES): object {
  const value = (AnalyticsController.prototype as unknown as Record<string, unknown>)[name];
  expect(typeof value, name).toBe('function');
  return value as object;
}

describe('W5-03C analytics HTTP wiring', () => {
  it('registers every analytics route as an authenticated reporting:read handler', () => {
    for (const [name, path] of Object.entries(EXPECTED_ROUTES)) {
      const route = handler(name as keyof typeof EXPECTED_ROUTES);
      const guards = (Reflect.getMetadata(GUARDS_METADATA, route) ?? []) as unknown[];

      expect(Reflect.getMetadata(PATH_METADATA, route), name).toBe(path);
      expect(Reflect.getMetadata(METHOD_METADATA, route), name).toBe(RequestMethod.GET);
      expect(guards, name).toEqual(
        expect.arrayContaining([SessionGuard, OrganizationGuard, CsrfGuard]),
      );
      expect(Reflect.getMetadata(ACCEPTED_TERMS, route), name).toBe(true);
      expect(Reflect.getMetadata(ORGANIZATION_PERMISSION, route), name).toBe('reporting:read');
    }
  });

  it('binds the controller, service and adapter token in AnalyticsModule', () => {
    expect(Reflect.getMetadata(MODULE_METADATA.CONTROLLERS, AnalyticsModule)).toContain(
      AnalyticsController,
    );
    expect(Reflect.getMetadata(MODULE_METADATA.PROVIDERS, AnalyticsModule)).toContain(
      AnalyticsService,
    );

    const providers = Reflect.getMetadata(MODULE_METADATA.PROVIDERS, AnalyticsModule) as readonly {
      readonly provide?: unknown;
    }[];
    const reader = providers.find((provider) => provider.provide === ANALYTICS_READER);
    expect(reader).toBeDefined();
  });

  it('registers AnalyticsModule in AppModule', () => {
    const imports = Reflect.getMetadata(MODULE_METADATA.IMPORTS, AppModule) as readonly unknown[];
    expect(imports).toContain(AnalyticsModule);
  });
});
