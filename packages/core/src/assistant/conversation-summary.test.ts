import { describe, expect, it } from 'vitest';
import {
  cleanSummary,
  conversationSummarySchema,
  parseSummaryJson,
  renderSummary,
  type ConversationSummary,
} from './conversation-summary.js';

const valid = (over: Partial<ConversationSummary> = {}): ConversationSummary => ({
  topic: 'Friday social planning',
  facts: [{ text: 'The hall opens at six', from: 'member' }],
  botClaims: ['The hall might open at six'],
  openQuestions: ['Who brings snacks?'],
  commitments: [{ who: 'Ada', what: 'bring snacks', when: 'Friday' }],
  participants: ['Ada'],
  ...over,
});

describe('conversationSummarySchema caps', () => {
  it('accepts a valid summary', () => {
    expect(conversationSummarySchema.safeParse(valid()).success).toBe(true);
  });

  it('refuses one-over on every cap', () => {
    const s = (ch: string, n: number): string => ch.repeat(n);
    expect(
      conversationSummarySchema.safeParse(valid({ topic: s('t', 201) })).success,
    ).toBe(false);
    expect(
      conversationSummarySchema.safeParse(
        valid({ facts: Array.from({ length: 11 }, () => ({ text: 'ok', from: 'member' as const })) }),
      ).success,
    ).toBe(false);
    expect(
      conversationSummarySchema.safeParse(
        valid({ facts: [{ text: s('f', 301), from: 'member' as const }] }),
      ).success,
    ).toBe(false);
    expect(
      conversationSummarySchema.safeParse(valid({ botClaims: Array.from({ length: 6 }, () => 'ok') }))
        .success,
    ).toBe(false);
    expect(
      conversationSummarySchema.safeParse(valid({ botClaims: [s('b', 301)] })).success,
    ).toBe(false);
    expect(
      conversationSummarySchema.safeParse(
        valid({ openQuestions: Array.from({ length: 6 }, () => 'ok') }),
      ).success,
    ).toBe(false);
    expect(
      conversationSummarySchema.safeParse(valid({ openQuestions: [s('q', 301)] })).success,
    ).toBe(false);
    expect(
      conversationSummarySchema.safeParse(
        valid({
          commitments: Array.from({ length: 6 }, () => ({ who: 'Ada', what: 'snacks' })),
        }),
      ).success,
    ).toBe(false);
    expect(
      conversationSummarySchema.safeParse(
        valid({ commitments: [{ who: s('w', 81), what: 'snacks' }] }),
      ).success,
    ).toBe(false);
    expect(
      conversationSummarySchema.safeParse(
        valid({ commitments: [{ who: 'Ada', what: s('w', 201) }] }),
      ).success,
    ).toBe(false);
    expect(
      conversationSummarySchema.safeParse(
        valid({ commitments: [{ who: 'Ada', what: 'snacks', when: s('w', 81) }] }),
      ).success,
    ).toBe(false);
    expect(
      conversationSummarySchema.safeParse(
        valid({ participants: Array.from({ length: 11 }, () => 'Ada') }),
      ).success,
    ).toBe(false);
    expect(
      conversationSummarySchema.safeParse(valid({ participants: [s('p', 81)] })).success,
    ).toBe(false);
  });

  it('refuses blank strings', () => {
    expect(conversationSummarySchema.safeParse(valid({ topic: '   ' })).success).toBe(false);
  });

  it('refuses unknown keys', () => {
    expect(
      conversationSummarySchema.safeParse({ ...valid(), extra: 'nope' }).success,
    ).toBe(false);
  });
});

describe('parseSummaryJson', () => {
  it('parses plain JSON', () => {
    expect(parseSummaryJson(JSON.stringify(valid()))).toEqual(valid());
  });

  it('strips a single surrounding ```json fence', () => {
    const fenced = '```json\n' + JSON.stringify(valid()) + '\n```';
    expect(parseSummaryJson(fenced)).toEqual(valid());
  });

  it('returns undefined for garbage, wrong shapes and invalid summaries', () => {
    expect(parseSummaryJson('not json at all')).toBeUndefined();
    expect(parseSummaryJson('{"topic": 42}')).toBeUndefined();
    expect(parseSummaryJson(JSON.stringify(valid({ topic: 'x'.repeat(201) })))).toBeUndefined();
    expect(parseSummaryJson('')).toBeUndefined();
  });
});

describe('renderSummary', () => {
  it('renders every part in order with the required labels', () => {
    const text = renderSummary(
      valid({
        facts: [
          { text: 'hall opens at six', from: 'member' },
          { text: 'see the handbook', from: 'club-doc' },
          { text: 'last year it rained', from: 'archive' },
        ],
        commitments: [
          { who: 'Ada', what: 'bring snacks', when: 'Friday' },
          { who: 'Bo', what: 'bring drinks' },
        ],
        participants: ['Ada', 'Bo'],
      }),
    );
    const lines = text.split('\n');
    expect(lines[0]).toBe('Topic: Friday social planning');
    expect(lines[1]).toBe(
      'Facts: hall opens at six (member); see the handbook (club doc); last year it rained (archive)',
    );
    expect(lines[2]).toBe(
      'The bot said earlier (not confirmed): The hall might open at six',
    );
    expect(lines[3]).toBe('Open questions: Who brings snacks?');
    expect(lines[4]).toBe('Commitments: Ada — bring snacks (Friday); Bo — bring drinks');
    expect(lines[5]).toBe('People: Ada, Bo');
  });

  it('omits empty parts', () => {
    const text = renderSummary(
      valid({
        facts: [],
        botClaims: [],
        openQuestions: [],
        commitments: [],
        participants: [],
      }),
    );
    expect(text).toBe('Topic: Friday social planning');
  });

  it('caps the output at 150 words', () => {
    const wordy = (n: number): string => Array.from({ length: n }, () => 'word').join(' ');
    const text = renderSummary(
      valid({
        topic: wordy(60),
        facts: [{ text: wordy(60), from: 'member' }],
        botClaims: [wordy(60)],
        openQuestions: [wordy(60)],
        commitments: [{ who: 'Ada', what: wordy(60) }],
        participants: ['Ada'],
      }),
    );
    const words = text.split(/\s+/).filter((w) => w.length > 0);
    expect(words.length).toBeLessThanOrEqual(150);
  });
});

describe('cleanSummary', () => {
  it('applies clean to every string', () => {
    const seen: string[] = [];
    const cleaned = cleanSummary(
      valid({
        facts: [{ text: 'fact one', from: 'member' }],
        botClaims: ['claim one'],
        openQuestions: ['question one'],
        commitments: [{ who: 'Ada', what: 'snacks', when: 'Friday' }],
        participants: ['Ada'],
      }),
      (s) => {
        seen.push(s);
        return s.toUpperCase();
      },
    );
    expect(cleaned.topic).toBe('FRIDAY SOCIAL PLANNING');
    expect(cleaned.facts).toEqual([{ text: 'FACT ONE', from: 'member' }]);
    expect(cleaned.botClaims).toEqual(['CLAIM ONE']);
    expect(cleaned.openQuestions).toEqual(['QUESTION ONE']);
    expect(cleaned.commitments).toEqual([{ who: 'ADA', what: 'SNACKS', when: 'FRIDAY' }]);
    expect(cleaned.participants).toEqual(['ADA']);
    expect(seen).toContain('Friday social planning');
    expect(seen).toContain('fact one');
    expect(seen).toContain('claim one');
    expect(seen).toContain('question one');
    expect(seen).toContain('Ada');
    expect(seen).toContain('snacks');
    expect(seen).toContain('Friday');
  });
});
