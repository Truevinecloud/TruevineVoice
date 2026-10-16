import { describe, expect, it } from 'vitest';
import { mkdtempSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  createEmailSender,
  DevelopmentCaptureEmailSender,
  fingerprint,
  HttpEmailSender,
  invitationMessage,
  NullEmailSender,
  passwordResetMessage,
} from './email.js';

function tempDirectory(): string {
  return mkdtempSync(join(tmpdir(), 'tv-email-'));
}

describe('DevelopmentCaptureEmailSender', () => {
  it('writes the message instead of sending it', async () => {
    const directory = tempDirectory();
    const sender = new DevelopmentCaptureEmailSender(directory);

    const receipt = await sender.send(
      passwordResetMessage({
        to: 'owner@example.invalid',
        resetUrl: 'https://voice.example.invalid/reset?token=SECRET',
        expiresInMinutes: 60,
      }),
    );

    expect(receipt.delivered).toBe(false);
    expect(receipt.transport).toBe('development');

    const files = readdirSync(directory);
    expect(files).toHaveLength(1);
    expect(readFileSync(join(directory, files[0]!), 'utf8')).toContain('token=SECRET');
  });

  it('marks the capture clearly as not having been sent', async () => {
    const directory = tempDirectory();
    await new DevelopmentCaptureEmailSender(directory).send(
      passwordResetMessage({
        to: 'owner@example.invalid',
        resetUrl: 'https://voice.example.invalid/reset?token=SECRET',
        expiresInMinutes: 60,
      }),
    );

    const [file] = readdirSync(directory);

    expect(readFileSync(join(directory, file!), 'utf8')).toMatch(/THIS MESSAGE WAS NOT SENT/);
  });

  it('writes the file readable only by its owner', async () => {
    // The captured file contains a bearer credential. Anyone who can read it can
    // reset that account, so the mode is part of the control, not a detail.
    const directory = tempDirectory();
    await new DevelopmentCaptureEmailSender(directory).send(
      passwordResetMessage({
        to: 'owner@example.invalid',
        resetUrl: 'https://voice.example.invalid/reset?token=SECRET',
        expiresInMinutes: 60,
      }),
    );

    const [file] = readdirSync(directory);

    // Windows does not report POSIX modes; the assertion is meaningful on Linux.
    if (process.platform !== 'win32') {
      expect(statSync(join(directory, file!)).mode & 0o777).toBe(0o600);
    }
  });

  it('never puts the recipient address in the filename', async () => {
    const directory = tempDirectory();
    await new DevelopmentCaptureEmailSender(directory).send(
      passwordResetMessage({
        to: 'person@example.invalid',
        resetUrl: 'https://voice.example.invalid/reset?token=SECRET',
        expiresInMinutes: 60,
      }),
    );

    expect(readdirSync(directory).join()).not.toContain('person');
  });

  it('reports a fingerprint that identifies the body without revealing it', async () => {
    const sender = new DevelopmentCaptureEmailSender(tempDirectory());
    const message = passwordResetMessage({
      to: 'owner@example.invalid',
      resetUrl: 'https://voice.example.invalid/reset?token=SECRET',
      expiresInMinutes: 60,
    });

    const receipt = await sender.send(message);

    expect(receipt.bodyFingerprint).toHaveLength(12);
    expect(receipt.bodyFingerprint).not.toContain('SECRET');
    expect(receipt.bodyFingerprint).toBe(fingerprint(message.body));
  });
});

describe('NullEmailSender', () => {
  it('reports that nothing was delivered', async () => {
    const receipt = await new NullEmailSender().send(
      passwordResetMessage({
        to: 'owner@example.invalid',
        resetUrl: 'https://voice.example.invalid/reset?token=SECRET',
        expiresInMinutes: 60,
      }),
    );

    expect(receipt.delivered).toBe(false);
    expect(receipt.transport).toBe('none');
  });
});

describe('HttpEmailSender', () => {
  it('posts the message and reports delivery', async () => {
    const seen: Array<{ url: string; body: string; headers: Record<string, string> }> = [];

    const sender = new HttpEmailSender({
      endpoint: 'https://api.example.invalid/send',
      authorizationHeader: 'Bearer test-token',
      fetchImpl: (async (url: string, init: RequestInit) => {
        seen.push({
          url: String(url),
          body: String(init.body),
          headers: init.headers as Record<string, string>,
        });
        return new Response('{}', { status: 202 });
      }) as unknown as typeof fetch,
    });

    const receipt = await sender.send(
      passwordResetMessage({
        to: 'owner@example.invalid',
        resetUrl: 'https://voice.example.invalid/reset?token=SECRET',
        expiresInMinutes: 60,
      }),
    );

    expect(receipt.delivered).toBe(true);
    expect(seen[0]?.url).toBe('https://api.example.invalid/send');
    expect(seen[0]?.headers['authorization']).toBe('Bearer test-token');
    expect(seen[0]?.body).toContain('token=SECRET');
  });

  it('throws when the provider rejects the message', async () => {
    const sender = new HttpEmailSender({
      endpoint: 'https://api.example.invalid/send',
      authorizationHeader: 'Bearer test-token',
      fetchImpl: (async () => new Response('{}', { status: 500 })) as unknown as typeof fetch,
    });

    await expect(
      sender.send(
        passwordResetMessage({
          to: 'owner@example.invalid',
          resetUrl: 'https://voice.example.invalid/reset?token=SECRET',
          expiresInMinutes: 60,
        }),
      ),
    ).rejects.toThrow(/status 500/);
  });

  it('does not include the authorization header in the error', async () => {
    // A thrown error is logged. An error carrying the provider credential would
    // put a live secret in the log.
    const sender = new HttpEmailSender({
      endpoint: 'https://api.example.invalid/send',
      authorizationHeader: 'Bearer super-secret-provider-key',
      fetchImpl: (async () => new Response('{}', { status: 401 })) as unknown as typeof fetch,
    });

    const error = (await sender
      .send(
        passwordResetMessage({
          to: 'owner@example.invalid',
          resetUrl: 'https://voice.example.invalid/reset?token=SECRET',
          expiresInMinutes: 60,
        }),
      )
      .catch((caught: Error) => caught)) as Error;

    expect(error.message).not.toContain('super-secret-provider-key');
  });
});

