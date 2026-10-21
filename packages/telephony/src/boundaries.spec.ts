import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * Package-boundary guards.
 *
 * These assert the architectural rules that a type checker cannot: that no
 * source file reaches for a provider SDK, and that nothing in the pure domain
 * package depends on the telephony package (AGENTS.md 2). They read the source
 * tree rather than the built output so a violation is caught before build.
 */

/** Walks a directory and returns the paths of every `.ts` file, excluding tests. */
function sourceFiles(root: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(root)) {
    const full = join(root, entry);
    if (statSync(full).isDirectory()) {
      out.push(...sourceFiles(full));
    } else if (full.endsWith('.ts') && !full.endsWith('.spec.ts')) {
      out.push(full);
    }
  }
  return out;
}

const REPO_ROOT = new URL('../../..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const DOMAIN_SRC = join(REPO_ROOT, 'packages/domain/src');
const TELEPHONY_SRC = join(REPO_ROOT, 'packages/telephony/src');

/** A crude import extractor: enough to catch the boundary violations we enforce. */
function importedSpecifiers(source: string): string[] {
  const specifiers: string[] = [];
  const patterns = [
    /from\s+['"]([^'"]+)['"]/g,
    /import\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    /require\(\s*['"]([^'"]+)['"]\s*\)/g,
  ];
  for (const pattern of patterns) {
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(source)) !== null) {
      if (match[1]) specifiers.push(match[1]);
    }
  }
  return specifiers;
}

const KNOWN_PROVIDER_SDKS = [
  'africastalking',
  "africa's talking",
  'africas-talking',
  'africastalking-js',
  'twilio',
];

describe('package boundaries — pure domain', () => {
  const files = sourceFiles(DOMAIN_SRC);

  it('has source files to check', () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it('never imports a telephony package (domain must not depend on adapters)', () => {
    for (const file of files) {
      const specifiers = importedSpecifiers(readFileSync(file, 'utf8'));
      for (const specifier of specifiers) {
        expect(specifier.startsWith('@truevine/telephony')).toBe(false);
      }
    }
  });

  it('never imports anything from apps/*', () => {
    for (const file of files) {
      const specifiers = importedSpecifiers(readFileSync(file, 'utf8'));
      for (const specifier of specifiers) {
        expect(specifier.startsWith('apps/')).toBe(false);
        expect(specifier.includes('/apps/')).toBe(false);
      }
    }
  });

  it('never imports a provider SDK', () => {
    for (const file of files) {
      const specifiers = importedSpecifiers(readFileSync(file, 'utf8')).map((s) => s.toLowerCase());
      for (const sdk of KNOWN_PROVIDER_SDKS) {
        expect(specifiers.some((specifier) => specifier.includes(sdk))).toBe(false);
      }
    }
  });
});

describe('package boundaries — telephony', () => {
  const files = sourceFiles(TELEPHONY_SRC);

  it('has source files to check', () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it('never imports a provider SDK outside an adapter directory', () => {
    for (const file of files) {
      const specifiers = importedSpecifiers(readFileSync(file, 'utf8')).map((s) => s.toLowerCase());
      for (const sdk of KNOWN_PROVIDER_SDKS) {
        if (specifiers.some((specifier) => specifier.includes(sdk))) {
          // Any future SDK usage must live under src/adapters/.
          expect(file.replace(/\\/g, '/')).toMatch(/\/src\/adapters\//);
        }
      }
    }
  });

  it('never imports anything from apps/*', () => {
    for (const file of files) {
      const specifiers = importedSpecifiers(readFileSync(file, 'utf8'));
      for (const specifier of specifiers) {
        expect(specifier.startsWith('apps/')).toBe(false);
        expect(specifier.includes('/apps/')).toBe(false);
      }
    }
  });
});
