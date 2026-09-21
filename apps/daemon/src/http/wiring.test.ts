import { describe, expect, it, vi } from 'vitest';
import { listAllAssistantMembers } from './wiring.js';

describe('assistant member directory pagination and cache', () => {
  it('loads every 1,000-member page and caches the result briefly', async () => {
    let now = 1_000;
    const first = Array.from({ length: 1_000 }, (_, i) => ({ id: String(i), name: `member ${i}` }));
    const second = Array.from({ length: 205 }, (_, i) => ({
      id: String(i + 1_000),
      name: `member ${i + 1_000}`,
    }));
    const listPage = vi.fn((after: string | undefined) =>
      Promise.resolve(after === undefined ? first : second),
    );
    const loaded = await listAllAssistantMembers('guild-pagination-test', () => now, listPage);
    expect(loaded).toHaveLength(1_205);
    expect(listPage.mock.calls).toEqual([[undefined], ['999']]);
    await expect(
      listAllAssistantMembers('guild-pagination-test', () => now, listPage),
    ).resolves.toBe(loaded);
    expect(listPage).toHaveBeenCalledTimes(2);
    now += 5 * 60_000 + 1;
    await listAllAssistantMembers('guild-pagination-test', () => now, listPage);
    expect(listPage).toHaveBeenCalledTimes(4);
  });
});
