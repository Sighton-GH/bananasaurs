/**
 * Text helpers for cards. **Truncate raw text first, then escape it** —
 * escaping adds characters, and cutting an escaped string can leave a
 * dangling backslash.
 */

const INLINE_MARKDOWN = /([\\*_~`|[\]])/g;
/** Heading, quote and bullet markers, also when indented (Discord renders nested lists). */
const LINE_START_BLOCK = /^([ \t]*)([#>-])/gm;
/** The delimiter of a numbered list item, also when indented: `1.` or `1)`. */
const LINE_START_NUMBER = /^([ \t]*\d+)([.)])/gm;

/** Neutralise Markdown and mention syntax in text a member or operator typed. Keeps newlines. */
export const escapeText = (raw: string): string =>
  raw
    .replace(/\r\n?/g, '\n')
    .replace(INLINE_MARKDOWN, '\\$1')
    .replace(LINE_START_BLOCK, '$1\\$2')
    .replace(LINE_START_NUMBER, '$1\\$2')
    .replace(/@/g, '@​')
    .replace(/</g, '<​');

/** `escapeText` for a single line: every run of whitespace becomes one space. */
export const escapeInline = (raw: string): string => escapeText(raw.replace(/\s+/g, ' ').trim());

const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

/**
 * The longest prefix of `raw` that is at most `max` UTF-16 units and ends on a
 * grapheme boundary, so a surrogate pair, a combining mark or a ZWJ emoji is
 * never split. Discord counts UTF-16 units, as `String.length` does.
 */
export const cutUnits = (raw: string, max: number): string => {
  if (raw.length <= max) return raw;
  let end = 0;
  for (const { segment, index } of segmenter.segment(raw)) {
    const next = index + segment.length;
    if (next > max) break;
    end = next;
  }
  return raw.slice(0, end);
};

/**
 * At most `max` UTF-16 units, ending in `…` when cut, never splitting a
 * grapheme. `max` must be a non-negative integer; 0 gives the empty string.
 */
export const truncate = (raw: string, max: number): string => {
  if (!Number.isInteger(max) || max < 0)
    throw new RangeError('truncate: max must be a non-negative integer');
  if (raw.length <= max) return raw;
  if (max === 0) return '';
  return `${cutUnits(raw, max - 1).trimEnd()}…`;
};

/**
 * `maxLines` content lines, then a line holding only `…` when the text was
 * longer (so a cut result has `maxLines + 1` lines). Text that fits is
 * returned as it came; a cut result uses `\n` line breaks. With 0 the result
 * is just `…`.
 */
export const clampLines = (raw: string, maxLines: number): string => {
  const lines = raw.split(/\r\n|\r|\n/);
  if (lines.length <= maxLines) return raw;
  return maxLines <= 0 ? '…' : `${lines.slice(0, maxLines).join('\n')}\n…`;
};

export type TimestampStyle = 't' | 'T' | 'd' | 'D' | 'f' | 'F' | 'R';
/** A Discord timestamp: each reader sees it in their own time zone. */
export const ts = (ms: number, style: TimestampStyle = 'f'): string =>
  `<t:${Math.floor(ms / 1000)}:${style}>`;

export const mentionUser = (id: string): string => `<@${id}>`;
export const mentionRole = (id: string): string => `<@&${id}>`;
export const mentionChannel = (id: string): string => `<#${id}>`;
export const subtext = (line: string): string => `-# ${line}`;
export const jumpUrl = (guildId: string, channelId: string, messageId: string): string =>
  `https://discord.com/channels/${guildId}/${channelId}/${messageId}`;
