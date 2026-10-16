/**
 * Command-line wrapper around `provisionOwner`.
 *
 * Everything testable lives in `provision-owner.mjs`. This file parses arguments,
 * enforces the production guard, and renders the result. Keeping the two apart is
 * what allows the provisioning logic to be tested against a real database with
 * no shell, no prompts and no `process.exit`.
 *
 * Usage:
 *   npm run provision:owner -- --email owner@example.com --organization-slug acme
 *
 * Required:
 *   --email                  the owner's address
 *   --organization-slug      1-63 chars, lowercase letters, digits and hyphens
 *
 * Optional:
 *   --organization-name      defaults to the slug
 *   --base-url               defaults to http://localhost:3000
 *   --activation-directory   defaults to .owner-activation under the repo root
 *
 * Refuses to run when NODE_ENV is production unless --confirm-production is also
 * given, because this script creates a credential that can take over a tenant.
 */

import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { loadEnvFiles, requireEnv } from '@truevine/shared';

import { defaultActivationDirectory, provisionOwner } from './provision-owner.mjs';

/** Parsed command-line arguments. */
function parseArguments(argv) {
  const parsed = {};

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];

    if (!argument.startsWith('--')) continue;

    const [name, inlineValue] = argument.slice(2).split('=', 2);
    const value = inlineValue ?? argv[++index];

    if (value === undefined) {
      throw new Error(`Option --${name} needs a value.`);
    }

    parsed[name] = value;
  }

  return parsed;
}

/** Writes a line to stdout. */
function say(line) {
  process.stdout.write(`${line}\n`);
}

/** Writes a line to stderr. */
function complain(line) {
  process.stderr.write(`${line}\n`);
}

/**
 * Refuses to provision against production without an explicit acknowledgement.
 *
 * The check is deliberately conservative: an unset `NODE_ENV` does not count as
 * "not production" when `DATABASE_URL` names a production host.
 */
function assertNotProduction(confirmed) {
  const environment = process.env['NODE_ENV'] ?? '';
  const databaseUrl = process.env['DATABASE_URL'] ?? '';

  const looksProduction =
    environment === 'production' ||
    /prod|production/i.test(databaseUrl) ||
    process.env['PROVISION_PRODUCTION'] === 'true';

  if (looksProduction && !confirmed) {
    complain('');
    complain('REFUSING TO RUN.');
    complain('');
    complain('This looks like a production environment, and this script creates a');
    complain('credential that can take over a tenant. Re-run with');
    complain('--confirm-production if that is genuinely what you intend.');
    complain('');
    process.exit(2);
  }
}

/** Removes a previous activation file once it has been used. */
function discardActivationFile(path) {
  try {
    rmSync(path, { force: true });
  } catch {
    // A leftover 0600 file expires on its own; failing here would be noise.
  }
}

async function main() {
  const argv = process.argv.slice(2);
  const options = parseArguments(argv);

  loadEnvFiles();

  if (options['help'] !== undefined) {
    say(
      [
        'Provision the first Organization Owner for a tenant.',
        '',
        '  --email <address>',
        '  --organization-slug <slug>',
        '  --organization-name <name>      defaults to the slug',
        '  --base-url <url>                defaults to http://localhost:3000',
        '  --activation-directory <path>   defaults to .owner-activation',
        '  --confirm-production            required in a production environment',
        '',
      ].join('\n'),
    );
    return;
  }

  assertNotProduction(options['confirm-production'] !== undefined);

  if (!options['email'] || !options['organization-slug']) {
    complain('Both --email and --organization-slug are required. Run with --help.');
    process.exit(2);
  }

  const databaseUrl = requireEnv('DATABASE_URL');
  const baseUrl = options['base-url'] ?? 'http://localhost:3000';
  const activationDirectory = resolve(
    options['activation-directory'] ?? defaultActivationDirectory(),
  );

  const outcome = await provisionOwner(
    {
      email: options['email'],
      organizationSlug: options['organization-slug'],
      organizationName: options['organization-name'],
      activationDirectory,
      applicationBaseUrl: baseUrl,
    },
    { databaseUrl },
  );

  if (!outcome.ok) {
    complain('');
    complain(`Refused: ${outcome.detail}`);
    complain(`  reason: ${outcome.reason}`);
    process.exit(1);
  }

  say('');
  say('First Organization Owner provisioned.');
  say('');
  say(`  Email:             ${options['email']}`);
  say(`  User id:           ${outcome.userId}`);
  say(`  Organization slug: ${outcome.organizationSlug}`);
  say(`  Organization id:   ${outcome.organizationId}`);
  say(
    `  Organization:      ${outcome.organizationCreated ? 'created' : 'joined (already existed, had no members)'}`,
  );
  say('');
  say('The account has NO usable password yet.');
  say('The single-use activation link is in a file readable only by you:');
  say('');
  say(`  ${outcome.activationFile}`);
  say('');
  say('Deliver that link to the owner over a channel you trust, then delete the file.');
  say(`It expires at ${outcome.activationExpiresAt.toISOString()}.`);
  say('');

  if (existsSync(join(activationDirectory, '.gitignore'))) {
    discardActivationFile(join(activationDirectory, '.gitignore'));
  }
}

// Only run when invoked directly, so importing this module from a test does not
// execute a script against whatever DATABASE_URL happens to be in the environment.
const invokedDirectly =
  process.argv[1] !== undefined && resolve(process.argv[1]).endsWith('provision-owner-cli.mjs');

if (invokedDirectly) {
  main().catch((error) => {
    complain('');
    complain('Provisioning failed.');
    complain(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}

export { main, parseArguments, assertNotProduction, readFileSync };
