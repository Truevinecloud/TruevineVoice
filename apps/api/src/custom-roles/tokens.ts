/**
 * Injection tokens for the custom roles module.
 *
 * Declared as symbols so that the concrete store implementations never leak
 * into Nest's metadata. Unit tests inject fakes through these same tokens.
 */

export type { CustomRoleStore } from './custom-role.store.js';

export const CUSTOM_ROLE_STORE = Symbol('CUSTOM_ROLE_STORE');
export const CUSTOM_ROLE_AUDIT_STORE = Symbol('CUSTOM_ROLE_AUDIT_STORE');