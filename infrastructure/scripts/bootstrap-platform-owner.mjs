import { randomBytes, randomUUID } from 'node:crypto';
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
  fsyncSync,
} from 'node:fs';
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  assertKnownAuditAction,
  checkEmail,
  generateToken,
  hashToken,
  isSafeAuditMetadata,
  sensitiveAudit,
} from '@truevine/auth';
import { hashPassword } from '@truevine/auth/passwords';
import { createDatabaseClient } from '@truevine/database';

export const BOOTSTRAP_SLOT = 'first_platform_owner';
export const BOOTSTRAP_ACTION = 'platform.owner.bootstrapped';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const REFERENCE = /^[A-Z][A-Z0-9_-]{2,63}$/;
const DAY = 24 * 60 * 60 * 1000;
const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

export class BootstrapRefusal extends Error {
  constructor(code) {
    super(code);
    this.name = 'BootstrapRefusal';
    this.code = code;
  }
}
function refuse(code) {
  throw new BootstrapRefusal(code);
}

/** Pure target/approval validation. No connection or artifact before this passes. */
export function validateBootstrapApproval(options, environment, approval, now = new Date()) {
  if (environment.PLATFORM_OWNER_BOOTSTRAP_ENABLED !== '1') refuse('bootstrap_not_authorized');
  if (
    !['test', 'staging', 'production'].includes(options.environment) ||
    environment.NODE_ENV !== options.environment
  )
    refuse('invalid_bootstrap_environment');
  const email = checkEmail(options.email ?? '');
  if (!email.ok || !UUID.test(options.operationId ?? '')) refuse('invalid_bootstrap_identity');
  if (
    approval?.version !== 1 ||
    approval.environment !== options.environment ||
    approval.email !== email.value ||
    approval.operationId !== options.operationId ||
    !REFERENCE.test(approval.approvalReference ?? '') ||
    !REFERENCE.test(approval.operatorReference ?? '')
  )
    refuse('bootstrap_approval_mismatch');
  const expires = Date.parse(approval.expiresAt);
  if (!Number.isFinite(expires) || expires <= now.getTime() || expires > now.getTime() + DAY)
    refuse('bootstrap_approval_expired');
  let database, application;
  try {
    database = new URL(environment.DATABASE_URL);
    application = new URL(approval.applicationOrigin);
  } catch {
    refuse('invalid_bootstrap_target');
  }
  const name = decodeURIComponent(database.pathname.slice(1));
  if (
    !['postgresql:', 'postgres:'].includes(database.protocol) ||
    !/^[a-z][a-z0-9_]{0,62}$/.test(name) ||
    database.hash ||
    database.hostname !== approval.database?.hostname ||
    (database.port || '5432') !== approval.database?.port ||
    name !== approval.database?.name ||
    [...database.searchParams.keys()].some((key) => !['schema', 'sslmode'].includes(key)) ||
    new Set(database.searchParams.keys()).size !== [...database.searchParams.keys()].length ||
    (database.searchParams.has('schema') && database.searchParams.get('schema') !== 'public') ||
    application.protocol !== 'https:' ||
    application.origin !== approval.applicationOrigin ||
    application.username ||
    application.password ||
    application.pathname !== '/' ||
    application.search ||
    application.hash ||
    environment.WEB_PUBLIC_URL !== application.origin
  )
    refuse('bootstrap_target_mismatch');
  if (options.environment === 'production') {
    if (
      options.confirmProduction !== true ||
      approval.productionAuthorized !== true ||
      application.origin !== 'https://voice.truevinecloud.online'
    )
      refuse('production_bootstrap_not_authorized');
    if (!/^[0-9]{16,20}$/.test(approval.database?.systemIdentifier ?? ''))
      refuse('production_database_identity_required');
  } else if (
    application.hostname === 'voice.truevinecloud.online' ||
    /prod/i.test(database.hostname) ||
    /prod/i.test(name)
  ) {
    refuse('production_target_in_nonproduction');
  }
  if (
    options.environment === 'test' &&
    (!['127.0.0.1', 'localhost', '[::1]'].includes(database.hostname) ||
      !/^truevine_bootstrap_test_[a-f0-9]{16}$/.test(name))
  )
    refuse('test_database_not_disposable');
  if (options.environment === 'staging' && !/^truevine_(staging|uat)(_[a-z0-9]+)*$/.test(name))
    refuse('staging_database_not_allowlisted');
  assertKnownAuditAction(BOOTSTRAP_ACTION);
  return {
    email: email.value,
    databaseName: name,
    applicationOrigin: application.origin,
    systemIdentifier:
      options.environment === 'production' ? approval.database.systemIdentifier : undefined,
  };
}

