import { describe, expect, it } from 'vitest';
import { buildCatalog, loadEmojiCatalog, matchesQuery, withTone } from './emoji-data.js';

describe('emoji catalogue', () => {
  it('loads the whole Unicode set, grouped, with the keycaps and flags Discord accepts', async () => {
    const catalog = await loadEmojiCatalog();
    // The full set is ~1,900 base emoji; a trimmed list would be well under 1,000.
    expect(catalog.emoji.length).toBeGreaterThan(1800);
    expect(catalog.groups.map((g) => g.label)).toContain('Flags');
    const find = (label: string) => catalog.emoji.find((e) => e.label === label);
    expect(find('banana')?.unicode).toBe('🍌');
    expect(find('keycap: 1')?.unicode).toBe('1️⃣');
    expect(find('flag: Canada')).toBeDefined();
  });

  it('finds emoji by label or keyword, all words required', async () => {
    const catalog = await loadEmojiCatalog();
    const hits = (q: string) => catalog.emoji.filter((e) => matchesQuery(e, q)).map((e) => e.label);
    expect(hits('banana')).toContain('banana');
    expect(hits('thumbs up')).toContain('thumbs up');
    expect(hits('zzzznotanemoji')).toEqual([]);
  });

  it('keeps only single-tone skin variants and applies the chosen tone', async () => {
    const catalog = await loadEmojiCatalog();
    const wave = catalog.emoji.find((e) => e.label === 'waving hand');
    expect(wave).toBeDefined();
    if (wave === undefined) return;
    expect(withTone(wave, 0)).toBe('👋');
    expect(withTone(wave, 1)).toBe('👋🏻');
    expect(withTone(wave, 5)).toBe('👋🏿');
    const banana = catalog.emoji.find((e) => e.label === 'banana');
    // No skins: the default stays whatever tone is picked.
    expect(banana && withTone(banana, 3)).toBe('🍌');
  });

  it('puts emoji with no group in an Other group instead of dropping them', () => {
    const catalog = buildCatalog(
      [{ label: 'regional indicator A', unicode: '🇦' }],
      [{ order: 0, message: 'flags' }],
    );
    expect(catalog.emoji).toHaveLength(1);
    expect(catalog.groups.map((g) => g.label)).toEqual(['Flags', 'Other']);
  });
});
