import { describe, expect, it } from 'vitest';

import { buildApps } from './ecosystem.apps.js';

interface Pm2App {
  readonly name: string;
  readonly cwd: string;
  readonly script: string;
  readonly args?: string;
  readonly env: Record<string, string>;
}

interface DeploymentConfig {
  readonly apiPort: number;
}

const loadApps = buildApps as (release: string, sha: string, config: DeploymentConfig) => Pm2App[];

const release = '/var/www/TruevineVoice/release';
const sha = 'abc123';

function appsFor(apiPort: number): Pm2App[] {
  return loadApps(release, sha, { apiPort });
}

function webApp(apiPort: number): Pm2App {
  const app = appsFor(apiPort).find((candidate) => candidate.name === 'truevine-web');
  if (!app) {
    throw new Error('truevine-web is missing from the PM2 app list');
  }
  return app;
}

describe('PM2 app definitions', () => {
  it('gives the web app a TRUEVINE_API_URL derived from the configured API port', () => {
    expect(webApp(3001).env).toMatchObject({
      NODE_ENV: 'production',
      APP_VERSION: sha,
      API_HOST: '127.0.0.1',
      API_PORT: '3001',
      TRUEVINE_API_URL: 'http://127.0.0.1:3001',
    });
  });

  it('tracks config.apiPort instead of a hard-coded port', () => {
    expect(webApp(4002).env['API_PORT']).toBe('4002');
    expect(webApp(4002).env['TRUEVINE_API_URL']).toBe('http://127.0.0.1:4002');
  });

  it.each([3001, 4002])('gives admin the same loopback API origin on port %s', (apiPort) => {
    const admin = appsFor(apiPort).find((app) => app.name === 'truevine-admin');
    expect(admin?.env).toMatchObject({
      NODE_ENV: 'production',
      APP_VERSION: sha,
      API_HOST: '127.0.0.1',
      API_PORT: String(apiPort),
      TRUEVINE_API_URL: webApp(apiPort).env['TRUEVINE_API_URL'],
    });
    expect(admin?.env['TRUEVINE_API_URL']).toBe(`http://127.0.0.1:${apiPort}`);
    expect(admin?.args).toBe('start --hostname 127.0.0.1 --port 3002');
  });

  it('scopes TRUEVINE_API_URL to web and admin and keeps every app in the list', () => {
    const apps = appsFor(3001);
    expect(apps.map((app) => app.name)).toEqual([
      'truevine-web',
      'truevine-admin',
      'truevine-api',
      'truevine-worker',
    ]);
    for (const app of apps) {
      if (app.name === 'truevine-web' || app.name === 'truevine-admin') {
        expect(app.env).toHaveProperty('TRUEVINE_API_URL');
      } else {
        expect(app.env).not.toHaveProperty('TRUEVINE_API_URL');
      }
    }
  });
});
