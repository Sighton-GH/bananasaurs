import { describe, expect, it } from 'vitest';
import css from '../styles.css?raw';

const pages = import.meta.glob<string>('./*.tsx', {
  query: '?raw',
  import: 'default',
  eager: true,
});

const defined = (prefix: string): Set<string> =>
  new Set([...css.matchAll(new RegExp(`--${prefix}-([a-z0-9]+)\\s*:`, 'g'))].map((m) => m[1]!));
const SIZES = defined('text');
const RADII = new Set([...defined('radius'), 'full', 'none']);

// Unit 7c's own pages. A jsdom test cannot see Tailwind output, so a typo such as
// `text-smallall` would otherwise pass silently and emit no CSS.
const OWNED = [
  'overview',
  'overview-pulse',
  'jobs',
  'audit',
  'backups',
  'accounts',
  'account-new',
  'docs',
  'login',
  'not-found',
  'panels',
];

describe('7c page class tokens', () => {
  it('every size and radius class in the owned pages is a defined theme token', () => {
    const bad: string[] = [];
    for (const name of OWNED) {
      const source = pages[`./${name}.tsx`];
      expect(source, `${name}.tsx`).toBeTypeOf('string');
      if (source === undefined) continue;
      for (const m of source.matchAll(/(?<![\w-])text-([a-z0-9]+)(?![\w-])/g)) {
        const word = m[1]!;
        const sizeLike = /^(xs|sm|base|lg|xl|\dxl|small|body|title|section|caption|heading)/.test(
          word,
        );
        if (sizeLike && !SIZES.has(word)) bad.push(`${name}: text-${word}`);
      }
      for (const m of source.matchAll(/(?<![\w-])rounded-([a-z0-9]+)(?![\w-])/g)) {
        if (!RADII.has(m[1]!)) bad.push(`${name}: rounded-${m[1]!}`);
      }
    }
    expect(bad).toEqual([]);
  });

  it('the detector fails on the typo it exists to catch', () => {
    expect(SIZES.has('smallall')).toBe(false);
    expect(SIZES.has('small')).toBe(true);
  });
});
