import { describe, expect, it } from 'vitest';
import { cardTexts, countComponents, countText, TONE_ACCENT } from '@bananasaurs/core';
import { assistantLogMessage } from './log-message.js';

const base = {
  userId: '111111111111111111',
  channelId: '222222222222222222',
  behaviourName: 'Club assistant',
  command: 'ask' as const,
  source: 'mention' as const,
  question: 'When is the battery order arriving?',
  outcome: 'answered' as const,
  at: Date.UTC(2026, 8, 23, 19, 30),
};

const textsOf = (message: ReturnType<typeof assistantLogMessage>): string =>
  cardTexts(message.components ?? []);

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
    expect(message.flags).toBe(32768);
    expect(message.embeds).toBeUndefined();
    const texts = textsOf(message);
    expect(texts).toContain('-# 🤖 MENTION · ANSWERED');
    expect(texts).toContain('<@111111111111111111> in <#222222222222222222>');
    expect(texts).toContain('Behaviour: Club assistant');
    expect(texts).toContain('**Question**');
    expect(texts).toContain('When is the battery order arriving?');
    expect(texts).toContain('**Answer**');
    expect(texts).toContain('It ships Friday.');
    expect(texts).toContain('Tools: search_archive ✓, web_search ✗');
    expect(texts).toContain('Sources: [Handbook](https://example.com/handbook)');
    expect(texts).toContain('Model: gemini-2.5-flash (backup model) · 1.2 s');
    expect(texts).toContain('<t:1790191800:R>');
  });

  it('says none for no tools and gives the reason for a failure', () => {
    const texts = textsOf(
      assistantLogMessage({
        ...base,
        command: 'find',
        source: 'slash-command',
        outcome: 'failed',
        answer: 'The AI service is busy right now.',
        reason: 'Gemini request failed with HTTP 503',
      }),
    );
    expect(texts).toContain('-# 🤖 /find · FAILED');
    expect(texts).toContain('Tools: none');
    expect(texts).toContain('**Reason**');
    expect(texts).toContain('Gemini request failed with HTTP 503');
  });

  it('omits the reason and backup marker when not given', () => {
    const texts = textsOf(
      assistantLogMessage({
        ...base,
        outcome: 'answered',
        answer: 'It ships Friday.',
        trace: {
          latencyMs: 2_300,
          model: 'gemini-2.5-flash',
          tools: [],
          sources: [],
          web: false,
          usedFallback: false,
        },
      }),
    );
    expect(texts).not.toContain('**Reason**');
    expect(texts).toContain('Model: gemini-2.5-flash · 2.3 s');
    expect(texts).not.toContain('(backup model)');
  });

  it('maps each outcome to its tone', () => {
    for (const [outcome, tone] of [
      ['answered', 'ok'],
      ['refused', 'hold'],
      ['failed', 'danger'],
    ] as const) {
      const message = assistantLogMessage({ ...base, outcome, answer: 'an answer' });
      expect(message.components?.[0]).toMatchObject({ accent_color: TONE_ACCENT[tone] });
    }
  });

  it('carries sources as links only, stripping brackets from titles', () => {
    const texts = textsOf(
      assistantLogMessage({
        ...base,
        outcome: 'answered',
        answer: 'an answer',
        trace: {
          latencyMs: 1,
          tools: [],
          sources: [{ title: 'A [bracketed] title', url: 'https://example.com/x' }],
          web: false,
        },
      }),
    );
    expect(texts).toContain('[A bracketed title](https://example.com/x)');
    expect(texts).not.toContain('A [bracketed] title');
  });

  it('escapes the question and the reason, and keeps the answer Markdown', () => {
    const texts = textsOf(
      assistantLogMessage({
        ...base,
        outcome: 'refused',
        question: '@everyone is **late**',
        answer: 'Join **like this**.',
        reason: '@everyone did it',
      }),
    );
    expect(texts).toContain('@​everyone is \\*\\*late\\*\\*');
    expect(texts).toContain('@​everyone did it');
    expect(texts).toContain('Join **like this**.');
  });

  it('escapes the behaviour name', () => {
    const texts = textsOf(
      assistantLogMessage({
        ...base,
        behaviourName: '**x**',
        outcome: 'answered',
        answer: 'an answer',
      }),
    );
    expect(texts).toContain('Behaviour: \\*\\*x\\*\\*');
  });

  it('quotes every line of a multi-line question and answer', () => {
    const texts = textsOf(
      assistantLogMessage({
        ...base,
        outcome: 'answered',
        question: 'line one\nline two\nline three',
        answer: 'first\n# Heading\nthird',
      }),
    );
    const questionPart = texts.split('**Question**\n')[1]?.split('\n**Answer**')[0] ?? '';
    for (const line of ['> line one', '> line two', '> line three'])
      expect(questionPart).toContain(line);
    const answerPart = texts.split('**Answer**\n')[1]?.split('\n-# Tools:')[0] ?? '';
    for (const line of ['> first', '> # Heading', '> third']) expect(answerPart).toContain(line);
  });

  it('caps question and answer at 1,000 characters', () => {
    const long = 'x'.repeat(5_000);
    const texts = textsOf(
      assistantLogMessage({
        ...base,
        outcome: 'answered',
        question: long,
        answer: long,
      }),
    );
    const questionPart = texts.split('**Question**\n')[1]?.split('\n**Answer**')[0] ?? '';
    const answerPart = texts.split('**Answer**\n')[1]?.split('\n-# Tools:')[0] ?? '';
    const stripQuotes = (section: string): string =>
      section
        .split('\n')
        .filter((line) => line.startsWith('> '))
        .map((line) => line.slice(2))
        .join('\n');
    expect(stripQuotes(questionPart).length).toBeLessThanOrEqual(1_000);
    expect(stripQuotes(answerPart).length).toBeLessThanOrEqual(1_000);
    expect(questionPart).toContain('…');
  });

  it('caps the reason and source links and keeps the card within budget', () => {
    const texts = textsOf(
      assistantLogMessage({
        ...base,
        outcome: 'failed',
        answer: 'an answer',
        reason: 'r'.repeat(5_000),
        trace: {
          latencyMs: 1,
          tools: [],
          sources: Array.from({ length: 100 }, (_, index) => ({
            title: `Source ${String(index)}`,
            url: `https://example.com/${'p'.repeat(50)}/${String(index)}`,
          })),
          web: true,
        },
      }),
    );
    const reasonPart = texts.split('**Reason**\n')[1]?.split('\n-# Tools:')[0] ?? '';
    const sourcesLine = texts.split('\n-# Sources: ')[1]?.split('\n-# <t:')[0] ?? '';
    expect(reasonPart.replace(/^> /, '')).toHaveLength(1_000);
    expect(sourcesLine.length).toBeLessThanOrEqual(1_000);
    expect(
      countComponents(assistantLogMessage({ ...base, answer: 'an answer' }).components ?? []),
    ).toBeLessThanOrEqual(40);
    expect(
      countText(assistantLogMessage({ ...base, answer: 'an answer' }).components ?? []),
    ).toBeLessThanOrEqual(4_000);
  });
});
