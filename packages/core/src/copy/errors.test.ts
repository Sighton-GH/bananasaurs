import { describe, expect, it } from 'vitest';
import { ERROR_COPY } from './errors.js';

const BANNED = /\b(please|sorry|oops|invalid|illegal|forbidden|failed to|an error occurred)\b/i;

describe('error copy (docs/28 §3)', () => {
  it('task.changed uses the Task 11 copy verbatim', () => {
    expect(ERROR_COPY['task.changed']).toEqual({
      title: 'This task just changed',
      detail: 'Someone edited it while you were choosing.',
      next: 'Run /task complete again.',
      retryable: true,
      tone: 'hold',
      audience: 'member',
    });
  });

  it.each(Object.entries(ERROR_COPY))('%s follows the writing rules', (_code, entry) => {
    expect(entry.title.length).toBeGreaterThan(0);
    expect(entry.title.length).toBeLessThanOrEqual(60);
    expect(entry.detail.length).toBeGreaterThan(0);
    const next = 'next' in entry ? entry.next : '';
    for (const s of [entry.title, entry.detail, next]) expect(s).not.toMatch(BANNED);
    expect(entry.title[0]).toBe(entry.title[0]?.toUpperCase());
    expect(entry.title).not.toMatch(/[.!]$/);
  });
});
