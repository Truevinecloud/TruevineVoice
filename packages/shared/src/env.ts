/**
 * Environment loading and access.
 *
 * Truevine Voice keeps a single `.env` file at the repository root during
 * development, while npm runs each workspace with its own directory as the
 * working directory. `loadEnvFiles()` therefore walks up from the current
 * working directory to find that root `.env`.
 *
 * Real values never belong in the repository. `.env` is gitignored; only safe
 * placeholders live in `.env.example`.
 */

import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

// `dotenv` is CommonJS-only, so it is consumed through its default export. A
// named import would rely on CommonJS named-export detection, which is not
// guaranteed for every loader.
import dotenv from 'dotenv';

export interface LoadEnvOptions {
  /** Directory the upward search starts from. Defaults to `process.cwd()`. */
  readonly cwd?: string;
  /** Maximum number of parent directories to inspect. */
  readonly maxDepth?: number;
}

const DEFAULT_MAX_DEPTH = 5;

/**
 * Loads the nearest `.env` file found by walking up from `cwd`.
 *
 * Values already present in `process.env` are never overwritten, so
 * real environment variables always win over the file.
 *
 * @returns the absolute path of the file that was loaded, or `null` if none was found.
 */
export function loadEnvFiles(options: LoadEnvOptions = {}): string | null {
  const cwd = options.cwd ?? process.cwd();
  const maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH;

  let directory = resolve(cwd);
  for (let depth = 0; depth <= maxDepth; depth += 1) {
    const candidate = resolve(directory, '.env');
    if (existsSync(candidate)) {
      // `quiet` suppresses dotenv's "injected env (n)" banner: it is written to
      // stderr by an unrelated dependency and would otherwise be mistaken for
      // application output on every boot.
      dotenv.config({ path: candidate, override: false, quiet: true });
      return candidate;
    }
    const parent = dirname(directory);
    if (parent === directory) {
      break;
    }
    directory = parent;
  }

  return null;
}

/**
 * Reads a required environment variable, failing fast with an actionable message.
 *
 * @throws Error when the variable is missing or blank.
 */
export function requireEnv(name: string, env: NodeJS.ProcessEnv = process.env): string {
  const value = env[name]?.trim();
  if (value === undefined || value.length === 0) {
    throw new Error(
      `Missing required environment variable "${name}". ` +
        'Copy .env.example to .env at the repository root and set it.',
    );
  }
  return value;
}

/** Reads an optional environment variable, falling back to `fallback` when blank. */
export function optionalEnv(
  name: string,
  fallback: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const value = env[name]?.trim();
  return value === undefined || value.length === 0 ? fallback : value;
}

/**
 * Reads an optional integer environment variable.
 *
 * @throws Error when the value is present but not a positive integer.
 */
export function optionalIntEnv(
  name: string,
  fallback: number,
  env: NodeJS.ProcessEnv = process.env,
): number {
  const raw = env[name]?.trim();
  if (raw === undefined || raw.length === 0) {
    return fallback;
  }
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(
      `Environment variable "${name}" must be a positive integer, received "${raw}".`,
    );
  }
  return parsed;
}
