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

const clip = (text: string, max = 1_000): string => {
  const value = text.trim() === '' ? '(empty)' : text;
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
};

/** Every line quoted, so a multi-line question or answer stays inside the quote. */
const quote = (body: string): string =>
  body
    .split('\n')
    .map((line) => `> ${line}`)
    .join('\n');/** Whole lines only, so a link is never cut in half. */
const clipLines = (lines: readonly string[], max = 1_000): string => {
  const kept: string[] = [];
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
  const sourceLines = sources.map(
    (source) => `[${source.title.replace(/[[\]]/g, '')}](${source.url})`,
  );
  const children = [
    text(
      subtext(
        `🤖 ${input.source === 'mention' ? 'MENTION' : `/${input.command}`} · ${input.outcome.toUpperCase()}`,
      ),
    ),
    text(
      `${`<@${input.userId}>${input.channelId === undefined ? '' : ` in <#${input.channelId}>`}`} · Behaviour: ${escapeInline(input.behaviourName)}`,
    ),
    text('**Question**'),
    text(quote(truncate(escapeText(clip(input.question, 1_000)), 1_000))),
    text('**Answer**'),
    text(quote(truncate(clip(input.answer, 1_000), 1_000))),
    ...(input.reason === undefined
      ? []
      : [text('**Reason**'), text(quote(truncate(escapeText(clip(input.reason, 1_000)), 1_000)))]),
    text(
      subtext(
        `Tools: ${tools.length === 0 ? 'none' : tools.map((tool) => `${tool.name} ${tool.ok ? '✓' : '✗'}`).join(', ')} · Model: ${trace?.model ?? 'none'}${trace?.usedFallback === true ? ' (backup model)' : ''} · ${((trace?.latencyMs ?? 0) / 1_000).toFixed(1)} s`,
      ),
    ),
    text(subtext(`Sources: ${sourceLines.length === 0 ? 'none' : clipLines(sourceLines)}`)),
    text(subtext(ts(input.at, 'R'))),
  ];
  return toOutgoingMessage(card({ tone: TONE[input.outcome], children }));
};
