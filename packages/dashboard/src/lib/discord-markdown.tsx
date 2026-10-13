import type { ReactNode } from 'react';

/**
 * The Discord Markdown subset the card preview shows (ADR 0140): **bold**,
 * *italic*, `code`, `> quote`, `-# subtext`, [label](url), Discord timestamps
 * and user / role / channel mentions as pills. Backslash escapes (what the
 * card renderer's `escapeText` emits) stay literal. Everything else is kept
 * as typed, and text is never parsed as HTML. Same approach as
 * `guide-markdown.tsx`: a small scanner, no parser dependency.
 */

export interface DiscordClock {
  readonly userNames?: Readonly<Record<string, string>>;
  readonly indicateExternalLinks?: boolean;
  /** The instant "now" for relative timestamps, in ms. */
  readonly now?: number;
  /** IANA zone for absolute timestamps; the browser's zone when omitted. */
  readonly timeZone?: string;
}

// Controls, spaces, zero-width and bidi marks, line separators, and the backslash:
// browsers read "/\host" as "//host", and none of these belong in a card link.
const hasUnsafeChar = (raw: string): boolean => {
  for (const ch of raw) {
    const c = ch.codePointAt(0)!;
    if (
      c <= 0x20 ||
      (c >= 0x7f && c <= 0x9f) ||
      c === 0xad ||
      c === 0x5c ||
      (c >= 0x200b && c <= 0x200f) ||
      (c >= 0x2028 && c <= 0x202e) ||
      (c >= 0x2060 && c <= 0x206f) ||
      c === 0xfeff
    )
      return true;
  }
  return false;
};

/** A normalised absolute http(s) address, or null for anything else. */
export const safeHttpUrl = (raw: string): string | null => {
  if (raw === '' || hasUnsafeChar(raw) || !/^https?:\/\//i.test(raw)) return null;
  try {
    const url = new URL(raw);
    if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.hostname === '') return null;
    return url.href;
  } catch {
    return null;
  }
};

const MAX_MS = 8.64e15;
const fmt = (clock: DiscordClock, options: Intl.DateTimeFormatOptions, ms: number): string =>
  new Intl.DateTimeFormat('en-US', {
    ...options,
    ...(clock.timeZone === undefined ? {} : { timeZone: clock.timeZone }),
  })
    .format(ms)
    // Newer ICU puts a narrow no-break space before AM/PM.
    .replace(/[\u202f\u00a0]/g, ' ');

const relative = (ms: number, now: number): string => {
  const diff = ms - now;
  const abs = Math.abs(diff) / 1000;
  const [value, unit]: [number, Intl.RelativeTimeFormatUnit] =
    abs < 60
      ? [Math.round(diff / 1000), 'second']
      : abs < 3600
        ? [Math.round(diff / 60_000), 'minute']
        : abs < 86_400
          ? [Math.round(diff / 3_600_000), 'hour']
          : abs < 30 * 86_400
            ? [Math.round(diff / 86_400_000), 'day']
            : abs < 365 * 86_400
              ? [Math.round(diff / (30 * 86_400_000)), 'month']
              : [Math.round(diff / (365 * 86_400_000)), 'year'];
  return new Intl.RelativeTimeFormat('en-US', { numeric: 'always' }).format(value, unit);
};

const STYLES = new Set(['t', 'T', 'd', 'D', 'f', 'F', 'R']);

/** Text for `<t:seconds:style>`, or null when the seconds or style are not valid. */
export const formatDiscordTimestamp = (
  seconds: number,
  style: string,
  clock: DiscordClock = {},
): string | null => {
  const ms = seconds * 1000;
  if (!Number.isFinite(ms) || Math.abs(ms) > MAX_MS || !STYLES.has(style)) return null;
  switch (style) {
    case 't':
      return fmt(clock, { timeStyle: 'short' }, ms);
    case 'T':
      return fmt(clock, { timeStyle: 'medium' }, ms);
    case 'd':
      return fmt(clock, { month: '2-digit', day: '2-digit', year: 'numeric' }, ms);
    case 'D':
      return fmt(clock, { dateStyle: 'long' }, ms);
    case 'F':
      return fmt(clock, { dateStyle: 'full', timeStyle: 'short' }, ms);
    case 'R':
      return relative(ms, clock.now ?? Date.now());
    default:
      return fmt(clock, { dateStyle: 'long', timeStyle: 'short' }, ms);
  }
};

