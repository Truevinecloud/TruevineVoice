/**
 * `@truevine/messaging` - outbound messaging for Truevine Voice.
 *
 * Framework-agnostic. Contains no provider SDK: a transport is an implementation
 * of {@link EmailSender} behind an interface, so a provider change is absorbed
 * here rather than leaking into the services that send mail.
 */

export * from './email.js';
