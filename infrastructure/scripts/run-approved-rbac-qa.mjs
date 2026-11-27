import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { createDatabaseClient } from '@truevine/database';
import { loadEnvFiles, requireEnv } from '@truevine/shared';
import { tenantIsolationSpecs, runQaSpecs } from './run-tenant-isolation-qa.mjs';

const name = 'truevine_rbac_qa_20261120_031000_4f92';
const mode = '20261120_031000_4f92';
const host = '127.0.0.1';
const port = '55432';
const digest = '904b7c6a30cba331cf88977d6042f04b65005fe25cbf571552e5ff7b2f3c9762';
const prisma = resolve('packages/database/prisma');
const migrations = join(prisma, 'migrations');
const hash = (value) => createHash('sha256').update(value).digest('hex');

function reviewedMigrations() {
  const files = readdirSync(migrations, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()
    .map((directory) => ({
      directory,
      contents: readFileSync(join(migrations, directory, 'migration.sql'), 'utf8').replace(
        /\r\n/g,
        '\n',
      ),
    }));
  const manifest =
    files.map((file) => file.directory + ' ' + hash(file.contents)).join('\n') + '\n';
  if (files.length !== 23 || hash(manifest) !== digest)
    throw new Error('Migration sequence differs from the reviewed fingerprint.');
  return files;
}

function run(executable, args, options = {}) {
  const result = spawnSync(executable, args, options);
  if (result.error || result.status !== 0) throw new Error('Approved QA subprocess failed.');
  return result.stdout?.trim();
}

function assertContainer() {
  const [container] = JSON.parse(
    run('docker', ['--context', 'desktop-linux', 'inspect', 'truevine-postgres'], {
      encoding: 'utf8',
    }),
  );
  const bindings = container?.NetworkSettings?.Ports?.['5432/tcp'];
  if (
    container?.Name !== '/truevine-postgres' ||
    container?.State?.Health?.Status !== 'healthy' ||
    bindings?.length !== 1 ||
    bindings[0].HostIp !== host ||
    bindings[0].HostPort !== port ||
    !container.Mounts?.some(
      (mount) =>
        mount.Name === 'truevine-postgres-data' && mount.Destination === '/var/lib/postgresql',
    )
  ) {
    throw new Error('QA container, volume or published endpoint does not match approval.');
  }
}

function targetUrl() {
  const environment = process.env.NODE_ENV;
  if (environment && !['development', 'test'].includes(environment))
    throw new Error('QA refuses a deployed environment.');
  const url = new URL(requireEnv('DATABASE_URL'));
  if (
    !['postgres:', 'postgresql:'].includes(url.protocol) ||
    ![host, 'localhost'].includes(url.hostname) ||
    url.port !== port ||
    url.hash ||
    [...url.searchParams].some(([key, value]) => key !== 'schema' || value !== 'public')
  ) {
    throw new Error('Local credential source does not match the approved loopback endpoint.');
  }
  url.hostname = host;
  url.pathname = '/' + name;
  url.search = '';
  return url.toString();
}

async function verify(target, files, empty) {
  const client = createDatabaseClient(target, { log: [] });
  try {
    await client.$transaction(async (tx) => {
      await tx.$executeRaw`SET TRANSACTION READ ONLY`;
      const [identity] =
        await tx.$queryRaw`SELECT current_database() AS name, inet_server_port() AS port`;
      if (identity?.name !== name || identity.port !== 5432)
        throw new Error('Connected QA database identity mismatch.');
      if (empty) {
        const [schema] = await tx.$queryRaw`SELECT EXISTS (
          SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public'
        ) AS occupied`;
        if (schema?.occupied !== false)
          throw new Error('QA migration requires an empty public schema.');
        return;
      }
      const rows =
        await tx.$queryRaw`SELECT migration_name, checksum, finished_at IS NOT NULL AS finished,
        rolled_back_at IS NOT NULL AS rolled_back FROM public._prisma_migrations ORDER BY migration_name`;
      if (
        rows.length !== files.length ||
        files.some(
          (file, index) =>
            rows[index].migration_name !== file.directory ||
            rows[index].checksum !== hash(file.contents) ||
            !rows[index].finished ||
            rows[index].rolled_back,
        )
      )
        throw new Error('QA migration ledger differs from the reviewed sequence.');
    });
  } finally {
    await client.$disconnect();
  }
}

function migrate(target, files) {
  const snapshot = mkdtempSync(resolve('packages/database/.rbac-qa-'));
  const paths = [];
  const write = (path, contents) => {
    writeFileSync(path, contents, { flag: 'wx' });
    paths.push(path);
  };
  const dirs = [];
  const directory = (path) => {
    mkdirSync(path);
    dirs.unshift(path);
  };
  try {
    write(join(snapshot, 'schema.prisma'), readFileSync(join(prisma, 'schema.prisma')));
    const config = join(snapshot, 'prisma.config.mjs');
    write(
      config,
      "import { defineConfig } from 'prisma/config';\nexport default defineConfig({ schema: 'schema.prisma', migrations: { path: 'migrations' }, datasource: { url: process.env.DATABASE_URL } });\n",
    );
    directory(join(snapshot, 'migrations'));
    write(join(snapshot, 'migrations', 'migration_lock.toml'), 'provider = "postgresql"\n');
    for (const file of files) {
      const folder = join(snapshot, 'migrations', file.directory);
      directory(folder);
      write(join(folder, 'migration.sql'), file.contents);
    }
    run(
      process.execPath,
      [resolve('node_modules/prisma/build/index.js'), 'migrate', 'deploy', '--config', config],
      { stdio: 'inherit', env: { ...process.env, DATABASE_URL: target } },
    );
  } finally {
    for (const path of paths) unlinkSync(path);
    for (const path of [...dirs, snapshot]) rmdirSync(path);
  }
}

export async function runApprovedQa(stage, approval) {
  if (
    !['preflight', 'create', 'migrate', 'verify', 'test:rbac-012', 'test:rbac-013'].includes(stage)
  ) {
    throw new Error('Expected a supported QA stage.');
  }
  if (stage !== 'preflight' && approval !== digest) {
    throw new Error('Supply the explicitly approved migration fingerprint.');
  }
  const files = reviewedMigrations();
  assertContainer();
  loadEnvFiles();
  const target = targetUrl();
  if (stage === 'preflight') {
    process.stdout.write(
      'QA endpoint and 23-file migration fingerprint match. No database connection was made.\n',
    );
    return;
  }
  if (stage === 'create') {
    run(
      'docker',
      [
        '--context',
        'desktop-linux',
        'exec',
        'truevine-postgres',
        'createdb',
        '-w',
        '-U',
        'truevine',
        '--maintenance-db=postgres',
        '--template=template0',
        name,
      ],
      { stdio: 'inherit' },
    );
    return;
  }
  await verify(target, files, stage === 'migrate');
  if (stage === 'migrate') {
    migrate(target, files);
    await verify(target, files, false);
  }
  if (stage === 'test:rbac-012') runQaSpecs(target, mode, tenantIsolationSpecs);
  if (stage === 'test:rbac-013') runQaSpecs(target, mode, ['sensitive-audit.e2e-spec.ts']);
  process.stdout.write('Approved QA stage completed: ' + stage + '\n');
}
