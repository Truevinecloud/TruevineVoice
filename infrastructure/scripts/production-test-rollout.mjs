import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { assertKnownAuditAction, hashToken, isSafeAuditMetadata } from '@truevine/auth';
import { checkPassword, hashPassword, verifyPassword } from '@truevine/auth/passwords';
import { createDatabaseClient } from '@truevine/database';
import { INVENTORY } from './qa-role-test-kit.mjs';
import { bootstrapPlatformOwner, readBootstrapApproval } from './bootstrap-platform-owner.mjs';
import { readPinnedOwnerPublicKey, verifyOwnerAuthorization } from './production-test-rollout-owner-auth.mjs';
import { executePrivateHttp } from './production-test-http.mjs';

export const ROLLOUT_ACCOUNTS = INVENTORY.map(account => ({ ...account, email: account.email.replace('@example.invalid', '@truevoice.com') }));
export const INVENTORY_DIGEST = createHash('sha256').update(JSON.stringify(ROLLOUT_ACCOUNTS)).digest('hex');
const SOURCE = 'production_test_rollout_v1';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const REFERENCE = /^[A-Z][A-Z0-9_-]{2,63}$/;
const OWNER = 'qa-platform-owner@truevoice.com';
const ACTIONS = ['bootstrap', 'initialize', 'provision', 'verify', 'http', 'disable'];
const fail = () => { throw new Error('Rollout refused; reconcile approved operation securely.'); };

