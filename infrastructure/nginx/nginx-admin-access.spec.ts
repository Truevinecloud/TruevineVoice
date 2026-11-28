import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * Configuration contract for the approved restricted Admin portal.
 * These tests read the checked-in Nginx templates and deployment sources only:
 * no live Nginx configuration, certificate or production host is contacted.
 */
const readText = (url: URL): string => readFileSync(url, 'utf8');

/** Comments must not satisfy directive assertions. */
const directivesOnly = (text: string): string =>
  text
    .split(/\r?\n/)
    .filter((line) => !line.trimStart().startsWith('#'))
    .join('\n');

const adminConfig = readText(new URL('./admin.voice.truevinecloud.online.conf', import.meta.url));
const customerConfig = readText(new URL('./voice.truevinecloud.online.conf', import.meta.url));
const adminDirectives = directivesOnly(adminConfig);
const customerDirectives = directivesOnly(customerConfig);

const runbook = readText(
  new URL('../../docs/runbooks/production-deployment.md', import.meta.url),
);
const adminApiProxy = readText(
  new URL('../../apps/admin/src/app/api/[...path]/route.ts', import.meta.url),
);
const ecosystem = readText(new URL('../pm2/ecosystem.apps.js', import.meta.url));

const deploymentSources: ReadonlyArray<readonly [string, string]> = [
  ['infrastructure/scripts/deploy.mjs', readText(new URL('../scripts/deploy.mjs', import.meta.url))],
  ['infrastructure/scripts/deploy.sh', readText(new URL('../scripts/deploy.sh', import.meta.url))],
  [
    'infrastructure/scripts/verify-deployment.mjs',
    readText(new URL('../scripts/verify-deployment.mjs', import.meta.url)),
  ],
  ['.github/workflows/deploy.yml', readText(new URL('../../.github/workflows/deploy.yml', import.meta.url))],
];

