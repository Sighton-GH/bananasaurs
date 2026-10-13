import { describe, expect, it } from 'vitest';
import { ART, type ArtKey } from '@bananasaurs/core';
import { loadArt } from './art.js';

describe('loadArt', () => {
  it.each(Object.keys(ART) as ArtKey[])('loads %s as a PNG with its alt text', (key) => {
    const file = loadArt(key);
    expect(file.name).toBe(ART[key].file);
    expect(file.contentType).toBe('image/png');
    expect([...file.data.slice(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47]);
    expect(file.description).toBe(ART[key].alt);
    expect(file.data.length).toBeLessThan(80_000);
  });
  it('returns the same object on a second call (loaded once)', () => {
    expect(loadArt('saurThumb')).toBe(loadArt('saurThumb'));
  });
});
