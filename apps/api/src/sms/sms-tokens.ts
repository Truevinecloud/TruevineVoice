/**
 * Injection tokens for the SMS fallback layer.
 *
 * Declared as symbols so that the SMS port type never leaks into Nest
 * metadata. Consumers inject `SmsPort` through the module's explicit
 * provider binding.
 */

export const SMS_PORT = Symbol('SMS_PORT');
