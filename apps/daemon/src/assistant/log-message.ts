import {
  card,
  escapeInline,
  escapeText,
  subtext,
  text,
  toOutgoingMessage,
  truncate,
  ts,
  type OutgoingMessage,
} from '@bananasaurs/core';
import type { InvocationTrace } from './commands.js';

/**
 * The AI log channel post for one request (ADR 0065). Full question and
 * answer, by owner decision; web results appear only as links, never their
 * text (Brave terms, ADR 0066). Mentions never ping.
 */
export interface AssistantLogInput {
  readonly userId: string;
  readonly channelId?: string | undefined;
  readonly behaviourName: string;
  readonly command: string;
  readonly source: 'slash-command' | 'mention';
  readonly question: string;
  readonly outcome: 'answered' | 'refused' | 'failed';
  readonly answer: string;
  readonly reason?: string | undefined;
  readonly trace?: InvocationTrace | undefined;
  readonly at: number;
}

const TONE = { answered: 'ok', refused: 'hold', failed: 'danger' } as const;

/** Final quoted/escaped length of each Text Display, so the card fits the 4,000-char budget. */
const QUESTION_MAX = 1_000;
const ANSWER_MAX = 1_000;
const REASON_MAX = 600;
const SOURCES_MAX = 600;
const TOOLS_MAX = 300;

const clip = (text: string, max = 1_000): string => {
  const value = text.trim() === '' ? '(empty)' : text;
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
};

/** Every line quoted, so a multi-line question or answer stays inside the quote. */
const quote = (body: string): string =>
  body
    .split('\n')
    .map((line) => `> ${line}`)
    .join('\n');

/**
 * A source URL is only linked when it is really a web page: anything else (a
 * `javascript:` payload, a bare word) renders as plain escaped text, never a
 * link. Parentheses, whitespace and angle brackets are percent-encoded so the
 * Markdown link cannot break out of its parens.
 */
const safeSourceUrl = (raw: string): string | undefined => {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return undefined;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return undefined;
  return raw.replace(/[()\s<>]/g, (char) => encodeURIComponent(char));
};

/** The model name, tool names, source titles and URLs are provider- or
 * web-controlled, so every one is escaped; the link is only a link when the
 * URL survives `safeSourceUrl`. */
const sourceLine = (source: { readonly title: string; readonly url: string }): string => {
  const title = escapeInline(source.title.replace(/[[\]]/g, ''));
  const url = safeSourceUrl(source.url);
  return url === undefined ? title : `[${title}](${url})`;
};

/** Whole lines only, so a link is never cut in half. */
const clipLines = (lines: readonly string[], max = 1_000): string => {  const kept: string[] = [];
  let length = 0;
  for (const line of lines) {
    const extra = (kept.length === 0 ? 0 : 1) + line.length;
    if (length + extra > max - 12) {
      kept.push(`…and ${String(lines.length - kept.length)} more`);
      break;
    }
    kept.push(line);
    length += extra;
  }
  return kept.join('\n');
};

export const assistantLogMessage = (input: AssistantLogInput): OutgoingMessage => {
  const trace = input.trace;
  const tools = trace?.tools ?? [];
  const sources = trace?.sources ?? [];
  const sourceLines = sources.map((source) => sourceLine(source));
  const children = [
    text(
      subtext(
        `🤖 ${input.source === 'mention' ? 'MENTION' : `/${input.command}`} · ${input.outcome.toUpperCase()}`,
      ),
    ),
    text(
      `${`<@${input.userId}>${input.channelId === undefined ? '' : ` in <#${input.channelId}>`}`} · Behaviour: ${truncate(escapeInline(input.behaviourName), 100)}`,
    ),
    text('**Question**'),
    text(truncate(quote(escapeText(clip(input.question))), QUESTION_MAX)),
    text('**Answer**'),
    text(truncate(quote(clip(input.answer)), ANSWER_MAX)),
    ...(input.reason === undefined
      ? []
      : [text('**Reason**'), text(truncate(quote(escapeText(clip(input.reason))), REASON_MAX))]),
    text(
      subtext(
        truncate(
          `Tools: ${tools.length === 0 ? 'none' : tools.map((tool) => `${escapeInline(tool.name)} ${tool.ok ? '✓' : '✗'}`).join(', ')} · Model: ${trace?.model === undefined ? 'none' : escapeInline(trace.model)}${trace?.usedFallback === true ? ' (backup model)' : ''} · ${((trace?.latencyMs ?? 0) / 1_000).toFixed(1)} s`,
          TOOLS_MAX,
        ),
      ),
    ),
    text(
      subtext(
        `Sources: ${sourceLines.length === 0 ? 'none' : clipLines(sourceLines, SOURCES_MAX)}`,
      ),
    ),
    text(subtext(ts(input.at, 'R'))),
  ];
  return toOutgoingMessage(card({ tone: TONE[input.outcome], children }));
};
