import type { OutgoingMessage } from '@bananasaurs/core';
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

const FIELD_MAX = 1_024;
const COLOURS = { answered: 0x2e7d32, refused: 0xb26a00, failed: 0xc62828 } as const;

const clip = (text: string, max = FIELD_MAX): string => {
  const value = text.trim() === '' ? '(empty)' : text;
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
};

/** Whole lines only, so a link is never cut in half. */
const clipLines = (lines: readonly string[], max = FIELD_MAX): string => {
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
  const fields = [
    {
      name: 'Asked by',
      value: `<@${input.userId}>${input.channelId === undefined ? '' : ` in <#${input.channelId}>`}`,
      inline: true,
    },
    { name: 'Behaviour', value: clip(input.behaviourName, 256), inline: true },
    { name: 'Question', value: clip(input.question) },
    { name: 'Answer', value: clip(input.answer) },
    {
      name: 'Tools',
      value:
        tools.length === 0
          ? 'none'
          : clip(tools.map((t) => `${t.name} ${t.ok ? '✓' : '✗'}`).join(', ')),
    },
    {
      name: 'Sources',
      value:
        sources.length === 0
          ? 'none'
          : clipLines(sources.map((s) => `[${s.title.replace(/[[\]]/g, '')}](${s.url})`)),
    },
    ...(trace?.model === undefined
      ? []
      : [
          {
            name: 'Model',
            value: `${trace.model}${trace.usedFallback === true ? ' (backup model)' : ''} · ${(trace.latencyMs / 1_000).toFixed(1)} s`,
          },
        ]),
    ...(input.reason === undefined ? [] : [{ name: 'Reason', value: clip(input.reason) }]),
  ];
  return {
    embeds: [
      {
        title: `${input.source === 'mention' ? 'Mention' : `/${input.command}`} · ${input.outcome}`,
        color: COLOURS[input.outcome],
        fields,
        timestamp: new Date(input.at).toISOString(),
      },
    ],
    allowedMentions: { parse: [] },
  };
};
