import { describe, expect, it } from 'vitest';
import { DISCORD_MESSAGE_LIMIT, splitForDiscord } from './split-message.js';

const balancesFences = (part: string): boolean => {
  const fences = part.match(/```/g) ?? [];
  return fences.length % 2 === 0;
};

describe('splitForDiscord', () => {
  it('returns short text as one unchanged part', () => {
    expect(splitForDiscord('Hello, club.')).toEqual(['Hello, club.']);
    expect(DISCORD_MESSAGE_LIMIT).toBe(2_000);
  });

  it('splits long paragraphs at blank lines', () => {
    const paragraph = 'Lorem ipsum dolor sit amet. '.repeat(20).trim();
    const input = Array.from({ length: 10 }, (_, i) => `Paragraph ${i}: ${paragraph}`).join('\n\n');
    expect(input.length).toBeGreaterThan(5_000);
    const parts = splitForDiscord(input);
    expect(parts.length).toBeGreaterThan(1);
    for (const part of parts) expect(part.length).toBeLessThanOrEqual(2_000);
    expect(parts.join('\n\n')).toBe(input);
  });

  it('hard-splits a single long line at a sentence end or space, never mid-word', () => {
    const input = `${'First sentence here. '.repeat(60)}${'second '.repeat(300)}end.`;
    expect(input).not.toContain('\n');
    expect(input.length).toBeGreaterThan(3_000);
    const parts = splitForDiscord(input);
    expect(parts.length).toBeGreaterThan(1);
    for (const part of parts) expect(part.length).toBeLessThanOrEqual(2_000);
    for (const part of parts.slice(0, -1)) {
      expect(part.endsWith('.') || part.endsWith(' ')).toBe(true);
    }
    expect(parts.join('').replaceAll(' ', '')).toBe(input.replaceAll(' ', ''));
  });

  it('keeps fenced code blocks balanced across parts', () => {
    const body = `${'const x = 1; // filler line to pad the block\n'.repeat(110)}const done = true;`;
    const input = `Here is the config:\n\`\`\`ts\n${body}\n\`\`\`\nThat is all.`;
    expect(input.length).toBeGreaterThan(4_000);
    const parts = splitForDiscord(input);
    expect(parts.length).toBeGreaterThan(1);
    for (const part of parts) {
      expect(part.length).toBeLessThanOrEqual(2_000);
      expect(balancesFences(part)).toBe(true);
    }
    for (const part of parts.slice(1)) {
      if (part.includes('const x = 1')) expect(part.startsWith('```ts\n')).toBe(true);
    }
  });

  it('caps output at 5 parts with a shortened marker', () => {
    const input = Array.from({ length: 40 }, (_, i) => `Paragraph ${i}: ${'word '.repeat(60)}`).join(
      '\n\n',
    );
    const parts = splitForDiscord(input);
    expect(parts).toHaveLength(5);
    expect(parts[4]!.endsWith('\n-# (answer shortened)')).toBe(true);
  });

  it('returns [] for empty text', () => {
    expect(splitForDiscord('')).toEqual([]);
    expect(splitForDiscord('   ')).toEqual([]);
  });
});
