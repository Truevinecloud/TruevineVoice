/**
 * Metadata-driven permission requirements.
 *
 * A route states what it needs; the guard reads it. The alternative - each
 * controller calling a check inline - is how an endpoint ends up validating the
 * wrong permission, or forgetting to validate one at all. Declaring the
 * requirement on the route makes it visible in a diff and impossible to skip.
 */

import { SetMetadata, createParamDecorator, type ExecutionContext } from '@nestjs/common';
import type { OrganizationPermission, PlatformPermission } from '@truevine/auth';

import {
  ORGANIZATION_CONTEXT,
  PRINCIPAL,
  type AuthenticatedRequest,
  type OrganizationContext,
  type Principal,
} from './principal.js';

export const ORGANIZATION_PERMISSION = 'truevine:organization-permission';
export const PLATFORM_PERMISSION = 'truevine:platform-permission';
export const ACCEPTED_TERMS = 'truevine:accepted-terms';

/**
 * Requires `permission` inside the organization named by the path.
 *
 * The organization id is never read from a body or query field. It comes from
 * `params.organizationId`, and the guard then checks the session's user actually
 * holds a membership in *that* organization - so a forged path, a forged body
 * and a guessed resource id all fail at the same place.
 */
export const RequireOrganizationPermission = (permission: OrganizationPermission) =>
  SetMetadata(ORGANIZATION_PERMISSION, permission);

/**
 * Requires `permission` inside the Truevine platform.
 *
 * Separate from the organization guard on purpose: an Organization Owner holds
 * no platform role, so this must fail for them rather than being satisfied by an
 * organization permission that happens to share a name.
 */
export const RequirePlatformPermission = (permission: PlatformPermission) =>
  SetMetadata(PLATFORM_PERMISSION, permission);

/**
 * Requires that the caller accepted the current terms.
 *
 * Applied to routes that represent "using the application", not to sign-in or
 * password reset, which a user who has not accepted anything still needs.
 */
export const RequireAcceptedTerms = () => SetMetadata(ACCEPTED_TERMS, true);

/**
 * Injects the authenticated caller.
 *
 * Throws rather than returning `undefined` if the guard did not run, because a
 * silently absent principal is how a handler ends up operating on nothing.
 */
export const CurrentPrincipal = createParamDecorator(
  (_data: unknown, context: ExecutionContext): Principal => {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const principal = request[PRINCIPAL];

    if (!principal) {
      throw new Error(
        'CurrentPrincipal used on a route without SessionGuard. Add @UseGuards(SessionGuard).',
      );
    }

    return principal;
  },
);

/** Injects the validated organization context, proving membership was checked. */
export const CurrentOrganization = createParamDecorator(
  (_data: unknown, context: ExecutionContext): OrganizationContext => {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const organization = request[ORGANIZATION_CONTEXT];

    if (!organization) {
      throw new Error(
        'CurrentOrganization used on a route without RequireOrganizationPermission. ' +
          'Add @RequireOrganizationPermission(...) to the handler.',
      );
    }

    return organization;
  },
);
