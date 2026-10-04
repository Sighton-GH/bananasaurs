import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * ADR 0121 replaced automod's staged rollout (per-rule modes, an observe
 * window, readiness, sign-off, a fixture corpus and dry-run replay) with one
 * Off / Watch / On switch, and the owner asked for no remnants of the testing
 * stage. This guard keeps its vocabulary from coming back in code a person
 * reads or a user sees.
 *
 * Comments are stripped before matching: ADRs and history may still name the
 * old design, and a comment explaining why something was removed is not a
 * remnant. Test files and the two test-support modules are skipped — their
 * "fixture" means a test fixture, not automod's corpus.
 */

// Lives in `packages/http` rather than the dashboard: the dashboard's lint
// bans `node:` imports even in tests (it builds to static assets), and this
// guard has to read source files.
const REPO_ROOT = path.resolve(import.meta.dirname, '../../..');

const SCANNED = [
  'packages/dashboard/src',
  'packages/core/src/ops',
  'packages/core/src/automod',
  'packages/http/src/routes',
  'packages/http/src/errors',
  'packages/mcp/src/tools',
  'apps/daemon/src/ops',
  'apps/daemon/src/runtime',
  'apps/daemon/src/automod',
  'packages/storage/src',
  'packages/mcp/src/resources',
];

// `observe-only` is excluded: it names the read-only process mode
// (`BANANASAURS_READONLY`, `storage/src/write.ts`), not automod.
const FORBIDDEN =
  /observe window|observe floor|observing|\bobserves?\b(?!-only)|rule modes?\b|cutover|cut over|sign-off|signoff|signed off|legacy ref|legacy-ref|legacyRuleRef|fixture|enforce mode|enforceSignedOff|cutoverState|observeStartedAt|automodTestingMode|OBSERVE_FLOOR/i;

const SKIPPED_NAMES = new Set(['test-fixtures.ts', 'test-support.ts', 'no-staged-rollout.test.ts']);

const isScannedSource = (file: string): boolean =>
  /\.tsx?$/.test(file) && !/\.test\.tsx?$/.test(file) && !SKIPPED_NAMES.has(path.basename(file));

/**
 * Blanks `//` and `/* *\/` comments while keeping line breaks, so a hit
 * still reports its real line number. String and template literals are
 * copied through untouched — a `//` inside a URL is not a comment, and a
 * forbidden word inside a string is exactly what this guard is for.
 */
const stripComments = (source: string): string => {
  let out = '';
  let i = 0;
  while (i < source.length) {
    const ch = source[i]!;
    const next = source[i + 1];
    if (ch === '/' && next === '/') {
      while (i < source.length && source[i] !== '\n') i += 1;
    } else if (ch === '/' && next === '*') {
      i += 2;
      while (i < source.length && !(source[i] === '*' && source[i + 1] === '/')) {
        if (source[i] === '\n') out += '\n';
        i += 1;
      }
      i += 2;
    } else if (ch === "'" || ch === '"' || ch === '`') {
      const quote = ch;
      out += ch;
      i += 1;
      while (i < source.length && source[i] !== quote) {
        if (source[i] === '\\') {
          out += source[i]! + (source[i + 1] ?? '');
          i += 2;
          continue;
        }
        out += source[i]!;
        i += 1;
      }
      if (i < source.length) out += source[i]!;
      i += 1;
    } else {
      out += ch;
      i += 1;
    }
  }
  return out;
};

const hitsIn = (relativeDir: string): string[] => {
  const dir = path.join(REPO_ROOT, relativeDir);
  const hits: string[] = [];
  for (const entry of fs.readdirSync(dir, { recursive: true, encoding: 'utf8' })) {
    const full = path.join(dir, entry);
    if (!isScannedSource(full) || !fs.statSync(full).isFile()) continue;
    const lines = stripComments(fs.readFileSync(full, 'utf8')).split('\n');
    lines.forEach((line, index) => {
      if (FORBIDDEN.test(line)) {
        hits.push(`${path.relative(REPO_ROOT, full)}:${String(index + 1)}: ${line.trim()}`);
      }
    });
  }
  return hits;
};

describe('no staged-rollout remnants (ADR 0121)', () => {
  it.each(SCANNED)('%s carries none of the staged rollout vocabulary', (dir) => {
    expect(hitsIn(dir)).toEqual([]);
  });

  it('strips comments but not strings', () => {
    const stripped = stripComments(
      'const a = \'cutover\'; // observing\n/* fixture */ const b = "http://x";',
    );
    expect(stripped).toContain("'cutover'");
    expect(stripped).not.toContain('observing');
    expect(stripped).not.toContain('fixture');
    expect(stripped).toContain('"http://x"');
    expect(stripped.split('\n')).toHaveLength(2);
  });
});
