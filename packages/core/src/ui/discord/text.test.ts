import { describe, expect, it } from 'vitest';
import {
  clampLines,
  escapeInline,
  escapeText,
  jumpUrl,
  mentionChannel,
  mentionRole,
  mentionUser,
  subtext,
  truncate,
  ts,
} from './text.js';

describe('escapeText', () => {
  it('neutralises mentions so they can never ping or render', () => {
    expect(escapeText('@everyone hi')).toBe('@​everyone hi');
    expect(escapeText('<@&123456789012345678>')).toBe('<​@​&123456789012345678>');
  });

  it('escapes inline Markdown characters', () => {
    expect(escapeText('**bold** _it_ ~x~ `c` |s|')).toBe(
      '\\*\\*bold\\*\\* \\_it\\_ \\~x\\~ \\`c\\` \\|s\\|',
    );
  });

  it('escapes masked-link brackets but not parentheses', () => {
    expect(escapeText('[a](https://x.example)')).toBe('\\[a\\](https://x.example)');
  });

  it('escapes block markers only at the start of a line', () => {
    expect(escapeText('# h\n> q\n- l\n-# s\nmid # and > and -')).toBe(
      '\\# h\n\\> q\n\\- l\n\\-# s\nmid # and > and -',
    );
  });

  it('normalises CRLF line endings', () => {
    expect(escapeText('a\r\nb\rc')).toBe('a\nb\nc');
  });
});

describe('escapeInline', () => {
  it('collapses all whitespace, including newlines, to single spaces', () => {
    expect(escapeInline('  a\n\nb\t c  ')).toBe('a b c');
  });
  it('escapes like escapeText after collapsing', () => {
    expect(escapeInline('# title')).toBe('\\# title');
  });
});

describe('truncate and clampLines', () => {
  it('leaves short text alone and cuts long text with an ellipsis within the limit', () => {
    expect(truncate('abc', 5)).toBe('abc');
    const cut = truncate('abcdefghij', 5);
    expect(cut).toBe('abcd…');
    expect(cut.length).toBe(5);
  });
  it('keeps at most n lines and marks the cut', () => {
    expect(clampLines('1\n2\n3', 3)).toBe('1\n2\n3');
    expect(clampLines('1\n2\n3\n4', 2)).toBe('1\n2\n…');
  });
});

describe('Discord syntax helpers', () => {
  it('formats timestamps in seconds with a style', () => {
    expect(ts(1_700_000_000_999, 'R')).toBe('<t:1700000000:R>');
    expect(ts(1_700_000_000_000)).toBe('<t:1700000000:f>');
  });
  it('formats mentions, subtext and jump links', () => {
    expect(mentionUser('1')).toBe('<@1>');
    expect(mentionRole('2')).toBe('<@&2>');
    expect(mentionChannel('3')).toBe('<#3>');
    expect(subtext('x')).toBe('-# x');
    expect(jumpUrl('g', 'c', 'm')).toBe('https://discord.com/channels/g/c/m');
  });
});

describe('truncate is safe on surrogate pairs and combining marks (fix round 1)', () => {
  it('never splits an emoji surrogate pair and stays within the limit', () => {
    const raw = '😀😀😀😀';
    for (let max = 1; max < raw.length; max += 1) {
      const cut = truncate(raw, max);
      expect(cut.length).toBeLessThanOrEqual(max);
      expect(cut).not.toMatch(
        /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/,
      );
    }
    expect(truncate('😀😀😀😀', 5)).toBe('😀😀…');
    expect(truncate('😀😀😀😀', 4)).toBe('😀…');
  });

  it('keeps a base letter with its combining mark and a ZWJ emoji whole', () => {
    const accented = 'e\u0301e\u0301e\u0301e\u0301'; // four e + acute, 8 units
    expect(truncate(accented, 5)).toBe('e\u0301e\u0301…');
    const family = '👨‍👩‍👧‍👦'; // one grapheme, 11 units
    expect(truncate(`${family}${family}`, 15)).toBe(`${family}…`);
    expect(truncate(`${family}${family}`, 5)).toBe('…');
  });

  it('returns the empty string for 0 and a lone ellipsis for 1', () => {
    expect(truncate('abc', 0)).toBe('');
    expect(truncate('', 0)).toBe('');
    expect(truncate('abc', 1)).toBe('…');
    expect(truncate('a', 1)).toBe('a');
  });

  it('throws RangeError for a negative, non-finite or fractional max', () => {
    for (const bad of [-1, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, 1.5]) {
      expect(() => truncate('abc', bad)).toThrow(RangeError);
    }
  });
});

describe('escapeText neutralises list syntax (fix round 1)', () => {
  it('escapes indented bullet and quote and heading markers, keeping the indent', () => {
    expect(escapeText('  - nested')).toBe('  \\- nested');
    expect(escapeText('\t- tab')).toBe('\t\\- tab');
    expect(escapeText('   # h\n  > q')).toBe('   \\# h\n  \\> q');
  });

  it('escapes the delimiter of numbered list items', () => {
    expect(escapeText('1. ordered')).toBe('1\\. ordered');
    expect(escapeText('  12) ordered')).toBe('  12\\) ordered');
    expect(escapeText('a\n3. b')).toBe('a\n3\\. b');
  });

  it('leaves mid-line digits, dashes and dots alone', () => {
    expect(escapeText('see 1. and a - b 2) c')).toBe('see 1. and a - b 2) c');
    expect(escapeText('v1.2 is out')).toBe('v1.2 is out');
  });

  it('survives hostile multi-line text', () => {
    const hostile = '@everyone\n  - <@&123456789012345678>\n1. **x**\n  > [a](https://x.example)';
    expect(escapeText(hostile)).toBe(
      '@​everyone\n  \\- <​@​&123456789012345678>\n1\\. \\*\\*x\\*\\*\n  \\> \\[a\\](https://x.example)',
    );
  });
});

describe('clampLines edge cases (fix round 1)', () => {
  it('keeps N content lines then a line holding only the cut marker', () => {
    expect(clampLines('1\n2\n3\n4', 2)).toBe('1\n2\n…');
    expect(clampLines('1\n2\n3\n4', 1)).toBe('1\n…');
  });
  it('with 0 lines returns just the cut marker', () => {
    expect(clampLines('1\n2', 0)).toBe('…');
  });
  it('leaves uncut text unchanged and normalises CRLF only when it cuts', () => {
    expect(clampLines('1\r\n2', 2)).toBe('1\r\n2');
    expect(clampLines('1\r\n2\r\n3', 2)).toBe('1\n2\n…');
    expect(clampLines('1\r2\r3', 2)).toBe('1\n2\n…');
  });
});
