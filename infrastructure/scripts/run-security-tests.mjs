import { execFileSync, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { writeFileSync } from 'node:fs';
import ts from 'typescript';
const baseline = process.argv.includes('--baseline');
import { loadEnvFiles, requireEnv } from '@truevine/shared';

loadEnvFiles();
const configured = new URL(requireEnv('DATABASE_URL'));
if (
  process.env.NODE_ENV === 'production' ||
  !['localhost', '127.0.0.1'].includes(configured.hostname) ||
  configured.port !== '55432'
) {
  throw new Error(
    'Security tests require the repository loopback development PostgreSQL on port 55432.',
  );
}
const prefix = `rbac_security_${Date.now()}_${process.pid}`;
const created = [];
const directory = 'packages/database/prisma/migrations';
const allMigrations = readdirSync(directory)
  .filter((name) => /^\d/.test(name))
  .sort();
const boundary = allMigrations.indexOf('20261016170000_security_atomicity');
if (boundary < 0) throw new Error('Security migration missing');
const migrations = allMigrations.slice(0, boundary);
const remediation = allMigrations.slice(boundary);
if (
  remediation.join(',') !==
  '20261016170000_security_atomicity,20261016171000_invitation_origin,20261019120000_campaigns_rbac_003,20261020110000_rbac_007_emergency_stop'
)
  throw new Error('Review migration rehearsal when adding a later migration.');
function psql(database, sql, expectFailure = false) {
  const result = spawnSync(
    'docker',
    [
      'exec',
      '-i',
      'truevine-postgres',
      'psql',
      '-X',
      '-v',
      'ON_ERROR_STOP=1',
      '-U',
      'truevine',
      '-d',
      database,
      '-tAc',
      sql,
    ],
    { encoding: 'utf8' },
  );
  if (result.error) throw result.error;
  if (!expectFailure && result.status !== 0) throw new Error(result.stderr);
  return result;
}
function create(suffix, replayBase = true) {
  const name = `${prefix}_${suffix}`;
  psql('postgres', `CREATE DATABASE ${name}`);
  created.push(name);
  for (const migration of replayBase ? migrations : [])
    psql(name, readFileSync(join(directory, migration, 'migration.sql'), 'utf8'));
  return name;
}
function apply(name, expectFailure = false) {
  let result;
  for (const migration of remediation) {
    result = psql(
      name,
      readFileSync(join(directory, migration, 'migration.sql'), 'utf8'),
      expectFailure,
    );
    if (result.status !== 0) return result;
  }
  return result;
}
function seed(name, inconsistent) {
  const org = randomUUID(),
    owner = randomUUID(),
    other = randomUUID();
  psql(
    name,
    `INSERT INTO organizations(id,slug,name,updated_at) VALUES('${org}','fixture','Fixture',now());
    INSERT INTO users(id,email,password_hash,updated_at) VALUES('${owner}','owner@example.invalid','unusable',now()),('${other}','other@example.invalid','unusable',now());
    INSERT INTO memberships(organization_id,user_id,role,updated_at) VALUES('${org}','${owner}','OWNER',now())${inconsistent === 'owners' ? `,('${org}','${other}','OWNER',now())` : ''};
    INSERT INTO invitations(organization_id,id,email,role,token_hash,invited_by_user_id,expires_at,accepted_at,accepted_by_user_id)
      VALUES('${org}','${randomUUID()}','other@example.invalid','VIEWER','fixture-token-hash','${owner}',now()+interval '1 day',${inconsistent === 'identity' ? `now(),'${owner}'` : 'NULL,NULL'});`,
  );
}
function validateCleanup(name) {
  if (!name.startsWith(prefix + '_') || !/^rbac_security_\d+_\d+_[a-z]+$/.test(name))
    throw new Error('Refusing database cleanup outside this run.');
}

try {
  const empty = create('empty', baseline);
  if (!baseline) {
    const target = new URL(configured);
    target.pathname = '/' + empty;
    if (!process.env.npm_execpath) throw new Error('Use npm run test:security');
    execFileSync(process.execPath, [process.env.npm_execpath, 'run', 'prisma:migrate:deploy'], {
      env: { ...process.env, NODE_ENV: 'test', DATABASE_URL: target.toString() },
      stdio: 'inherit',
    });
  }
  if (!baseline) {
    process.stdout.write('PASS migration: empty database\n');
    const representative = create('representative');
    seed(representative);
    apply(representative);
    if (psql(representative, 'SELECT count(*) FROM memberships').stdout.trim() !== '1')
      throw new Error('Representative rows changed.');
    process.stdout.write('PASS migration: existing representative rows preserved\n');
    for (const failure of ['owners', 'identity', 'ownerless']) {
      const database = create(failure);
      if (failure === 'ownerless')
        psql(
          database,
          `INSERT INTO organizations(id,slug,name,updated_at) VALUES('${randomUUID()}','empty','Ownerless',now())`,
        );
      else seed(database, failure);
      const before = psql(database, 'SELECT count(*) FROM memberships').stdout;
      const result = apply(database, true);
      if (!result.status || !result.stderr.includes('RBAC-001 migration refused:'))
        throw new Error('Inconsistent migration must fail with actionable diagnostic.');
      if (
        psql(database, 'SELECT count(*) FROM memberships').stdout !== before ||
        psql(
          database,
          "SELECT count(*) FROM pg_indexes WHERE indexname='memberships_single_owner'",
        ).stdout.trim() !== '0'
      )
        throw new Error('Failed migration left partial changes.');
      process.stdout.write(`PASS migration: ${failure} rejected without rewriting rows\n`);
    }
  }
  const env = { ...process.env, NODE_ENV: 'test', DATABASE_URL: new URL(configured).toString() };
  const testUrl = new URL(env.DATABASE_URL);
  testUrl.pathname = '/' + empty;
  env.DATABASE_URL = testUrl.toString();
  env.SECURITY_TEST_DATABASE = empty;
  const npmCli = process.env.npm_execpath;
  if (!npmCli) throw new Error('Run through npm run test:security.');
  if (baseline) {
    const original = execFileSync(
      'git',
      ['show', '087b190141fff16fc93d403fb018aada3f167dac:apps/api/src/auth/prisma-stores.ts'],
      { encoding: 'utf8' },
    );
    writeFileSync(
      'apps/api/dist/auth/prisma-stores-baseline.js',
      ts.transpileModule(original, {
        compilerOptions: {
          module: ts.ModuleKind.ESNext,
          target: ts.ScriptTarget.ES2022,
          experimentalDecorators: true,
        },
      }).outputText,
    );
    env.SECURITY_BASELINE = '1';
  }
  execFileSync(
    process.execPath,
    baseline
      ? [npmCli, 'run', 'test:e2e', '--workspace', '@truevine/api', '--', 'store-races']
      : [npmCli, 'run', 'test:e2e'],
    { env, stdio: 'inherit' },
  );
} finally {
  for (const name of created.reverse()) {
    validateCleanup(name);

    psql('postgres', `DROP DATABASE ${name}`);
  }
}
