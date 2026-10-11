import { describe, expect, it } from 'vitest';
import { extractPingPhrases, matchPingNames, namedIn, replacePingTokens } from './reply-pings.js';

describe('reply-ping text helpers (ADR 0145)', () => {
  it('gives each @ outside code its 1–4 word phrases, longest first, and skips mass mentions', () => {
    expect(extractPingPhrases('hi @Sam L and @Car Team A')).toEqual([
      ['Sam L and', 'Sam L', 'Sam'],
      ['Car Team A', 'Car Team', 'Car'],
    ]);
    expect(extractPingPhrases('`@Sam L` and ```\n@Sam L\n```')).toEqual([]);
    expect(extractPingPhrases('@everyone and @HERE ping nobody')).toEqual([]);
    expect(extractPingPhrases('thanks @Sam L.')).toEqual([['Sam L', 'Sam']]);
  });
  it('matches the longest phrase that is exactly a candidate name, case-insensitively, deduped', () => {
    const candidates = [
      { id: '1', name: 'Sam L' },
      { id: '2', name: 'Car Team A' },
    ];
    expect(
      matchPingNames([['sam l and', 'sam l', 'sam'], ['Sammy'], ['Sam L']], candidates),
    ).toEqual(['1']);
  });
  it('matches nothing when two candidates share the name (ambiguous, ping neither)', () => {
    const candidates = [
      { id: '1', name: 'Sam L' },
      { id: '2', name: 'Sam L' },
      { id: '3', name: 'Alex P' },
    ];
    expect(matchPingNames([['sam l'], ['Alex P']], candidates)).toEqual(['3']);
  });
  it('namedIn finds whole names only', () => {
    expect(namedIn('please remind Sam L at 5', 'Sam L')).toBe(true);
    expect(namedIn('please remind Sam Lee at 5', 'Sam L')).toBe(false);
    expect(namedIn('ask alex p', 'Alex P')).toBe(true);
  });
  it('replaces only in prose, leaving code spans byte-identical', () => {
    const out = replacePingTokens('ping @Sam L and `@Sam L`', new Map([['Sam L', '<@1>']]));
    expect(out).toBe('ping <@1> and `@Sam L`');
  });
});
