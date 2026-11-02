/**
 * Injection tokens for payment-provider configuration.
 *
 * Symbols keep the Prisma store and the AES implementation out of Nest's
 * metadata, so unit and HTTP tests inject fakes through the same tokens
 * production uses.
 */

export const PAYMENT_PROVIDER_STORE = Symbol('PAYMENT_PROVIDER_STORE');
export const PAYMENT_CREDENTIAL_CIPHER = Symbol('PAYMENT_CREDENTIAL_CIPHER');