export function validateRollout(approval, credentials, environment, confirmProduction = false, now = Date.now(), pinnedOwnerPublicKeyDer) {
  if (environment.TEST_ACCOUNT_ROLLOUT_ENABLED !== '1' || approval?.version !== 1 ||
      !ACTIONS.includes(approval.action) || !['test', 'production'].includes(approval.environment) ||
      environment.NODE_ENV !== approval.environment || environment.APP_VERSION !== approval.releaseSha ||
      !/^[a-f0-9]{40}$/.test(approval.releaseSha ?? '') || approval.inventoryDigest !== INVENTORY_DIGEST ||
      !/^[a-f0-9]{40}$/.test(approval.provisioningReleaseSha ?? '') ||
      !UUID.test(approval.operationId ?? '') || !UUID.test(approval.bootstrapOperationId ?? '') ||
      !UUID.test(approval.provisionOperationId ?? '') || !REFERENCE.test(approval.approvalReference ?? '') ||
      !REFERENCE.test(approval.credentialReference ?? '') || credentials?.reference !== approval.credentialReference ||
      !REFERENCE.test(approval.operatorReference ?? '') || !REFERENCE.test(approval.rehearsalReference ?? '') ||
      !Number.isFinite(Date.parse(approval.expiresAt)) || Date.parse(approval.expiresAt) <= now || Date.parse(approval.expiresAt) > now + 86400000) fail();
  if (approval.email !== OWNER || !UUID.test(approval.preservedAdmin?.userId ?? '') ||
      !UUID.test(approval.preservedAdmin?.organizationId ?? '') ||
      !UUID.test(approval.isolationOrganizationId ?? '') || approval.isolationFixtureAuthorized !== true) fail();
  let url, origin;
  try { url = new URL(environment.DATABASE_URL); origin = new URL(approval.applicationOrigin); } catch { fail(); }
  if (!['postgresql:', 'postgres:'].includes(url.protocol) || url.hash ||
      url.hostname !== approval.database?.hostname || (url.port || '5432') !== approval.database?.port ||
      decodeURIComponent(url.pathname.slice(1)) !== approval.database?.name ||
      !/^[a-z][a-z0-9_]{0,62}$/.test(approval.database?.name ?? '') ||
      [...url.searchParams.keys()].some(key => !['schema', 'sslmode'].includes(key)) ||
      new Set(url.searchParams.keys()).size !== [...url.searchParams.keys()].length ||
      (url.searchParams.has('schema') && url.searchParams.get('schema') !== 'public') ||
      !/^[0-9]{16,20}$/.test(approval.database?.systemIdentifier ?? '') ||
      origin.origin !== approval.applicationOrigin || origin.username || origin.password ||
      environment.WEB_PUBLIC_URL !== origin.origin) fail();
  if (approval.environment === 'production') {
    if (!confirmProduction || approval.productionAuthorized !== true || origin.origin !== 'https://voice.truevinecloud.online' || environment.NODE_TLS_REJECT_UNAUTHORIZED === '0' ||
        (approval.bootstrapApplicationOrigin && approval.bootstrapApplicationOrigin !== origin.origin)) fail();
  } else if (environment.ROLLOUT_E2E_DISPOSABLE !== '1' || confirmProduction ||
      !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) ||
      !/^truevine_bootstrap_test_[a-f0-9]{16}$/.test(approval.database.name) ||
      !['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname) || !['http:', 'https:'].includes(origin.protocol)) fail();
  let pinnedKey = pinnedOwnerPublicKeyDer;
  if (approval.environment === 'production' && !pinnedKey) {
    try { pinnedKey = readPinnedOwnerPublicKey(); } catch { fail(); }
  }
  const ownerAuthorization = verifyOwnerAuthorization(approval, environment, now, pinnedKey);
  if ((approval.environment === 'production' || approval.ownerAuthorization) && !ownerAuthorization) fail();
  if (approval.action === 'bootstrap') {
    if (approval.operationId !== approval.bootstrapOperationId || environment.PLATFORM_OWNER_BOOTSTRAP_ENABLED !== '1') fail();
  } else if (!UUID.test(approval.actorUserId ?? '')) fail();
  if (!['bootstrap', 'provision'].includes(approval.action) &&
      [approval.bootstrapOperationId, approval.provisionOperationId].includes(approval.operationId)) fail();
  if (approval.action === 'provision' && (approval.operationId !== approval.provisionOperationId || approval.provisioningReleaseSha !== approval.releaseSha)) fail();
  if (['initialize', 'http'].includes(approval.action) && approval.httpAuthorized !== true) fail();
  if (credentials?.version !== 1 || Object.keys(credentials.passwords ?? {}).length !== 11 ||
      Object.keys(credentials.passwords).some(email => !ROLLOUT_ACCOUNTS.some(account => account.email === email)) ||
      ROLLOUT_ACCOUNTS.some(account => checkPassword(credentials.passwords[account.email]) !== undefined) ||
      new Set(Object.values(credentials.passwords)).size !== 11) fail();
  return { origin: origin.origin, ownerAuthorization };
}

function assertRelease(approval) {
  if (approval.environment !== 'production') return;
  const root = resolve(import.meta.dirname, '../..');
  if (realpathSync('/var/www/TruevineVoice/current') !== realpathSync(root) ||
      readFileSync(resolve(root, 'REVISION'), 'utf8').trim() !== approval.releaseSha ||
      readFileSync(resolve(root, 'READY'), 'utf8').trim() !== approval.releaseSha) fail();
}

function checkAssignment(user, account, organizationId) {
  return account.scope === 'organization'
    ? user.platformRole === null && user.memberships.length === 1 && user.memberships[0].organizationId === organizationId && user.memberships[0].role === account.role
    : user.memberships.length === 0 && user.platformRole?.role === account.role && user.platformRole.revokedAt === null;
}
const include = { memberships: true, platformRole: true };

/** All database writes are fenced by fixed advisory lock + serializable reads +
 * the durable audit primary key equal to the approved operation UUID. No schema
 * changes or alternate first-owner claim are introduced. */
export async function executeRollout(approval, credentials, options = {}, dependencies = {}) {
  const environment = dependencies.environment ?? process.env;
  const validation = validateRollout(approval, credentials, environment, options.confirmProduction);
  assertRelease(approval);
  if (approval.action === 'bootstrap') fail();
  const database = (dependencies.createClient ?? createDatabaseClient)(environment.DATABASE_URL, { log: [] });
  const audit = (tx, id, action, metadata) => {
    assertKnownAuditAction(action);
    const safe = {
      source: SOURCE, releaseSha: approval.releaseSha, provisionOperationId: approval.provisionOperationId,
      bootstrapOperationId: approval.bootstrapOperationId, approvalReference: approval.approvalReference,
      operatorReference: approval.operatorReference, inventoryDigest: INVENTORY_DIGEST, ...metadata,
      ...(validation.ownerAuthorization ? { ownerAuthorizationKeyId: validation.ownerAuthorization.keyId,
        ownerAuthorizationDigest: validation.ownerAuthorization.digest } : {}),
    };
    if (!isSafeAuditMetadata(safe)) fail();
    return tx.identityAuditEvent.create({ data: { id, actorUserId: approval.actorUserId, action, outcome: 'SUCCESS', metadata: safe } });
  };
  try {
    let phase = 'database-fingerprint';
    return await database.$transaction(async tx => {
      const identity = await tx.$queryRaw`SELECT current_database() AS name`;
      const cluster = await tx.$queryRaw`SELECT system_identifier::text AS name FROM pg_catalog.pg_control_system()`;
      if (identity[0]?.name !== approval.database.name || cluster[0]?.name !== approval.database.systemIdentifier) fail();
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(712340983)::text AS acquired`;
      if (Date.parse(approval.expiresAt) <= Date.now()) fail();
      await tx.$queryRaw`SELECT id FROM users WHERE id=${approval.actorUserId}::uuid FOR SHARE`;
      await tx.$queryRaw`SELECT user_id FROM platform_role_assignments WHERE user_id=${approval.actorUserId}::uuid FOR SHARE`;
      const admin = await tx.user.findUnique({ where: { email: 'admin@truevoice.com' }, select: { id: true, status: true, memberships: true, platformRole: true } });
      phase = 'administrator-preservation';
      if (admin?.id !== approval.preservedAdmin.userId || admin.status !== 'ACTIVE' || admin.platformRole ||
          admin.memberships.length !== 1 || admin.memberships[0].organizationId !== approval.preservedAdmin.organizationId || admin.memberships[0].role !== 'OWNER') fail();
      const claim = await tx.platformOwnerBootstrap.findUnique({ where: { slot: 'first_platform_owner' } });
      const owner = await tx.user.findUnique({ where: { email: OWNER }, include });
      phase = 'bootstrap-state';
      if (!owner || claim?.userId !== owner.id || claim.operationId !== approval.bootstrapOperationId || owner.id !== approval.actorUserId ||
          owner.status !== 'ACTIVE' || !checkAssignment(owner, { scope: 'platform', role: 'PLATFORM_OWNER' })) fail();
      const bootstrapAudit = await tx.identityAuditEvent.findUnique({ where: { id: claim.auditEventId } });
      phase = 'bootstrap-audit';
      if (bootstrapAudit?.action !== 'platform.owner.bootstrapped' || bootstrapAudit.actorUserId !== owner.id || bootstrapAudit.outcome !== 'SUCCESS' ||
          bootstrapAudit.metadata.environment !== approval.environment || bootstrapAudit.metadata.subjectUserId !== owner.id || bootstrapAudit.metadata.operationId !== claim.operationId) fail();
      const passwordReady = await verifyPassword(owner.passwordHash, credentials.passwords[OWNER]);
      if (approval.action === 'initialize') {
        phase = 'initialization-state';
        const artifact = options.artifact;
        const link = new URL(artifact?.activationUrl);
        if (artifact.operationId !== claim.operationId || artifact.email !== OWNER ||
            link.origin !== (approval.bootstrapApplicationOrigin ?? approval.applicationOrigin) || link.pathname !== '/set-password' ||
            link.hash || link.username || link.password || [...link.searchParams.keys()].join() !== 'token') fail();
        const raw = link.searchParams.get('token');
        if (!raw || !/^[A-Za-z0-9_-]{40,100}$/.test(raw)) fail();
        const token = await tx.passwordResetToken.findUnique({ where: { tokenHash: hashToken(raw) } });
        if (token?.userId !== owner.id || (token.usedAt ? !passwordReady : token.expiresAt <= new Date())) fail();
        await recordOwnerAuthorization(tx, approval, options, audit, validation.ownerAuthorization);
        return { ownerId: owner.id, initialized: passwordReady && Boolean(token.usedAt), preservedAdminId: admin.id };
      }
      if (!passwordReady) fail();
      const batch = await tx.identityAuditEvent.findUnique({ where: { id: approval.provisionOperationId } });
      let organization = await tx.organization.findUnique({ where: { slug: 'truevoice-testing' } });
      const isolation = await tx.organization.findUnique({ where: { id: approval.isolationOrganizationId } });
      // Every tenant must retain exactly one OWNER. Use an independently
      // approved existing synthetic tenant; never create an ownerless fixture or
      // add a second membership to a working test identity/preserved admin.
      if (!isolation || !['truevoice-testing-isolation', 'truevine-voice-qa'].includes(isolation.slug) || isolation.suspendedAt) fail();
      if (batch && (batch.action !== 'test_rollout.provisioned' || batch.actorUserId !== owner.id || batch.metadata.source !== SOURCE || batch.metadata.inventoryDigest !== INVENTORY_DIGEST ||
          batch.metadata.releaseSha !== approval.provisioningReleaseSha || batch.metadata.bootstrapOperationId !== claim.operationId ||
          batch.metadata.organizationId !== organization?.id || batch.metadata.isolationOrganizationId !== isolation?.id)) fail();
      if (!batch && (organization || approval.action !== 'provision')) fail();
      if (organization?.suspendedAt || isolation?.suspendedAt) fail();
      const accounts = [];
      for (const account of ROLLOUT_ACCOUNTS.filter(item => item.role !== 'PLATFORM_OWNER')) {
        const user = await tx.user.findUnique({ where: { email: account.email }, include });
        if (batch) {
          if (!user || batch.metadata.userIds?.[account.role] !== user.id ||
              !checkAssignment(user, account, organization.id) ||
              !['ACTIVE', ...(approval.action === 'disable' ? ['SUSPENDED'] : [])].includes(user.status) ||
              !(await verifyPassword(user.passwordHash, credentials.passwords[account.email]))) fail();
        } else if (user) fail();
        accounts.push({ account, user });
      }
      if (approval.action === 'provision' && !batch) {
        organization = await tx.organization.create({ data: { slug: 'truevoice-testing', name: 'truevoice-testing' } });
        const userIds = {};
        for (const { account } of accounts) {
          const id = randomUUID();
          await tx.user.create({ data: { id, email: account.email, passwordHash: await hashPassword(credentials.passwords[account.email]) } });
          if (account.scope === 'organization') await tx.membership.create({ data: { organizationId: organization.id, userId: id, role: account.role } });
          else await tx.platformRoleAssignment.create({ data: { userId: id, role: account.role, grantedByUserId: owner.id } });
          userIds[account.role] = id;
          await audit(tx, randomUUID(), 'test_rollout.account_created', { targetUserId: id, role: account.role, organizationId: account.scope === 'organization' ? organization.id : null });
        }
        await audit(tx, approval.provisionOperationId, 'test_rollout.provisioned', { organizationId: organization.id, isolationOrganizationId: isolation.id, userIds });
      }
      if (approval.action === 'disable') {
        const prior = await tx.identityAuditEvent.findUnique({ where: { id: approval.operationId } });
        if (prior && (prior.action !== 'test_rollout.disabled' || prior.actorUserId !== owner.id || prior.metadata.source !== SOURCE || prior.metadata.provisionOperationId !== approval.provisionOperationId)) fail();
        const now = new Date();
        for (const { user } of accounts) {
          if (user.status !== 'SUSPENDED') await tx.user.update({ where: { id: user.id }, data: { status: 'SUSPENDED' } });
          await tx.session.updateMany({ where: { userId: user.id, revokedAt: null }, data: { revokedAt: now, revokedReason: 'test_rollout_disabled' } });
          await tx.passwordResetToken.updateMany({ where: { userId: user.id, usedAt: null }, data: { expiresAt: now } });
          // Scope tenant-owned support rows to the approved fixture tenants.
          // Revoking the owning authentication sessions above also invalidates
          // support access outside these fixtures without editing other tenants.
          for (const organizationId of [organization.id, isolation.id]) {
            const sessions = await tx.supportAccessSession.findMany({ where: { organizationId, actorUserId: user.id, revokedAt: null }, select: { id: true } });
            for (const session of sessions) await tx.supportAccessSession.update({ where: { organizationId_id: { organizationId, id: session.id } }, data: { revokedAt: now } });
          }
        }
        if (!prior) await audit(tx, approval.operationId, 'test_rollout.disabled', { organizationId: organization.id });
      }
      if (['verify', 'http'].includes(approval.action))
        await recordOwnerAuthorization(tx, approval, options, audit, validation.ownerAuthorization);
      if (Date.parse(approval.expiresAt) <= Date.now()) fail();
      return { operationId: approval.operationId, organizationId: organization.id, isolationOrganizationId: isolation.id,
        preservedAdminId: admin.id, ownerId: owner.id, accountCount: 11, state: approval.action === 'disable' ? 'ten-disabled-owner-preserved' : 'verified',
        ...(validation.ownerAuthorization ? { ownerAuthorizationKeyId: validation.ownerAuthorization.keyId,
          ownerAuthorizationDigest: validation.ownerAuthorization.digest } : {}) };
    }, { isolationLevel: 'Serializable', timeout: 120000 });
  } catch (error) {
    if (process.env.NODE_ENV === 'test' && process.env.ROLLOUT_E2E_DISPOSABLE === '1')
      throw new Error(`Disposable rollout transaction failed during ${phase}.`);
    fail();
  }
  finally { try { await database.$disconnect(); } catch { fail(); } }
}

function recordOwnerAuthorization(tx, approval, options, audit, authorization) {
  if (!authorization) return;
  return tx.identityAuditEvent.findUnique({ where: { id: approval.operationId } }).then(async prior => {
    if (prior) {
      if (options.authorizationReconciliation === true && prior.action === 'test_rollout.owner_authorization_used' &&
          prior.actorUserId === approval.actorUserId && prior.metadata?.action === approval.action &&
          prior.metadata?.ownerAuthorizationDigest === authorization.digest && prior.metadata?.ownerAuthorizationKeyId === authorization.keyId) return;
      fail();
    }
    await audit(tx, approval.operationId, 'test_rollout.owner_authorization_used', { action: approval.action,
      credentialReference: approval.credentialReference, expiresAt: approval.expiresAt });
  });
}

export async function rolloutMain(argv = process.argv.slice(2)) {
  try {
    if (argv.length === 1 && argv[0] === 'inventory') {
      process.stdout.write(`${JSON.stringify({ inventoryDigest: INVENTORY_DIGEST, accounts: ROLLOUT_ACCOUNTS })}\n`); return;
    }
    if (argv.length === 1 && argv[0] === 'template') {
      process.stdout.write(`${JSON.stringify({ approval: {
        version: 1, action: 'bootstrap', environment: 'production', productionAuthorized: false,
        releaseSha: null, provisioningReleaseSha: null, inventoryDigest: INVENTORY_DIGEST, operationId: null, bootstrapOperationId: null, provisionOperationId: null,
        email: OWNER, actorUserId: null, preservedAdmin: { userId: null, organizationId: null },
        isolationOrganizationId: null, isolationFixtureAuthorized: false,
        approvalReference: null, operatorReference: null, credentialReference: null, rehearsalReference: null, expiresAt: null,
        ownerAuthorization: null,
        database: { hostname: null, port: null, name: null, systemIdentifier: null }, applicationOrigin: 'https://voice.truevinecloud.online', httpAuthorized: false,
      }, credentials: { version: 1, reference: null, passwords: Object.fromEntries(ROLLOUT_ACCOUNTS.map(account => [account.email, null])) } }, null, 2)}\n`); return;
    }
    if (process.env.TEST_ACCOUNT_ROLLOUT_ENABLED !== '1') fail();
    const [action, ...args] = argv;
    if (!ACTIONS.includes(action)) fail();
    const options = {};
    for (let index = 0; index < args.length; index++) {
      const key = args[index];
      if (key === '--confirm-production' && !options[key]) options[key] = true;
      else if (['--approval', '--credentials', '--artifact', '--activation-directory'].includes(key) && !options[key] && args[index + 1] && !args[index + 1].startsWith('--')) options[key] = args[++index];
      else fail();
    }
    const approval = readBootstrapApproval(options['--approval']);
    const credentials = readBootstrapApproval(options['--credentials']);
    if (approval.action !== action) fail();
    const validation = validateRollout(approval, credentials, process.env, options['--confirm-production']);
    assertRelease(approval);
    let result;
    if (action === 'bootstrap') {
      result = await bootstrapPlatformOwner({ environment: approval.environment, email: OWNER, operationId: approval.operationId,
        approvalFile: options['--approval'], activationDirectory: options['--activation-directory'], confirmProduction: options['--confirm-production'],
        ownerAuthorization: validation.ownerAuthorization });
    } else if (['initialize', 'http'].includes(action)) {
      result = await executePrivateHttp(approval, credentials, { confirmProduction: options['--confirm-production'],
        artifact: action === 'initialize' ? readBootstrapApproval(options['--artifact']) : undefined });
    } else result = await executeRollout(approval, credentials, { confirmProduction: options['--confirm-production'] });
    process.stdout.write(`${JSON.stringify({ ...result, ...(validation.ownerAuthorization ? { ownerAuthorizationKeyId: validation.ownerAuthorization.keyId,
      ownerAuthorizationDigest: validation.ownerAuthorization.digest } : {}) })}\n`);
  } catch (error) {
    // Disposable E2E diagnostics may expose only a fixed-format HTTP assertion
    // label. Never forward arbitrary exception text, child output, or paths.
    if (process.env.NODE_ENV === 'test' && process.env.ROLLOUT_E2E_DISPOSABLE === '1' && error instanceof Error &&
        (/^Private HTTP verification failed(?: \([A-Za-z0-9:_-]+\))?; no secrets reported\.$/.test(error.message) ||
         /^Disposable rollout transaction failed during [a-z-]+\.$/.test(error.message))) {
      process.stderr.write(`${error.message}\n`);
      process.exitCode = 1;
      return;
    }
    process.stderr.write('Production test rollout refused or failed. No success claimed. Reconcile privately before retrying.\n');
    process.exitCode = 1;
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await rolloutMain();