describe('restricted Admin hostname contract', () => {
  it('serves Admin only from the approved dedicated host', () => {
    expect(adminDirectives).toMatch(/server_name\s+admin\.voice\.truevinecloud\.online\s*;/);
    expect(adminDirectives).toContain('proxy_pass http://127.0.0.1:3002;');
    expect(customerDirectives).toMatch(/server_name\s+voice\.truevinecloud\.online\s*;/);
    expect(customerDirectives).not.toMatch(/server_name[^;]*admin\.voice/);
  });

  it('allows only the approved IPv4 /32 address', () => {
    expect(adminDirectives).toMatch(/^\s*allow\s+102\.209\.111\.186\/32\s*;/m);
    expect(adminDirectives.match(/^\s*allow\s+/gm) ?? []).toHaveLength(1);
  });

  it('denies unauthorized IPv4 and IPv6 clients', () => {
    expect(adminDirectives).toMatch(/^\s*deny\s+all\s*;/m);
    expect(adminDirectives).not.toMatch(/^\s*allow\s+(all|0\.0\.0\.0|::|2001:|fd[0-9a-f]{2}:)/im);
  });

  it.each([
    '$http_x_forwarded_for',
    '$http_x_forwarded_proto',
    '$http_x_real_ip',
    '$http_x_forwarded_host',
    '$http_forwarded',
  ])('rejects client-supplied forwarding header %s', (header) => {
    expect(adminDirectives).toContain(`if (${header}) { return 403; }`);
  });

  it('never trusts client forwarding headers as the source address', () => {
    expect(adminDirectives).not.toMatch(/real_ip_header|set_real_ip_from/);
    expect(adminDirectives).not.toMatch(
      /proxy_set_header\s+X-(?:Real-IP|Forwarded-For|Forwarded-Proto|Forwarded-Host|Forwarded)\s+\$http_/,
    );
  });

  it('preserves certbot-managed HTTPS and the HTTP renewal/redirect block', () => {
    expect(adminDirectives).toMatch(/listen\s+80\s*;/);
    expect(adminDirectives).toMatch(
      /ssl_certificate\s+\/etc\/letsencrypt\/live\/admin\.voice\.truevinecloud\.online\/fullchain\.pem\s*;/,
    );
    expect(adminDirectives).toMatch(
      /ssl_certificate_key\s+\/etc\/letsencrypt\/live\/admin\.voice\.truevinecloud\.online\/privkey\.pem\s*;/,
    );
    expect(adminDirectives).toContain('include /etc/letsencrypt/options-ssl-nginx.conf;');
    expect(adminDirectives).toContain('ssl_dhparam /etc/letsencrypt/ssl-dhparams.pem;');
    expect(adminDirectives).not.toMatch(/BEGIN (?:RSA |EC )?PRIVATE KEY/);
    expect(customerDirectives).toContain(
      'ssl_certificate /etc/letsencrypt/live/truevinecloud-web/fullchain.pem;',
    );
  });

  it('blocks the Admin route on the customer hostname', () => {
    expect(customerDirectives).toMatch(/location\s+\^~\s+\/admin\s*\{\s*return\s+404\s*;\s*\}/);
    expect(customerDirectives).not.toMatch(/proxy_pass\s+http:\/\/127\.0\.0\.1:3002/);
    expect(customerDirectives).not.toMatch(/location\s*=?\s*\/admin\/api\/auth\/sign-in/);
  });

  it('keeps the existing customer, browser API and health routes', () => {
    expect(customerDirectives).toMatch(
      /location\s+\/\s*\{[\s\S]*?proxy_pass\s+http:\/\/127\.0\.0\.1:3000\s*;/,
    );
    expect(customerDirectives).toMatch(
      /location\s+\/api\/\s*\{[\s\S]*?proxy_pass\s+http:\/\/127\.0\.0\.1:3000\s*;/,
    );
    expect(customerDirectives).toMatch(
      /location\s*=\s*\/health\s*\{[\s\S]*?proxy_pass\s+http:\/\/127\.0\.0\.1:3001\/health\s*;/,
    );
  });

  it('proxies only to loopback application ports', () => {
    const upstreams = [
      ...adminDirectives.matchAll(/proxy_pass\s+https?:\/\/([^\s;]+)/g),
      ...customerDirectives.matchAll(/proxy_pass\s+https?:\/\/([^\s;]+)/g),
    ].map((match) => match[1]);
    expect(upstreams.length).toBeGreaterThan(0);
    for (const upstream of upstreams) {
      expect(upstream).toMatch(/^127\.0\.0\.1:(3000|3001|3002)(?:\/\S*)?$/);
    }
    expect(adminDirectives).not.toMatch(/listen\s+3002\b/);
    expect(customerDirectives).not.toMatch(/listen\s+300[012]\b/);
    expect(ecosystem).toContain('start --hostname 127.0.0.1 --port 3002');
  });

  it('forces no-store on Admin API responses at the edge and in the app', () => {
    expect(adminDirectives).toMatch(/proxy_hide_header\s+Cache-Control\s*;/);
    expect(adminDirectives).toMatch(/add_header\s+Cache-Control\s+"no-store"\s+always\s*;/);
    expect(adminDirectives).not.toMatch(/add_header\s+Cache-Control\s+"public/);
    expect(adminApiProxy).toContain("'cache-control': 'no-store'");
    expect(adminApiProxy).toContain("responseHeaders.set('cache-control', 'no-store')");
  });

  it('defines the sign-in rate limit zone only once across both virtual hosts', () => {
    const definitions = [adminDirectives, customerDirectives].flatMap(
      (text) => text.match(/^\s*limit_req_zone\s+\$binary_remote_addr\s+zone=admin_auth\b/gm) ?? [],
    );
    expect(definitions).toHaveLength(1);
  });
});

describe('no overwrite of the working Admin configuration', () => {
  it.each(deploymentSources)('%s does not write, reload or delete Nginx state', (_name, source) => {
    expect(source).not.toMatch(
      /\/etc\/nginx|sites-available|sites-enabled|certbot|systemctl\s+(?:reload|restart)\s+nginx|\bnginx\s+-[tT]\b/i,
    );
    expect(source).not.toMatch(/rm\s+[^\n]*admin\.voice\.truevinecloud/i);
  });

  it('keeps the two virtual-host templates on separate, explicitly named paths', () => {
    expect(customerConfig).toMatch(/sites-available\/voice\.truevinecloud\.online\b/);
    expect(customerConfig).not.toMatch(/sites-available\/admin\.voice/);
    expect(customerConfig).toMatch(/never to the Admin virtual host/i);
    expect(adminConfig).toMatch(/sites-available\/admin\.voice\.truevinecloud\.online\b/);
    expect(adminConfig).toMatch(/never copy the customer template over this file/i);
  });

  it('documents the dedicated host and the pipeline non-overwrite rule', () => {
    expect(runbook).toContain('https://admin.voice.truevinecloud.online/admin');
    expect(runbook).toContain('102.209.111.186/32');
    expect(runbook).toMatch(/No Nginx configuration is overwritten by the pipeline/i);
    expect(runbook).toMatch(/Never\s+overwrite or remove/);
    expect(runbook).toMatch(/\/etc\/nginx\/sites-available\/admin\.voice\.truevinecloud\.online/);
  });
});
