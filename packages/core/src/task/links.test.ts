import { describe, expect, it } from 'vitest';
import { taskLinksSchema } from './links.js';

describe('taskLinksSchema', () => {
  it('accepts up to five https links and trims labels', () => {
    const parsed = taskLinksSchema.parse([{ label: '  Docs ', url: 'https://example.com/a' }]);
    expect(parsed).toEqual([{ label: 'Docs', url: 'https://example.com/a' }]);
  });
  it.each([
    [[{ label: 'x', url: 'http://example.com' }]],
    [[{ label: '', url: 'https://example.com' }]],
    [[{ label: 'x'.repeat(35), url: 'https://example.com' }]],
    [[{ label: 'x', url: `https://example.com/${'a'.repeat(500)}` }]],
    [[{ label: 'x', url: 'javascript:alert(1)' }]],
    [Array.from({ length: 6 }, (_, i) => ({ label: `L${i}`, url: `https://e.com/${i}` }))],
    [[{ label: 'x', url: 'https://example.com', extra: 1 }]],
  ])('rejects %j', (input) => {
    expect(taskLinksSchema.safeParse(input).success).toBe(false);
  });
});
