import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ERROR_CATALOG, explainError } from './catalog.js';

/**
 * Every kebab-case `error: '<slug>'` literal in `packages/http/src` must have
 * a catalog entry (ADR 0078): a new route cannot ship an unexplained code
 * without failing the suite.
 */
const collectSlugs = (dir: string): Set<string> => {
  const slugs = new Set<string>();
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      for (const slug of collectSlugs(full)) slugs.add(slug);
    } else if (entry.isFile() && entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) {
      const text = readFileSync(full, 'utf8');
      for (const match of text.matchAll(/error: '([a-z0-9-]+)'/g)) {
        if (match[1] !== undefined) slugs.add(match[1]);
      }
    }
  }
  return slugs;
};

/**
 * Codes sent through a variable rather than a literal (`error: result.reason`
 * and friends): the slug scan above cannot see them, so they are pinned here.
 * Sourced from `LoginFailure` and `BootstrapFailure` (`packages/http/src/auth.ts`),
 * the `'no-key' | 'unsupported'` message match in `routes/assistant.ts`, and
 * `OpsSetAutomodRuleReadyOutcome['reason']` (`packages/core/src/ops/ports.ts`).
 */
const VARIABLE_CODES = [
  'invalid-credentials',
  'locked-out',
  'no-guild-access',
  'guild-required',
  'bad-token',
  'already-provisioned',
  'no-guild',
  'no-key',
  'unsupported',
  'not-observing',
] as const;

describe('ERROR_CATALOG covers every error slug', () => {
  it('has a non-empty title and explanation for each slug sent in packages/http/src', () => {
    const src = fileURLToPath(new URL('..', import.meta.url));
    const slugs = collectSlugs(src);
    expect(slugs.size).toBeGreaterThan(0);
    for (const slug of [...slugs].sort()) {
      const entry = ERROR_CATALOG[slug];
      expect(entry, `missing catalog entry for '${slug}'`).toBeDefined();
      expect(entry?.title.length ?? 0, `empty title for '${slug}'`).toBeGreaterThan(0);
      expect(entry?.explanation.length ?? 0, `empty explanation for '${slug}'`).toBeGreaterThan(0);
    }
  });

  it('uses the agreed account copy', () => {
    expect(ERROR_CATALOG['owner-protected']?.explanation).toBe(
      "The owner account can't be changed.",
    );
    expect(ERROR_CATALOG['owner-only']?.title).toBe('Only the owner can do that');
    expect(ERROR_CATALOG['owner-only']?.explanation).toBe(
      "This setting belongs to the bot's owner account.",
    );
    expect(ERROR_CATALOG['weak-password']?.explanation).toBe('Use at least 12 characters.');
    expect(ERROR_CATALOG['username-taken']?.explanation).toBe('That username is already in use.');
    expect(ERROR_CATALOG['not-revealable']?.explanation).toBe(
      "This password can't be shown. Set a new one instead.",
    );
  });

  it('answers an unknown code with the generic entry', () => {
    expect(explainError('no-such-code')).toEqual({
      title: 'The request failed',
      explanation: 'Bananasaurs refused the request (no-such-code).',
    });
  });

  it('has an entry for every variable-sent code', () => {
    for (const code of VARIABLE_CODES) {
      const entry = ERROR_CATALOG[code];
      expect(entry, `missing catalog entry for '${code}'`).toBeDefined();
      expect(entry?.title.length ?? 0, `empty title for '${code}'`).toBeGreaterThan(0);
      expect(entry?.explanation.length ?? 0, `empty explanation for '${code}'`).toBeGreaterThan(0);
    }
  });
});
