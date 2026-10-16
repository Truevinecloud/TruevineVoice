import express from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';

import {
  CSRF_COOKIE_OPTIONS,
  SESSION_COOKIE_OPTIONS,
  csrfTokensMatch,
  readCsrfToken,
  readSessionToken,
} from '../src/auth/cookies.js';

describe('authentication cookies', () => {
  it('serializes a twelve-hour lifetime through the real Express response', async () => {
    const app = express();
    app.get('/', (_request, response) => {
      response.cookie('tv_session', 'test-session', SESSION_COOKIE_OPTIONS);
      response.cookie('tv_csrf', 'test-csrf', CSRF_COOKIE_OPTIONS);
      response.sendStatus(204);
    });

    const response = await request(app).get('/');
    const cookies = response.headers['set-cookie'] as unknown as string[];
    expect(cookies).toHaveLength(2);
    for (const cookie of cookies) {
      expect(cookie).toContain('Max-Age=43200;');
      expect(cookie).toContain('Secure');
      expect(cookie).toContain('SameSite=Lax');
    }
    expect(cookies[0]).toContain('HttpOnly');
    expect(cookies[1]).not.toContain('HttpOnly');
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