/** Linux-only operator filesystem contract. Windows callers fail closed. */
export function assertPrivateStat(stat, uid, directory) {
  if (
    !Number.isInteger(uid) ||
    stat.uid !== uid ||
    (stat.mode & 0o7777) !== (directory ? 0o700 : 0o600) ||
    (directory ? !stat.isDirectory() : !stat.isFile()) ||
    (!directory && stat.nlink !== 1)
  )
    refuse('unsafe_bootstrap_file_permissions');
}
function requireLinux() {
  if (process.platform !== 'linux' || !process.getuid) refuse('bootstrap_requires_linux_operator');
}
function privateDirectory(directory) {
  requireLinux();
  if (!isAbsolute(directory ?? '')) refuse('bootstrap_directory_must_be_absolute');
  const root = resolve(directory);
  const rel = relative(REPO, root);
  if (rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..') || realpathSync(root) !== root)
    refuse('unsafe_bootstrap_directory');
  assertPrivateStat(lstatSync(root), process.getuid(), true);
  // A private leaf is insufficient beneath a directory another UID can rename.
  // Sticky root/operator-owned temporary directories are safe for owned children.
  for (let ancestor = dirname(root); ; ancestor = dirname(ancestor)) {
    const stat = lstatSync(ancestor);
    if (
      !stat.isDirectory() ||
      ![0, process.getuid()].includes(stat.uid) ||
      ((stat.mode & 0o022) !== 0 && (stat.mode & 0o1000) === 0)
    )
      refuse('unsafe_bootstrap_directory_ancestor');
    if (dirname(ancestor) === ancestor) break;
  }
  return root;
}
function inPrivateDirectory(directory, work) {
  const root = privateDirectory(directory);
  const fd = openSync(root, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    assertPrivateStat(fstatSync(fd), process.getuid(), true);
    // Linux descriptor-relative paths pin operations to the directory opened,
    // rather than resolving the original pathname again after validation.
    return work(root, `/proc/self/fd/${fd}`, fd);
  } finally {
    closeSync(fd);
  }
}
export function readBootstrapApproval(file) {
  if (!isAbsolute(file ?? '')) refuse('bootstrap_approval_path_must_be_absolute');
  const canonicalFile = resolve(file);
  return inPrivateDirectory(dirname(canonicalFile), (_root, anchored) => {
    const fd = openSync(
      `${anchored}/${basename(canonicalFile)}`,
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
    try {
      const stat = fstatSync(fd);
      assertPrivateStat(stat, process.getuid(), false);
      if (stat.size > 16384) refuse('invalid_bootstrap_approval_file');
      return JSON.parse(readFileSync(fd, 'utf8'));
    } finally {
      closeSync(fd);
    }
  });
}
export function prepareBootstrapArtifact(directory, operationId, payload) {
  if (!UUID.test(operationId ?? '')) refuse('invalid_bootstrap_operation_id');
  return inPrivateDirectory(directory, (root, anchored, dirFd) => {
    const file = resolve(root, `platform-owner-${operationId}.json`);
    const name = basename(file);
    const fd = openSync(
      `${anchored}/${name}`,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    let identity;
    try {
      identity = fstatSync(fd);
      assertPrivateStat(identity, process.getuid(), false);
      writeFileSync(fd, JSON.stringify(payload));
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    // Persist the directory entry before the database is allowed to commit.
    fsyncSync(dirFd);
    return {
      path: file,
      discard: () =>
        inPrivateDirectory(root, (_root, pinned, directoryFd) => {
          const current = lstatSync(`${pinned}/${name}`);
          assertPrivateStat(current, process.getuid(), false);
          if (current.dev !== identity.dev || current.ino !== identity.ino)
            refuse('bootstrap_artifact_replaced_reconcile_operation');
          rmSync(`${pinned}/${name}`);
          fsyncSync(directoryFd);
        }),
    };
  });
}

/** Operator-only orchestration; dependencies allow unit tests without a database. */
export async function bootstrapPlatformOwner(options, dependencies = {}) {
  let db, artifact;
  try {
    const environment = dependencies.environment ?? process.env;
    // Do not even open an approval file before explicit operator opt-in.
    if (environment.PLATFORM_OWNER_BOOTSTRAP_ENABLED !== '1') refuse('bootstrap_not_authorized');
    const approval = (dependencies.readApproval ?? readBootstrapApproval)(options.approvalFile);
    const now = (dependencies.now ?? (() => new Date()))();
    const target = validateBootstrapApproval(options, environment, approval, now);
    const userId = randomUUID(),
      auditEventId = randomUUID();
    const rawToken = generateToken();
    const expiresAt = new Date(now.getTime() + DAY);
    const passwordHash = await (dependencies.hashPassword ?? hashPassword)(
      randomBytes(32).toString('base64url'),
    );
    artifact = (dependencies.prepareArtifact ?? prepareBootstrapArtifact)(
      options.activationDirectory,
      options.operationId,
      {
        operationId: options.operationId,
        email: target.email,
        expiresAt: expiresAt.toISOString(),
        activationUrl: `${target.applicationOrigin}/set-password?token=${rawToken}`,
      },
    );
    db = (dependencies.createClient ?? createDatabaseClient)(environment.DATABASE_URL, { log: [] });
    await db.$transaction(
      async (tx) => {
        const identity = await tx.$queryRaw`SELECT pg_catalog.current_database() AS name`;
        if (identity[0]?.name !== target.databaseName) refuse('connected_database_mismatch');
        if (target.systemIdentifier) {
          const cluster =
            await tx.$queryRaw`SELECT system_identifier::text AS name FROM pg_catalog.pg_control_system()`;
          if (cluster[0]?.name !== target.systemIdentifier)
            refuse('connected_database_cluster_mismatch');
        }
        if (
          (await tx.platformOwnerBootstrap.findUnique({ where: { slot: BOOTSTRAP_SLOT } })) ||
          (await tx.platformRoleAssignment.findFirst({ where: { role: 'PLATFORM_OWNER' } }))
        )
          refuse('platform_owner_already_exists');
        if (await tx.user.findUnique({ where: { email: target.email }, select: { id: true } }))
          refuse('bootstrap_identity_already_exists');
        // Recheck approval expiration after hashing and acquiring the transaction.
        if (Date.parse(approval.expiresAt) <= (dependencies.now ?? (() => new Date()))().getTime())
          refuse('bootstrap_approval_expired');
        await tx.user.create({ data: { id: userId, email: target.email, passwordHash } });
        // No existing database principal can be the first owner's grantor.
        await tx.platformRoleAssignment.create({ data: { userId, role: 'PLATFORM_OWNER' } });
        await tx.passwordResetToken.create({
          data: { userId, tokenHash: hashToken(rawToken), expiresAt },
        });
        const metadata = {
          ...sensitiveAudit({
            targetType: 'platform_role_assignment',
            targetId: userId,
            before: null,
            change: { role: 'PLATFORM_OWNER' },
            after: { role: 'PLATFORM_OWNER', revoked: false },
            reasonCode: 'approved_first_owner_bootstrap',
            requestId: options.operationId,
          }),
          actorKind: 'external_operator',
          operatorReference: approval.operatorReference,
          approvalReference: approval.approvalReference,
          environment: options.environment,
          operationId: options.operationId,
          subjectUserId: userId,
          platformRole: 'PLATFORM_OWNER',
        };
        if (!isSafeAuditMetadata(metadata)) refuse('unsafe_bootstrap_audit');
        await tx.identityAuditEvent.create({
          data: {
            id: auditEventId,
            actorUserId: userId,
            action: BOOTSTRAP_ACTION,
            outcome: 'SUCCESS',
            metadata,
          },
        });
        // A fixed primary key, validated FKs and immutable row fence all commands,
        // including concurrent attempts with different emails and operation IDs.
        await tx.platformOwnerBootstrap.create({
          data: {
            slot: BOOTSTRAP_SLOT,
            operationId: options.operationId,
            userId,
            auditEventId,
          },
        });
      },
      { isolationLevel: 'Serializable' },
    );
    return {
      operationId: options.operationId,
      userId,
      activationFile: artifact.path,
      activationExpiresAt: expiresAt.toISOString(),
    };
  } catch (error) {
    if (error instanceof BootstrapRefusal || ['P2002', 'P2034'].includes(error?.code)) {
      // These outcomes are definite refusals / rolled-back transactions.
      if (artifact) {
        try {
          artifact.discard();
        } catch {
          refuse('bootstrap_cleanup_failed_reconcile_operation');
        }
      }
      if (error instanceof BootstrapRefusal) throw error;
      refuse('bootstrap_duplicate_or_concurrent_attempt');
    }
    // Unknown/connection failures may hide a successful COMMIT. Preserve the
    // protected artifact for operator reconciliation; never rotate a token.
    refuse('bootstrap_outcome_unverified_reconcile_operation');
  } finally {
    if (db) {
      try {
        await db.$disconnect();
      } catch {
        refuse('bootstrap_shutdown_failed_reconcile_operation');
      }
    }
  }
}

function parseArguments(argv) {
  const options = {};
  const names = {
    '--email': 'email',
    '--environment': 'environment',
    '--operation-id': 'operationId',
    '--approval-file': 'approvalFile',
    '--activation-directory': 'activationDirectory',
  };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--confirm-production') {
      if (options.confirmProduction) refuse('invalid_bootstrap_arguments');
      options.confirmProduction = true;
    } else {
      const key = names[argv[i]];
      if (!key || options[key] !== undefined || !argv[i + 1] || argv[i + 1].startsWith('--'))
        refuse('invalid_bootstrap_arguments');
      options[key] = argv[++i];
    }
  }
  return options;
}
export async function main(
  argv = process.argv.slice(2),
  environment = process.env,
  dependencies = {},
) {
  if (argv.length === 1 && argv[0] === '--help') {
    process.stdout.write(
      'First Platform Owner bootstrap (Linux operator only). Requires --environment, --email, --operation-id, --approval-file and --activation-directory. Production additionally requires --confirm-production and separately approved production authorization. No password or token is printed.\n',
    );
    return;
  }
  const result = await bootstrapPlatformOwner(parseArguments(argv), {
    ...dependencies,
    environment,
  });
  process.stdout.write(
    `Bootstrap committed. Operation: ${result.operationId}\nActivation file: ${result.activationFile}\n`,
  );
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(() => {
    process.stderr.write(
      'Bootstrap refused or failed. Do not retry blindly; reconcile the approved operation using the protected runbook. No credentials are logged.\n',
    );
    process.exitCode = 1;
  });
}
