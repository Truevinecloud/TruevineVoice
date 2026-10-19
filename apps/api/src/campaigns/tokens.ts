/**
 * Injection tokens for the campaigns feature.
 *
 * Symbols, like `apps/api/src/tokens.ts`, so neither the generated Prisma
 * client nor the concrete store implementation leak into Nest's metadata. Unit
 * tests inject fakes through these same tokens, which is why the fast suite
 * never needs a database.
 */

/** {@link CampaignStore} implementation. */
export const CAMPAIGN_STORE = Symbol('CAMPAIGN_STORE');
