/**
 * `@truevine/auth` - authentication, authorization and RBAC for Truevine Voice.
 *
 * This package MUST NOT depend on any `apps/*` workspace, MUST NOT import
 * NestJS, and MUST NOT reach a database. It owns decisions - what a role may do,
 * how a token is derived, what an error means - and nothing else. Anything that
 * needs a connection belongs in `apps/api`.
 *
 * `passwords.ts` is deliberately NOT re-exported here: it pulls in the native
 * `@node-rs/argon2` binding, which must never enter a browser bundle. Server
 * code imports it from `@truevine/auth/passwords`; the frontends import only
 * this entry point.
 */

export {
  can,
  canActAsPlatform,
  canAdministerMemberships,
  canDelegate,
  delegableRoles,
  isMutating,
  MUTATING_ORGANIZATION_PERMISSIONS,
  ORGANIZATION_PERMISSIONS,
  ORGANIZATION_ROLE_PERMISSIONS,
  ORGANIZATION_ROLES,
  PLATFORM_PERMISSIONS,
  PLATFORM_ROLE_PERMISSIONS,
  PLATFORM_ROLES,
  type OrganizationPermission,
  type OrganizationRole,
  type PlatformPermission,
  type PlatformRole,
} from './permissions.js';

export {
  checkEmail,
  isValidEmail,
  normalizeEmail,
  MAX_EMAIL_LENGTH,
  type EmailCheck,
  type EmailProblem,
} from './identity.js';

export {
  digestsMatch,
  generateToken,
  hashToken,
  INVITATION_TTL_MS,
  PASSWORD_RESET_TTL_MS,
  SESSION_TTL_MS,
  TOKEN_BYTES,
} from './tokens.js';

export {
  assertKnownAuditAction,
  AUDIT_ACTIONS,
  FORBIDDEN_AUDIT_METADATA_KEYS,
  isKnownAuditAction,
  isSafeAuditMetadata,
  isSafeAuditMetadataKey,
  type AuditAction,
} from './audit.js';

export {
  AuthError,
  AUTH_ERROR_CODES,
  campaignNotFound,
  cannotDelegate,
  cannotRemoveLastOwner,
  invalidCampaign,
  invalidCredentials,
  passwordTooWeak,
  permissionDenied,
  sessionInvalid,
  termsAcceptanceRequired,
  unauthenticated,
  type AuthErrorCode,
} from './errors.js';
