import { createHash, createPrivateKey, createPublicKey, sign, verify } from 'node:crypto';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { readBootstrapPrivateFile, readBootstrapApproval, createBootstrapPrivateFile } from './bootstrap-platform-owner.mjs';
import { isAbsolute, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const PUBLIC_KEY_ENV = 'TEST_ACCOUNT_ROLLOUT_OWNER_PUBLIC_KEY_DER';
const ACTIONS = new Set(['bootstrap', 'initialize', 'provision', 'verify', 'http', 'disable']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const REFERENCE = /^[A-Z][A-Z0-9_-]{2,63}$/;
const PINNED_PUBLIC_KEY_PATH = '/etc/truevine/test-account-rollout-owner-public.der';

function decodeBase64Url(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value)) throw new Error('invalid');
  const bytes = Buffer.from(value, 'base64url');
  if (bytes.toString('base64url') !== value) throw new Error('invalid');
  return bytes;
}

export function ownerAuthorizationPayload(approval) {
  const payload = [
    approval.version, approval.action, approval.environment, approval.productionAuthorized,
    approval.releaseSha, approval.provisioningReleaseSha, approval.inventoryDigest,
    approval.operationId, approval.bootstrapOperationId, approval.provisionOperationId,
    approval.email, approval.actorUserId ?? null,
    approval.preservedAdmin?.userId ?? null, approval.preservedAdmin?.organizationId ?? null,
    approval.isolationOrganizationId ?? null, approval.isolationFixtureAuthorized,
    approval.approvalReference, approval.operatorReference, approval.credentialReference,
    approval.rehearsalReference, approval.expiresAt,
    approval.database?.hostname ?? null, approval.database?.port ?? null,
    approval.database?.name ?? null, approval.database?.systemIdentifier ?? null,
    approval.applicationOrigin, approval.bootstrapApplicationOrigin ?? null,
    approval.httpAuthorized,
  ];
  return Buffer.from(JSON.stringify(payload));
}

export function ownerAuthorizationKeyId(publicKey) {
  const key = publicKey?.type === 'public' ? publicKey : createPublicKey(publicKey);
  if (key.asymmetricKeyType !== 'ed25519') throw new Error('invalid');
  return createHash('sha256').update(key.export({ format: 'der', type: 'spki' })).digest('hex');
}

