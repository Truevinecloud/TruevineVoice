import express from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';

import {
  csrfCookieOptions,
  csrfTokensMatch,
  readCsrfToken,
  readSessionToken,
  secureCookiesFor,
  sessionCookieOptions,
} from '../src/auth/cookies.js';

/** Issues both cookies through the real Express response and returns them. */
async function issuedCookies(environment: string): Promise<string[]> {
  const app = express();
  app.get('/', (_request, response) => {
    response.cookie('tv_session', 'test-session', sessionCookieOptions(environment));
    response.cookie('tv_csrf', 'test-csrf', csrfCookieOptions(environment));
    response.sendStatus(204);
  });

  const response = await request(app).get('/');
  return response.headers['set-cookie'] as unknown as string[];
}

/** Asserts the flags every environment must share. */
function expectSharedFlags(cookies: string[]): void {
  expect(cookies).toHaveLength(2);
  for (const cookie of cookies) {
    expect(cookie).toContain('Max-Age=43200;');
    expect(cookie).toContain('SameSite=Lax');
    expect(cookie).toContain('Path=/');
  }
  // The session cookie must stay out of reach of script; the CSRF cookie must
  // be readable, because the double-submit pattern depends on it.
  expect(cookies[0]).toContain('HttpOnly');
  expect(cookies[1]).not.toContain('HttpOnly');
}

describe('authentication cookies', () => {
  describe('production environment (secure)', () => {
    it('serializes a twelve-hour lifetime with the Secure flag', async () => {
      const cookies = await issuedCookies('production');
      expectSharedFlags(cookies);
      for (const cookie of cookies) expect(cookie).toContain('Secure');
    });
  });

  describe('development environment (loopback HTTP, non-secure)', () => {
    it('serializes without the Secure flag so the browser stores the session', async () => {
      const cookies = await issuedCookies('development');
      expectSharedFlags(cookies);
      for (const cookie of cookies) expect(cookie).not.toContain('Secure');
    });
  });

  describe('test environment (loopback HTTP, non-secure)', () => {
    // The end-to-end suite runs the API over plain HTTP. A Secure cookie is
    // accepted by supertest but dropped by a real browser, which is exactly the
    // regression that made local sign-in look broken while every test passed.
    it('serializes without the Secure flag', async () => {
      const cookies = await issuedCookies('test');
      expectSharedFlags(cookies);
      for (const cookie of cookies) expect(cookie).not.toContain('Secure');
    });
  });

  it('marks cookies Secure for every environment that is not loopback HTTP', () => {
    for (const environment of ['development', 'test']) {
      expect(secureCookiesFor(environment)).toBe(false);
      expect(sessionCookieOptions(environment).secure).toBe(false);
      expect(csrfCookieOptions(environment).secure).toBe(false);
    }

    for (const environment of ['production', 'staging', 'qa', '']) {
      expect(secureCookiesFor(environment)).toBe(true);
      expect(sessionCookieOptions(environment).secure).toBe(true);
      expect(csrfCookieOptions(environment).secure).toBe(true);
    }
  });

  it('treats malformed session encoding as a missing credential', () => {
    expect(readSessionToken({ headers: { cookie: 'tv_session=%ZZ' } })).toBeUndefined();
  });

  it('treats malformed CSRF encoding as a missing token', () => {
    expect(readCsrfToken({ headers: { cookie: 'tv_csrf=%E0%A4' } })).toBeUndefined();
  });

  it('compares matching CSRF tokens and refuses unequal or absent values', () => {
    expect(csrfTokensMatch('one-token', 'one-token')).toBe(true);
    expect(csrfTokensMatch('one-token', 'two-token')).toBe(false);
    expect(csrfTokensMatch('one-token', 'short')).toBe(false);
    expect(csrfTokensMatch(undefined, 'one-token')).toBe(false);
    expect(csrfTokensMatch('', '')).toBe(false);
  });
});