describe('createEmailSender', () => {
  it('builds a development sender', () => {
    expect(
      createEmailSender({ transport: 'development', captureDirectory: tempDirectory() }),
    ).toBeInstanceOf(DevelopmentCaptureEmailSender);
  });

  it('builds a null sender by default', () => {
    expect(createEmailSender({ transport: 'none' })).toBeInstanceOf(NullEmailSender);
  });

  it('refuses an http transport with no endpoint rather than not sending', () => {
    // A deployment that believes it sends password resets and does not is worse
    // than one that refuses to start.
    expect(() => createEmailSender({ transport: 'http' })).toThrow(/EMAIL_ENDPOINT/);
  });

  it('refuses an http transport with no authorization header', () => {
    expect(() =>
      createEmailSender({ transport: 'http', endpoint: 'https://api.example.invalid/send' }),
    ).toThrow(/EMAIL_AUTHORIZATION_HEADER/);
  });

  it('refuses the development capture transport in production', () => {
    // The dangerous misconfiguration. Unlike the `http` cases above this one
    // *succeeds* at sending, so a deployment set to it reports healthy while
    // quietly writing every password-reset token to a file on its own disk.
    const previous = process.env['NODE_ENV'];

    try {
      process.env['NODE_ENV'] = 'production';

      expect(() =>
        createEmailSender({ transport: 'development', captureDirectory: tempDirectory() }),
      ).toThrow(/NODE_ENV=production/);
    } finally {
      if (previous === undefined) delete process.env['NODE_ENV'];
      else process.env['NODE_ENV'] = previous;
    }
  });

  it('still allows the development capture transport outside production', () => {
    // Guards against the refusal above being written so broadly it breaks the
    // development workflow it exists for.
    expect(
      createEmailSender({ transport: 'development', captureDirectory: tempDirectory() }),
    ).toBeInstanceOf(DevelopmentCaptureEmailSender);
  });

  it('builds an http sender when fully configured', () => {
    expect(
      createEmailSender({
        transport: 'http',
        endpoint: 'https://api.example.invalid/send',
        authorizationHeader: 'Bearer token',
      }),
    ).toBeInstanceOf(HttpEmailSender);
  });
});

describe('message content', () => {
  it('tells the recipient that a reset link is single-use', () => {
    const message = passwordResetMessage({
      to: 'owner@example.invalid',
      resetUrl: 'https://voice.example.invalid/reset?token=SECRET',
      expiresInMinutes: 60,
    });

    expect(message.body).toMatch(/only once/i);
    expect(message.body).toMatch(/60 minutes/);
  });

  it('says nothing changed if the request was not theirs', () => {
    // A reset email that reads as alarming trains people to ignore the real one.
    const message = passwordResetMessage({
      to: 'owner@example.invalid',
      resetUrl: 'https://voice.example.invalid/reset?token=SECRET',
      expiresInMinutes: 60,
    });

    expect(message.body).toMatch(/nothing has changed/i);
  });

  it('states the organization, role and single-use link in an invitation', () => {
    const message = invitationMessage({
      to: 'invitee@example.invalid',
      organizationName: 'Acme',
      role: 'VIEWER',
      acceptUrl: 'https://voice.example.invalid/invite?token=SECRET',
      inviterName: 'Alice',
      expiresInDays: 7,
    });

    expect(message.body).toContain('Acme');
    expect(message.body).toContain('VIEWER');
    expect(message.body).toContain('Alice');
    expect(message.body).toMatch(/only once/i);
  });

  it('names no inviter when the invitation came from the application', () => {
    const message = invitationMessage({
      to: 'invitee@example.invalid',
      organizationName: 'Acme',
      role: 'VIEWER',
      acceptUrl: 'https://voice.example.invalid/invite?token=SECRET',
      expiresInDays: 7,
    });

    expect(message.body).toContain('An administrator');
  });

  it('does not include a token in the subject line', () => {
    // Subjects are rendered in notification previews, which are not private.
    const reset = passwordResetMessage({
      to: 'owner@example.invalid',
      resetUrl: 'https://voice.example.invalid/reset?token=SECRET',
      expiresInMinutes: 60,
    });
    const invitation = invitationMessage({
      to: 'invitee@example.invalid',
      organizationName: 'Acme',
      role: 'VIEWER',
      expiresInDays: 7,
      acceptUrl: 'https://voice.example.invalid/invite?token=SECRET',
    });

    expect(reset.subject).not.toContain('SECRET');
    expect(invitation.subject).not.toContain('SECRET');
  });
});
