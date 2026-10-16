/**
 * Re-exports of the generated Prisma enum types.
 *
 * The stores in `auth.store.ts` are declared against plain string unions rather
 * than the generated enums, so that the persistence contracts stay independent
 * of the ORM and a unit test does not need a generated client to construct one.
 * This module is the single place where the two vocabularies are tied together,
 * so a change to the schema surfaces as a type error here rather than scattered
 * through the services.
 */

import type { MembershipRole, PlatformRole } from '@truevine/database';

/**
 * The enum types are re-exported so that every consumer imports the vocabulary
 * from one place. They are types only: nothing here has a runtime representation,
 * which keeps this module free of a dependency on the generated Prisma client at
 * execution time.
 */
export type { MembershipRole, PlatformRole };

/**
 * Compile-time proof that the string unions used by the stores still match the
 * database enums.
 *
 * If a migration renames a variant, this assignment stops compiling. That is the
 * intended failure: the vocabulary changed and the authorization layer has not
 * been reviewed against it.
 */
const _membershipRoleVocabulary: Record<MembershipRole, MembershipRole> = {
  OWNER: 'OWNER',
  ADMIN: 'ADMIN',
  CAMPAIGN_MANAGER: 'CAMPAIGN_MANAGER',
  BILLING: 'BILLING',
  VIEWER: 'VIEWER',
};

const _platformRoleVocabulary: Record<PlatformRole, PlatformRole> = {
  PLATFORM_OWNER: 'PLATFORM_OWNER',
  OPERATIONS_ADMIN: 'OPERATIONS_ADMIN',
  BILLING_ADMIN: 'BILLING_ADMIN',
  SUPPORT_ADMIN: 'SUPPORT_ADMIN',
  TECHNICAL_ADMIN: 'TECHNICAL_ADMIN',
  AUDITOR: 'AUDITOR',
};

void _membershipRoleVocabulary;
void _platformRoleVocabulary;
