import { execFileSync } from 'node:child_process';
import { chmodSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const fail = () => { throw new Error('Linux rollout rehearsal requires an explicitly disposable loopback PostgreSQL admin URL; no production target is accepted.'); };

function disposableAdminUrl(value) {
  try {
    const url = new URL(value);
    return ['postgres:', 'postgresql:'].includes(url.protocol) && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) &&
      url.pathname === '/postgres' && !url.hash && [...url.searchParams.keys()].every(key => ['schema', 'sslmode'].includes(key)) &&
      (!url.searchParams.has('schema') || url.searchParams.get('schema') === 'public');
  } catch { return false; }
}

if (process.platform !== 'linux' || process.env.NODE_ENV !== 'test' || process.env.ROLLOUT_E2E_DISPOSABLE !== '1' ||
    !disposableAdminUrl(process.env.ROLLOUT_TEST_ADMIN_URL)) fail();

const directory = mkdtempSync(join(tmpdir(), 'truevine-rollout-tls-'));
chmodSync(directory, 0o700);
const certificate = join(directory, 'localhost.crt');
const privateKey = join(directory, 'localhost.key');
try {
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', privateKey,
    '-out', certificate, '-days', '1', '-subj', '/CN=127.0.0.1', '-addext', 'subjectAltName=IP:127.0.0.1'],
  { cwd: root, stdio: 'ignore', timeout: 30000 });
  chmodSync(privateKey, 0o600); chmodSync(certificate, 0o600);
  const env = { ...process.env, ROLLOUT_E2E_HTTPS: '1', ROLLOUT_E2E_TLS_CERT: certificate,
    ROLLOUT_E2E_TLS_KEY: privateKey, NODE_EXTRA_CA_CERTS: certificate };
  execFileSync('npm', ['run', 'build:packages'], { cwd: root, env, stdio: 'inherit', timeout: 180000 });
  execFileSync('npm', ['run', 'test:e2e', '--workspace', '@truevine/api', '--', 'production-test-rollout.e2e-spec.ts'],
    { cwd: root, env, stdio: 'inherit', timeout: 240000 });
} finally {
  const tempRoot = resolve(tmpdir());
  if (resolve(directory).startsWith(`${tempRoot}/`) && directory.includes('truevine-rollout-tls-'))
    rmSync(directory, { recursive: true });
}
