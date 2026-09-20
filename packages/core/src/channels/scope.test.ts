import { describe, expect, it } from 'vitest';
import { isInScope, type ScopeFacts } from './scope.js';

const facts = (over: Partial<ScopeFacts> = {}): ScopeFacts => ({
  channelId: 'C',
  parentChannelId: undefined,
  categoryId: undefined,
  isPrivateThread: false,
  hasOwnRow: () => false,
  hasCategoryRow: () => false,
  isExcluded: () => false,
  parentIncludesThreads: () => true,
  ...over,
});

describe('isInScope', () => {
  it('accepts an exact row', () =>
    expect(isInScope('archive', facts({ hasOwnRow: (id) => id === 'C' }))).toBe(true));
  it('a public thread inherits its parent', () =>
    expect(
      isInScope(
        'archive',
        facts({ channelId: 'T', parentChannelId: 'P', hasOwnRow: (id) => id === 'P' }),
      ),
    ).toBe(true));
  it('a channel inherits its category', () =>
    expect(
      isInScope('send', facts({ categoryId: 'CAT', hasCategoryRow: (id) => id === 'CAT' })),
    ).toBe(true));
  it('a private thread never inherits', () => {
    for (const purpose of ['archive', 'send'] as const)
      expect(
        isInScope(
          purpose,
          facts({
            channelId: 'T',
            parentChannelId: 'P',
            categoryId: 'CAT',
            isPrivateThread: true,
            hasOwnRow: (id) => id === 'P',
            hasCategoryRow: (id) => id === 'CAT',
          }),
        ),
      ).toBe(false);
  });
  it('an explicit private-thread row counts', () =>
    expect(
      isInScope(
        'send',
        facts({
          channelId: 'T',
          parentChannelId: 'P',
          isPrivateThread: true,
          hasOwnRow: (id) => id === 'T',
        }),
      ),
    ).toBe(true));
  it('exclusion at thread, parent, or category wins', () => {
    for (const excluded of ['T', 'P', 'CAT'])
      expect(
        isInScope(
          'archive',
          facts({
            channelId: 'T',
            parentChannelId: 'P',
            categoryId: 'CAT',
            hasOwnRow: (id) => id === 'P',
            isExcluded: (id) => id === excluded,
          }),
        ),
      ).toBe(false);
  });
  it('include_threads disables archive inheritance only', () => {
    const f = facts({
      channelId: 'T',
      parentChannelId: 'P',
      hasOwnRow: (id) => id === 'P',
      parentIncludesThreads: () => false,
    });
    expect(isInScope('archive', f)).toBe(false);
    expect(isInScope('send', f)).toBe(true);
  });
  it('category archive inheritance honours the parent include_threads setting', () => {
    const f = facts({
      channelId: 'T',
      parentChannelId: 'P',
      categoryId: 'CAT',
      hasCategoryRow: (id) => id === 'CAT',
      parentIncludesThreads: () => false,
    });
    expect(isInScope('archive', f)).toBe(false);
  });
});
