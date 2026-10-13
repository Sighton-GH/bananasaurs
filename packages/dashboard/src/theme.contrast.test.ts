import { describe, expect, it } from 'vitest';
import css from './styles.css?raw';

/** Body text of the first block whose header matches. */
const blockBody = (header: RegExp): string => {
  const start = css.search(header);
  if (start < 0) throw new Error(`no block ${header}`);
  const open = css.indexOf('{', start);
  let depth = 0;
  let end = open;
  for (; end < css.length; end++) {
    if (css[end] === '{') depth++;
    if (css[end] === '}' && --depth === 0) break;
  }
  return css.slice(open + 1, end);
};

/** `--color-x: #rrggbb;` pairs inside the first block whose header matches. */
const block = (header: RegExp): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const m of blockBody(header).matchAll(/--color-([a-z0-9-]+):\s*(#[0-9a-f]{6})\s*;/gi))
    out[m[1]!] = m[2]!.toLowerCase();
  return out;
};

/** Every `--name: value;` declaration in the block, whatever its value type. */
const allProps = (header: RegExp): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const m of blockBody(header).matchAll(/(--[a-z0-9-]+):\s*([^;]+);/gi))
    out[m[1]!] = m[2]!.trim().replace(/\s+/g, ' ');
  return out;
};

const lum = (hex: string): number => {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  const f = (c: number) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  return 0.2126 * f(r!) + 0.7152 * f(g!) + 0.0722 * f(b!);
};
const ratio = (a: string, b: string): number => {
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
};

const LIGHT = block(/@theme\s*\{/);
const DARK = block(/:root\[data-theme='dark'\]\s*\{/);

const TEXT = 4.5;
const UI = 3;
const TONES = ['neutral', 'progress', 'hold', 'ok', 'danger'] as const;

const PAIRS: [fg: string, bg: string, min: number][] = [
  ['ink', 'canvas', TEXT],
  ['ink', 'panel', TEXT],
  ['ink', 'sunk', TEXT],
  ['ink-muted', 'canvas', TEXT],
  ['ink-muted', 'panel', TEXT],
  ['ink-muted', 'sunk', TEXT],
  ['ink-faint', 'panel', UI],
  ['line-strong', 'panel', UI],
  ['line-strong', 'canvas', UI],
  ['accent', 'panel', TEXT],
  ['accent', 'canvas', TEXT],
  ['accent-ink', 'accent', TEXT],
  ['accent', 'accent-bg', TEXT],
  ['danger', 'panel', TEXT],
  ['danger', 'canvas', TEXT],
  ['ok', 'panel', TEXT],
  ['hold-ink', 'hold', TEXT],
  ...TONES.flatMap((t): [string, string, number][] => [
    [`tone-${t}-ink`, `tone-${t}-bg`, TEXT],
    [`tone-${t}`, 'panel', UI],
    [`tone-${t}`, 'canvas', UI],
  ]),
];

describe.each([
  ['light', LIGHT],
  ['dark', DARK],
])('%s theme (ADR 0142 decision 1)', (_name, theme) => {
  it.each(PAIRS)('%s on %s ≥ %s:1', (fg, bg, min) => {
    expect(theme[fg], `--color-${fg} missing`).toBeDefined();
    expect(theme[bg], `--color-${bg} missing`).toBeDefined();
    expect(ratio(theme[fg]!, theme[bg]!)).toBeGreaterThanOrEqual(min);
  });
});

it('the dark media block and the data-theme block declare identical custom properties', () => {
  const media = allProps(/:root:not\(\[data-theme\]\)\s*\{/);
  const attr = allProps(/:root\[data-theme='dark'\]\s*\{/);
  // Guard against the parser matching nothing: non-color tokens must be seen.
  expect(Object.keys(attr)).toEqual(
    expect.arrayContaining([
      '--backdrop-glow-a',
      '--backdrop-glow-b',
      '--backdrop-art-opacity',
      '--shadow-float',
    ]),
  );
  expect(media).toEqual(attr);
});

it('dark redefines every light token', () => {
  expect(Object.keys(DARK).sort()).toEqual(Object.keys(LIGHT).sort());
});
