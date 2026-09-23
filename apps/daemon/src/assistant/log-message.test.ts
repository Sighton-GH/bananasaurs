import { describe, expect, it } from 'vitest';
import { assistantLogMessage } from './log-message.js';

const base = {
  userId: '111111111111111111',
  channelId: '222222222222222222',
  behaviourName: 'Club assistant',
  command: 'ask' as const,
  source: 'mention' as const,
  question: 'When is the battery order arriving?',
  at: Date.UTC(2026, 8, 23, 19, 30),
};

type Embed = {
  title: string;
  color: number;
  fields: { name: string; value: string; inline?: boolean }[];
  timestamp: string;
};
const embedOf = (message: ReturnType<typeof assistantLogMessage>): Embed =>
  (message.embeds as Embed[])[0]!;
const field = (embed: Embed, name: string) => embed.fields.find((f) => f.name === name)?.value;

describe('assistantLogMessage (ADR 0065)', () => {
  it('reports who asked, the question, the answer, tools, sources, model and latency', () => {
    const message = assistantLogMessage({
      ...base,
      outcome: 'answered',
      answer: 'It ships Friday.',
      trace: {
        latencyMs: 1_234,
        model: 'gemini-2.5-flash',
        tools: [
          { name: 'search_archive', ok: true },
          { name: 'web_search', ok: false },
        ],
        sources: [{ title: 'Handbook', url: 'https://example.com/handbook' }],
        web: false,
        usedFallback: true,
      },
    });
    expect(message.allowedMentions).toEqual({ parse: [] });
    const embed = embedOf(message);
    expect(embed.title).toBe('Mention · answered');
    expect(field(embed, 'Asked by')).toBe('<@111111111111111111> in <#222222222222222222>');
    expect(field(embed, 'Behaviour')).toBe('Club assistant');
    expect(field(embed, 'Question')).toBe('When is the battery order arriving?');
    expect(field(embed, 'Answer')).toBe('It ships Friday.');
    expect(field(embed, 'Tools')).toBe('search_archive ✓, web_search ✗');
    expect(field(embed, 'Sources')).toBe('[Handbook](https://example.com/handbook)');
    expect(field(embed, 'Model')).toBe('gemini-2.5-flash (backup model) · 1.2 s');
    expect(embed.timestamp).toBe('2026-09-23T19:30:00.000Z');
  });

  it('says none for no tools or sources, and gives the reason for a failure', () => {
    const embed = embedOf(
      assistantLogMessage({
        ...base,
        command: 'find',
        source: 'slash-command',
        outcome: 'failed',
        answer: 'The AI service is busy right now.',
        reason: 'Gemini request failed with HTTP 503',
      }),
    );
    expect(embed.title).toBe('/find · failed');
    expect(field(embed, 'Tools')).toBe('none');
    expect(field(embed, 'Sources')).toBe('none');
    expect(field(embed, 'Reason')).toBe('Gemini request failed with HTTP 503');
    expect(field(embed, 'Model')).toBeUndefined();
  });

  it('keeps every field inside Discord limits', () => {
    const long = 'x'.repeat(5_000);
    const embed = embedOf(
      assistantLogMessage({
        ...base,
        outcome: 'answered',
        question: long,
        answer: long,
        trace: {
          latencyMs: 1,
          sources: Array.from({ length: 50 }, (_, i) => ({
            title: `Source ${String(i)}`,
            url: `https://example.com/${'p'.repeat(40)}/${String(i)}`,
          })),
        },
      }),
    );
    for (const f of embed.fields) expect(f.value.length).toBeLessThanOrEqual(1_024);
    const total =
      embed.title.length + embed.fields.reduce((n, f) => n + f.name.length + f.value.length, 0);
    expect(total).toBeLessThanOrEqual(6_000);
    expect(field(embed, 'Question')?.endsWith('…')).toBe(true);
  });
});