const ESCAPABLE = /[!-/:-@[-`{-~]/;
const TOKEN = /^<(?:(@&|@!|@|#)(\d{17,20})|t:(-?\d{1,16})(?::([a-zA-Z]))?)>/;
const LINK_TARGET = /^\(((?:[^()\s]|\([^()\s]*\))+)\)/;

/** Index of the first unescaped `needle` at or after `from`, or -1. */
const findClose = (s: string, needle: string, from: number): number => {
  for (let j = from; j < s.length; j += 1) {
    if (s[j] === '\\') j += 1;
    else if (s.startsWith(needle, j)) return j;
  }
  return -1;
};

const parseInline = (s: string, clock: DiscordClock, allowLinks: boolean): ReactNode[] => {
  const out: ReactNode[] = [];
  let buffer = '';
  const flush = (): void => {
    if (buffer !== '') out.push(buffer);
    buffer = '';
  };
  const push = (node: ReactNode): void => {
    flush();
    out.push(node);
  };
  let i = 0;
  while (i < s.length) {
    const c = s[i]!;
    if (c === '\\' && i + 1 < s.length && ESCAPABLE.test(s[i + 1]!)) {
      buffer += s[i + 1];
      i += 2;
      continue;
    }
    if (c === '`') {
      const end = s.indexOf('`', i + 1);
      if (end > i + 1) {
        push(<code key={out.length}>{s.slice(i + 1, end)}</code>);
        i = end + 1;
        continue;
      }
    }
    if (c === '*' && s[i + 1] === '*') {
      const end = findClose(s, '**', i + 2);
      if (end > i + 2) {
        push(
          <strong key={out.length}>{parseInline(s.slice(i + 2, end), clock, allowLinks)}</strong>,
        );
        i = end + 2;
        continue;
      }
    } else if (c === '*' && s[i + 1] !== ' ' && s[i + 1] !== undefined) {
      const end = findClose(s, '*', i + 1);
      if (end > i + 1 && s[end - 1] !== ' ' && s[end + 1] !== '*') {
        push(<em key={out.length}>{parseInline(s.slice(i + 1, end), clock, allowLinks)}</em>);
        i = end + 1;
        continue;
      }
    }
    if (c === '[' && allowLinks) {
      const close = findClose(s, ']', i + 1);
      const target = close > i + 1 ? LINK_TARGET.exec(s.slice(close + 1)) : null;
      if (target !== null) {
        const label = parseInline(s.slice(i + 1, close), clock, false);
        const href = safeHttpUrl(target[1]!);
        push(
          href === null ? (
            <span key={out.length}>{label}</span>
          ) : (
            <a key={out.length} href={href} target="_blank" rel="noopener noreferrer">
              {label}
              {clock.indicateExternalLinks === true && ' (opens in a new tab)'}
            </a>
          ),
        );
        i = close + 1 + target[0].length;
        continue;
      }
    }
    if (c === '<') {
      const m = TOKEN.exec(s.slice(i, i + 40));
      if (m !== null) {
        if (m[1] !== undefined) {
          const kind = m[1] === '@&' ? 'role' : m[1] === '#' ? 'channel' : 'user';
          const label =
            kind === 'user' && clock.userNames !== undefined
              ? (clock.userNames[m[2] ?? ''] ?? `Unresolved user ${m[2] ?? ''}`)
              : kind === 'role'
                ? '@role'
                : kind === 'channel'
                  ? '#channel'
                  : '@member';
          push(
            <span key={out.length} data-pill={kind} className="discord-pill">
              {label}
            </span>,
          );
          i += m[0].length;
          continue;
        }
        const seconds = Number(m[3]);
        const shown = formatDiscordTimestamp(seconds, m[4] ?? 'f', clock);
        if (shown !== null) {
          push(
            <time
              key={out.length}
              className="discord-time"
              dateTime={new Date(seconds * 1000).toISOString()}
            >
              {shown}
            </time>,
          );
          i += m[0].length;
          continue;
        }
      }
    }
    buffer += c;
    i += 1;
  }
  flush();
  return out;
};

export const renderDiscordMarkdown = (text: string, clock: DiscordClock = {}): ReactNode => {
  const blocks: ReactNode[] = [];
  let paragraph: string[] = [];
  let quote: string[] = [];

  const lines = (rows: readonly string[]): ReactNode[] =>
    rows.flatMap((row, index) => [
      ...(index > 0 ? [<br key={`br${index}`} />] : []),
      ...parseInline(row, clock, true),
    ]);
  const flush = (): void => {
    if (paragraph.length > 0) blocks.push(<p key={blocks.length}>{lines(paragraph)}</p>);
    if (quote.length > 0)
      blocks.push(
        <blockquote key={blocks.length} className="discord-quote">
          {lines(quote)}
        </blockquote>,
      );
    paragraph = [];
    quote = [];
  };

  for (const raw of text.replace(/\r\n?/g, '\n').split('\n')) {
    if (raw.startsWith('-# ')) {
      flush();
      blocks.push(
        <small key={blocks.length} className="discord-sub">
          {parseInline(raw.slice(3), clock, true)}
        </small>,
      );
    } else if (raw.startsWith('> ')) {
      if (paragraph.length > 0) flush();
      quote.push(raw.slice(2));
    } else {
      if (quote.length > 0) flush();
      paragraph.push(raw);
    }
  }
  flush();
  return blocks;
};
