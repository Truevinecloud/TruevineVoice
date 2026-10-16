/**
 * Email delivery.
 *
 * An **interface plus adapters**, never an SDK imported by callers (AGENTS.md 8).
 * Three transports:
 *
 * | Transport    | Behaviour                                        | Use when |
 * |--------------|--------------------------------------------------|----------|
 * | `development`| Writes the message to a directory. Sends nothing. | Local development, CI, tests |
 * | `http`       | POSTs to a configured transactional-email API    | Production, once credentials exist |
 * | `none`       | Records that a send was requested, sends nothing  | Deliberately disabled |
 *
 * `none` is not the same as `development`. `none` is for a deployment that must
 * not send mail at all; `development` is for capturing what *would* have been
 * sent so a developer can follow a real link.
 *
 * NOTHING IS EVER LOGGED.
 * -----------------------
 * An email body for a password reset or an invitation contains a bearer
 * credential: whoever holds the link can reset that account or join that
 * organization. `describe()` therefore returns only the recipient, the template
 * name and a redacted token fingerprint, never a subject line with a token, and
 * never the body.
 */

import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** Templates the application sends. */
export const EMAIL_TEMPLATES = ['password-reset', 'organization-invitation'] as const;
export type EmailTemplate = (typeof EMAIL_TEMPLATES)[number];

/** A message to deliver. */
export interface EmailMessage {
  readonly template: EmailTemplate;
  readonly to: string;
  /** Rendered text body. May contain a single-use token. Never logged. */
  readonly body: string;
  /** Subject line. May contain a single-use token, so never logged either. */
  readonly subject: string;
}

/** A safe-to-log description of a send. */
export interface EmailSendReceipt {
  readonly template: EmailTemplate;
  readonly to: string;
  /** SHA-256 prefix of the body. Correlates a send with a token without exposing it. */
  readonly bodyFingerprint: string;
  /** Whether a message was actually handed to a transport. */
  readonly delivered: boolean;
  readonly transport: 'development' | 'http' | 'none';
}

/** The contract every transport implements. */
export interface EmailSender {
  send(message: EmailMessage): Promise<EmailSendReceipt>;
}

/**
 * A sender that delivers nothing.
 *
 * Used by unit tests and by a deployment that has not configured a provider.
 * `delivered: false` is the honest answer, and a caller that cares can assert on
 * it rather than assuming a mail left the building.
 */
export class NullEmailSender implements EmailSender {
  /** Messages passed in, for a test to assert on. Never printed. */
  readonly sent: EmailMessage[] = [];

  async send(message: EmailMessage): Promise<EmailSendReceipt> {
    this.sent.push(message);

    return {
      template: message.template,
      to: message.to,
      bodyFingerprint: fingerprint(message.body),
      delivered: false,
      transport: 'none',
    };
  }
}

/**
 * Captures messages to disk instead of sending them.
 *
 * The directory is written with mode `0700` and each file with `0600`, because
 * the file contains a bearer credential. Anyone who can read the directory can
 * reset that account, so this transport is for a developer machine and nothing
 * else.
 */
export class DevelopmentCaptureEmailSender implements EmailSender {
  readonly directory: string;

  constructor(directory: string) {
    this.directory = directory;

    // `recursive: true` so a missing capture directory is created rather than
    // turning every send into an error the caller has to handle.
    mkdirSync(directory, { recursive: true, mode: 0o700 });
  }

  async send(message: EmailMessage): Promise<EmailSendReceipt> {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const file = join(this.directory, `${stamp}-${message.template}-${slug(message.to)}.txt`);

    writeFileSync(file, render(message), { encoding: 'utf8', mode: 0o600 });

    return {
      template: message.template,
      to: message.to,
      bodyFingerprint: fingerprint(message.body),
      delivered: false,
      transport: 'development',
    };
  }
}

/** An HTTP transport for a transactional-email provider. */
export class HttpEmailSender implements EmailSender {
  readonly endpoint: string;
  readonly authorizationHeader: string;
  readonly #fetch: typeof fetch;

  constructor(options: {
    endpoint: string;
    authorizationHeader: string;
    fetchImpl?: typeof fetch;
  }) {
    this.endpoint = options.endpoint;
    this.authorizationHeader = options.authorizationHeader;
    this.#fetch = options.fetchImpl ?? fetch;
  }

