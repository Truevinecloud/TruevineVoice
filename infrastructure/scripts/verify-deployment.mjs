import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const PROCESS_NAMES = ['truevine-web', 'truevine-admin', 'truevine-api', 'truevine-worker'];

export function assertCiJobs(jobs) {
  for (const name of [
    'Lint, typecheck and Prisma validation',
    'Unit tests',
    'End-to-end tests',
    'Production build',
  ]) {
    const matches = jobs.filter((job) => job.name === name);
    if (matches.length !== 1 || matches[0].conclusion !== 'success') {
      throw new Error(`Missing successful CI gate: ${name}`);
    }
  }
}

export function validateConfig(config) {
  if (config.webUrl !== 'https://voice.truevinecloud.online/') {
    throw new Error('webUrl must be the agreed customer production URL');
  }
  for (const value of [config.webUrl, config.apiHealthUrl, config.adminUrl].filter(Boolean)) {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || url.hash) {
      throw new Error('Public checks require HTTPS URLs without credentials or fragments');
    }
  }
  if (!config.apiHealthUrl) throw new Error('Confirm the existing API route and set apiHealthUrl');
  if (!['internal', 'public'].includes(config.adminAccess)) throw new Error('Confirm adminAccess');
  if ((config.adminAccess === 'public') !== Boolean(config.adminUrl)) {
    throw new Error('Public admin requires adminUrl; internal admin must have no public URL');
  }
  if (
    !Number.isInteger(config.apiPort) ||
    config.apiPort < 1024 ||
    config.apiPort > 65535 ||
    [3000, 3002].includes(config.apiPort)
  )
    throw new Error('Invalid API port');
  return config;
}

export function validateProcesses(processes, release, sha, now = Date.now()) {
  for (const name of PROCESS_NAMES) {
    const matches = processes.filter((entry) => entry.name === name);
    if (matches.length !== 1) throw new Error(`Expected exactly one PM2 process: ${name}`);
    const env = matches[0].pm2_env;
    if (
      env.status !== 'online' ||
      env.APP_VERSION !== sha ||
      env.pm_cwd !== `${release}/apps/${name.slice('truevine-'.length)}` ||
      !Number.isFinite(env.pm_uptime) ||
      now - env.pm_uptime < 10000
    ) {
      throw new Error(`PM2 process is not stable on the expected release: ${name}`);
    }
  }
}

export async function checkHttp(url, kind, sha, fetcher = fetch) {
  const response = await fetcher(url, { redirect: 'error', signal: AbortSignal.timeout(8000) });
  if (response.status !== 200) throw new Error(`${kind} HTTP check returned ${response.status}`);
  if (kind === 'api') {
    const body = await response.json();
    if (
      body.status !== 'ok' ||
      body.service !== 'truevine-voice-api' ||
      body.version !== sha ||
      body.environment !== 'production' ||
      body.dependencies?.postgres?.status !== 'up' ||
      body.dependencies?.redis?.status !== 'up'
    )
      throw new Error('API release/dependency check failed');
  } else {
    const body = await response.text();
    // Markers prove Nginx is serving THIS release's own page rather than a
    // default site or a stale release. They are updated deliberately whenever
    // the foundation page copy changes, in the same commit as that change.
    const markers =
      kind === 'web'
        ? [
            'Truevine Voice',
            'Customer web application',
            'Live web for voice',
            'voice.truevinecloud.online',
            // The honest scope statement. The platform is live; the voice
            // product is not built. Removing this would let a page claiming
            // calling works pass the gate.
            'still under construction',
          ]
        : // `Truevine Voice`, not `Truevine Voice Admin`: the heading is
          // `{product} Admin`, and React SSR inserts a comment separator between
          // the two text nodes, so the contiguous string never appears in the HTML
          // and verification rejected a perfectly healthy page. The other two
          // markers keep the check specific to this application.
          ['Truevine Voice', 'No admin functionality yet', 'internal operators'];
    if (!markers.every((marker) => body.includes(marker)))
      throw new Error(`${kind} foundation page check failed`);
  }
}

export async function verifyHttp(config, sha, fetcher = fetch) {
  validateConfig(config);
  const checks = [
    ['http://127.0.0.1:3000/', 'web'],
    ['http://127.0.0.1:3002/admin', 'admin'],
    [`http://127.0.0.1:${config.apiPort}/health`, 'api'],
    [config.webUrl, 'web'],
    [config.apiHealthUrl, 'api'],
  ];
  if (config.adminUrl) checks.push([config.adminUrl, 'admin']);
  await Promise.all(checks.map(([url, kind]) => checkHttp(url, kind, sha, fetcher)));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [configPath, sha] = process.argv.slice(2);
  if (!configPath || !/^[a-f0-9]{40}$/.test(sha ?? ''))
    throw new Error('Usage: npm run deploy:verify -- CONFIG SHA');
  await verifyHttp(JSON.parse(readFileSync(configPath, 'utf8')), sha);
  process.stdout.write(`HTTP verification passed for ${sha}\n`);
}
