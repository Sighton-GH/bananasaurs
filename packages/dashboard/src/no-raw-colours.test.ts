import { describe, expect, it } from 'vitest';

const files = import.meta.glob<string>('./**/*.tsx', {
  query: '?raw',
  import: 'default',
  eager: true,
});

const PALETTE =
  /\b(?:text|bg|border|ring|outline|from|to|via|fill|stroke|decoration|divide|placeholder)-(?:slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-\d{2,3}\b/g;
const HEX = /#[0-9a-fA-F]{6}\b/g;

describe('no raw colours in components (docs/28 §8, ADR 0142)', () => {
  it.each(Object.keys(files).filter((f) => !f.endsWith('.test.tsx')))(
    '%s uses tokens only',
    (file) => {
      const src = files[file]!;
      expect(src.match(PALETTE) ?? []).toEqual([]);
      expect(src.match(HEX) ?? []).toEqual([]);
    },
  );
});