  async send(message: EmailMessage): Promise<EmailSendReceipt> {
    const response = await this.#fetch(this.endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: this.authorizationHeader,
      },
      // The provider's payload shape is provider-specific. This sends the
      // smallest shape that most providers accept, and the adapter is where a
      // provider change is absorbed.
      body: JSON.stringify({ to: message.to, subject: message.subject, text: message.body }),
    });

    if (!response.ok) {
      throw new Error(`Email provider rejected the message with status ${response.status}.`);
    }

    return {
      template: message.template,
      to: message.to,
      bodyFingerprint: fingerprint(message.body),
      delivered: true,
      transport: 'http',
    };
  }
}

/** Email transport configuration, read from the environment. */
export interface EmailConfig {
  readonly transport: 'development' | 'http' | 'none';
  readonly captureDirectory?: string;
  readonly endpoint?: string;
  readonly authorizationHeader?: string;
}

/**
 * Chooses a transport from configuration.
 *
 * `http` without an endpoint is a **configuration error**, not a silent
 * downgrade: a deployment that believes it is sending password resets and is not
 * is worse than one that refuses to start. AGENTS.md 11 requires the boot to fail
 * on missing configuration rather than inventing a default.
 */
export function createEmailSender(config: EmailConfig): EmailSender {
  switch (config.transport) {
    case 'development':
      return new DevelopmentCaptureEmailSender(
        config.captureDirectory ?? join(process.cwd(), '.email-capture'),
      );
    case 'http': {
      if (!config.endpoint) {
        throw new Error(
          'EMAIL_TRANSPORT=http requires EMAIL_ENDPOINT. Refusing to start rather than ' +
            'silently not sending password resets.',
        );
      }

      if (!config.authorizationHeader) {
        throw new Error(
          'EMAIL_TRANSPORT=http requires EMAIL_AUTHORIZATION_HEADER. Refusing to start.',
        );
      }

      return new HttpEmailSender({
        endpoint: config.endpoint,
        authorizationHeader: config.authorizationHeader,
      });
    }
    default:
      return new NullEmailSender();
  }
}

/** Builds the password-reset message. */
export function passwordResetMessage(options: {
  readonly to: string;
  readonly resetUrl: string;
  readonly expiresInMinutes: number;
}): EmailMessage {
  return {
    template: 'password-reset',
    to: options.to,
    subject: 'Reset your Truevine Voice password',
    body: [
      'A password reset was requested for your Truevine Voice account.',
      '',
      `Open this link within ${options.expiresInMinutes} minutes to choose a new password:`,
      options.resetUrl,
      '',
      'If you did not request this, you can ignore this message. Nothing has changed.',
      'The link can be used only once.',
    ].join('\n'),
  };
}

/** Builds the organization-invitation message. */
export function invitationMessage(options: {
  readonly to: string;
  readonly organizationName: string;
  readonly role: string;
  readonly acceptUrl: string;
  readonly inviterName?: string;
  readonly expiresInDays: number;
}): EmailMessage {
  return {
    template: 'organization-invitation',
    to: options.to,
    subject: `You have been invited to join ${options.organizationName} on Truevine Voice`,
    body: [
      `${options.inviterName ?? 'An administrator'} has invited you to join ${options.organizationName} on Truevine Voice as ${options.role}.`,
      '',
      `Accept the invitation within ${options.expiresInDays} days:`,
      options.acceptUrl,
      '',
      'If you were not expecting this invitation, ignore this message. You will not be added to the organization.',
      'The link can be used only once.',
    ].join('\n'),
  };
}

/** A stable, non-reversible fingerprint of a message body. */
export function fingerprint(body: string): string {
  return createHash('sha256').update(body, 'utf8').digest('hex').slice(0, 12);
}

/** Renders a captured message, clearly marked as not having been sent. */
function render(message: EmailMessage): string {
  return [
    'Truevine Voice - development email capture',
    'THIS MESSAGE WAS NOT SENT. It was written to disk so a developer can',
    'follow the link. Do not deploy with EMAIL_TRANSPORT=development.',
    '',
    `To:      ${message.to}`,
    `Template: ${message.template}`,
    '',
    message.subject,
    '',
    '---',
    '',
    message.body,
    '',
  ].join('\n');
}

/** A filename-safe fragment of an address. Never the local part verbatim. */
function slug(address: string): string {
  const digest = createHash('sha256').update(address, 'utf8').digest('hex').slice(0, 10);
  return digest;
}