export function signOwnerAuthorization(approval, privateKeyInput, { allowTest = false } = {}) {
  const now = Date.now();
  let origin;
  try { origin = new URL(approval?.applicationOrigin); } catch { throw new Error('invalid'); }
  const testOrigin = approval?.environment === 'test' && ['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname) && ['http:', 'https:'].includes(origin.protocol);
  if (approval?.version !== 1 || !['production', ...(allowTest ? ['test'] : [])].includes(approval.environment) ||
      (approval.environment === 'production' ? approval.productionAuthorized !== true : approval.productionAuthorized === true || !testOrigin) ||
      !ACTIONS.has(approval.action) || approval.ownerAuthorization || approval.email !== 'qa-platform-owner@truevoice.com' ||
      !/^[a-f0-9]{40}$/.test(approval.releaseSha ?? '') || !/^[a-f0-9]{40}$/.test(approval.provisioningReleaseSha ?? '') ||
      !/^[a-f0-9]{64}$/.test(approval.inventoryDigest ?? '') || !UUID.test(approval.operationId ?? '') ||
      !UUID.test(approval.bootstrapOperationId ?? '') || !UUID.test(approval.provisionOperationId ?? '') ||
      !REFERENCE.test(approval.approvalReference ?? '') || !REFERENCE.test(approval.operatorReference ?? '') ||
      !REFERENCE.test(approval.credentialReference ?? '') || !REFERENCE.test(approval.rehearsalReference ?? '') ||
      !UUID.test(approval.preservedAdmin?.userId ?? '') || !UUID.test(approval.preservedAdmin?.organizationId ?? '') ||
      !UUID.test(approval.isolationOrganizationId ?? '') || approval.isolationFixtureAuthorized !== true ||
      !/^[a-z][a-z0-9_]{0,62}$/.test(approval.database?.name ?? '') ||
      !/^[0-9]{1,5}$/.test(approval.database?.port ?? '') || !/^[0-9]{16,20}$/.test(approval.database?.systemIdentifier ?? '') ||
      typeof approval.database?.hostname !== 'string' || approval.database.hostname.length > 253 ||
      (approval.environment === 'production' && approval.applicationOrigin !== 'https://voice.truevinecloud.online') ||
      (approval.action === 'bootstrap' ? approval.operationId !== approval.bootstrapOperationId || approval.actorUserId != null : !UUID.test(approval.actorUserId ?? '')) ||
      (approval.action === 'provision' && (approval.operationId !== approval.provisionOperationId || approval.provisioningReleaseSha !== approval.releaseSha)) ||
      (['initialize', 'http'].includes(approval.action) && approval.httpAuthorized !== true) ||
      !Number.isFinite(Date.parse(approval.expiresAt)) || Date.parse(approval.expiresAt) <= Date.now() ||
      Date.parse(approval.expiresAt) > now + 86400000) throw new Error('invalid');
  const privateKey = privateKeyInput?.type === 'private' ? privateKeyInput : createPrivateKey(privateKeyInput);
  if (privateKey.asymmetricKeyType !== 'ed25519') throw new Error('invalid');
  const publicKey = createPublicKey(privateKey);
  const payload = ownerAuthorizationPayload(approval);
  return {
    ...approval,
    ownerAuthorization: {
      algorithm: 'Ed25519',
      keyId: ownerAuthorizationKeyId(publicKey),
      signature: sign(null, payload, privateKey).toString('base64url'),
    },
  };
}

export function readPinnedOwnerPublicKey() {
  const stat = lstatSync(PINNED_PUBLIC_KEY_PATH);
  if (!stat.isFile() || stat.uid !== 0 || stat.nlink !== 1 || (stat.mode & 0o022) !== 0 || stat.size < 32 || stat.size > 256 ||
      realpathSync(PINNED_PUBLIC_KEY_PATH) !== PINNED_PUBLIC_KEY_PATH) throw new Error('invalid');
  for (let path = '/etc/truevine'; ; path = path.slice(0, path.lastIndexOf('/')) || '/') {
    const ancestor = lstatSync(path);
    if (!ancestor.isDirectory() || ancestor.uid !== 0 || (ancestor.mode & 0o022) !== 0) throw new Error('invalid');
    if (path === '/') break;
  }
  const key = readFileSync(PINNED_PUBLIC_KEY_PATH);
  const parsed = createPublicKey({ key, format: 'der', type: 'spki' });
  if (parsed.asymmetricKeyType !== 'ed25519') throw new Error('invalid');
  return key;
}

export function verifyOwnerAuthorization(approval, environment, now = Date.now(), pinnedPublicKeyDer) {
  if (approval?.environment !== 'production' && !approval?.ownerAuthorization) return undefined;
  try {
    if (environment.NODE_ENV !== approval.environment ||
        (approval.environment === 'production' && approval.productionAuthorized !== true) ||
        !ACTIONS.has(approval.action) || !Number.isFinite(Date.parse(approval.expiresAt)) ||
        Date.parse(approval.expiresAt) <= now || Date.parse(approval.expiresAt) > now + 86400000) return undefined;
    const publicKeyDer = approval.environment === 'production'
      ? pinnedPublicKeyDer
      : decodeBase64Url(environment[PUBLIC_KEY_ENV]);
    if (!Buffer.isBuffer(publicKeyDer)) return undefined;
    const publicKey = createPublicKey({ key: publicKeyDer, format: 'der', type: 'spki' });
    if (publicKey.asymmetricKeyType !== 'ed25519') return undefined;
    const keyId = ownerAuthorizationKeyId(publicKey);
    const authorization = approval.ownerAuthorization;
    if (authorization?.algorithm !== 'Ed25519' || authorization.keyId !== keyId) return undefined;
    const signature = decodeBase64Url(authorization.signature);
    if (signature.length !== 64) return undefined;
    const payload = ownerAuthorizationPayload(approval);
    if (!verify(null, payload, publicKey, signature)) return undefined;
    return { keyId, digest: createHash('sha256').update(payload).digest('hex') };
  } catch {
    return undefined;
  }
}

function parseOptions(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index++) {
    const flag = argv[index];
    if (!['--draft', '--owner-key', '--output'].includes(flag) || options[flag] || !argv[index + 1] || argv[index + 1].startsWith('--')) throw new Error('invalid');
    options[flag] = argv[++index];
  }
  if (Object.keys(options).length !== 3 || Object.values(options).some(value => !isAbsolute(value))) throw new Error('invalid');
  return options;
}

export async function signOwnerApprovalFile(argv) {
  const options = parseOptions(argv);
  const approval = readBootstrapApproval(options['--draft']);
  const allowTest = approval.environment === 'test' && process.env.NODE_ENV === 'test' && process.env.ROLLOUT_E2E_DISPOSABLE === '1';
  if (approval.environment !== 'production' && !allowTest) throw new Error('invalid');
  const privateKey = readBootstrapPrivateFile(options['--owner-key'], 8192);
  const signed = signOwnerAuthorization(approval, privateKey, { allowTest });
  const publicKey = createPublicKey(createPrivateKey(privateKey));
  const outputPath = createBootstrapPrivateFile(options['--output'], `${JSON.stringify(signed, null, 2)}\n`);
  return { action: approval.action, keyId: signed.ownerAuthorization.keyId,
    publicKeyDer: publicKey.export({ format: 'der', type: 'spki' }).toString('base64url'), outputPath: resolve(outputPath) };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const result = await signOwnerApprovalFile(process.argv.slice(2));
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch {
    process.stderr.write('Owner authorization refused; no approval was signed.\n');
    process.exitCode = 1;
  }
}
