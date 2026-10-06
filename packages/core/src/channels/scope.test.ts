import { describe, expect, it } from 'vitest';
import { isInScope, isNoAccess, type ScopeFacts } from './scope.js';

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
    expect(isInScope('archive', facts({ hasOwnRow: (id) => id === 'C' }))).toBe('C'));
  it('a public thread inherits its parent', () =>
    expect(
      isInScope(
        'archive',
        facts({ channelId: 'T', parentChannelId: 'P', hasOwnRow: (id) => id === 'P' }),
      ),
    ).toBe('P'));
  it('a channel inherits its category', () =>
    expect(
      isInScope('send', facts({ categoryId: 'CAT', hasCategoryRow: (id) => id === 'CAT' })),
    ).toBe('CAT'));
  it('a private thread inherits read and send from its parent, never archive', () => {
    const base = {
      channelId: 'T',
      parentChannelId: 'P',
      categoryId: 'CAT',
      isPrivateThread: true,
      hasOwnRow: (id: string) => id === 'P',
      hasCategoryRow: (id: string) => id === 'CAT',
    };
    expect(isInScope('send', facts(base))).toBe('P');
    expect(isInScope('read', facts(base))).toBe('P');
    expect(isInScope('archive', facts(base))).toBeUndefined();
  });
  it('a private thread inherits its category for read and send when the parent has no row', () => {
    const base = {
      channelId: 'T',
      parentChannelId: 'P',
      categoryId: 'CAT',
      isPrivateThread: true,
      hasCategoryRow: (id: string) => id === 'CAT',
    };
    expect(isInScope('send', facts(base))).toBe('CAT');
    expect(isInScope('read', facts(base))).toBe('CAT');
    expect(isInScope('archive', facts(base))).toBeUndefined();
  });
  it('an exclusion on a private thread, its parent or its category vetoes read and send', () => {
    for (const excluded of ['T', 'P', 'CAT'])
      for (const purpose of ['read', 'send'] as const)
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
              isExcluded: (id) => id === excluded,
            }),
          ),
        ).toBeUndefined();
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
    ).toBe('T'));
  it('an explicit private-thread row counts for archive too — only inheritance is barred', () =>
    expect(
      isInScope(
        'archive',
        facts({
          channelId: 'T',
          parentChannelId: 'P',
          isPrivateThread: true,
          hasOwnRow: (id) => id === 'T',
        }),
      ),
    ).toBe('T'));
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
      ).toBeUndefined();
  });
  it('include_threads disables archive inheritance only', () => {
    const f = facts({
      channelId: 'T',
      parentChannelId: 'P',
      hasOwnRow: (id) => id === 'P',
      parentIncludesThreads: () => false,
    });
    expect(isInScope('archive', f)).toBeUndefined();
    expect(isInScope('send', f)).toBe('P');
  });
  it('category archive inheritance honours the parent include_threads setting', () => {
    const f = facts({
      channelId: 'T',
      parentChannelId: 'P',
      categoryId: 'CAT',
      hasCategoryRow: (id) => id === 'CAT',
      parentIncludesThreads: () => false,
    });
    expect(isInScope('archive', f)).toBeUndefined();
  });
  it('the granting id names the winning row: own row beats parent, parent beats category', () => {
    expect(
      isInScope(
        'send',
        facts({
          channelId: 'T',
          parentChannelId: 'P',
          categoryId: 'CAT',
          hasOwnRow: (id) => id === 'T' || id === 'P',
          hasCategoryRow: (id) => id === 'CAT',
        }),
      ),
    ).toBe('T');
    expect(
      isInScope(
        'send',
        facts({
          channelId: 'T',
          parentChannelId: 'P',
          categoryId: 'CAT',
          hasOwnRow: (id) => id === 'P',
          hasCategoryRow: (id) => id === 'CAT',
        }),
      ),
    ).toBe('P');
  });
});

describe('isInScope archive pause veto', () => {
  it('a paused own row vetoes archive under a collecting category, but not send or read', () => {
    const base = {
      categoryId: 'CAT',
      hasOwnRow: () => false,
      hasPausedOwnRow: (id: string) => id === 'C',
      hasCategoryRow: (id: string) => id === 'CAT',
    };
    expect(isInScope('archive', facts(base))).toBeUndefined();
    expect(isInScope('send', facts(base))).toBe('CAT');
    expect(isInScope('read', facts(base))).toBe('CAT');
  });
  it("a paused parent own row vetoes its thread's archive grant", () => {
    const base = {
      channelId: 'T',
      parentChannelId: 'P',
      categoryId: 'CAT',
      hasOwnRow: (id: string) => id === 'P',
      hasPausedOwnRow: (id: string) => id === 'P',
      hasCategoryRow: (id: string) => id === 'CAT',
    };
    expect(isInScope('archive', facts(base))).toBeUndefined();
    expect(isInScope('send', facts(base))).toBe('P');
  });
  it('the pause veto wins regardless of the parent include_threads flag', () => {
    for (const threads of [true, false]) {
      const base = {
        channelId: 'T',
        parentChannelId: 'P',
        categoryId: 'CAT',
        hasOwnRow: (id: string) => id === 'P',
        hasPausedOwnRow: (id: string) => id === 'P',
        hasCategoryRow: (id: string) => id === 'CAT',
        parentIncludesThreads: () => threads,
      };
      expect(isInScope('archive', facts(base))).toBeUndefined();
    }
  });
  it('without a paused row the category still grants archive', () => {
    const base = {
      categoryId: 'CAT',
      hasOwnRow: () => false,
      hasCategoryRow: (id: string) => id === 'CAT',
    };
    expect(isInScope('archive', facts(base))).toBe('CAT');
  });
});

describe('isInScope read purpose', () => {
  it('a public thread inherits its parent own row', () =>
    expect(
      isInScope(
        'read',
        facts({
          channelId: 'T',
          parentChannelId: 'P',
          hasOwnRow: (id) => id === 'P',
          parentIncludesThreads: () => false,
        }),
      ),
    ).toBe('P'));
  it('a private thread inherits its parent for read, and archive still never inherits', () => {
    const base = {
      channelId: 'T',
      parentChannelId: 'P',
      categoryId: 'CAT',
      isPrivateThread: true,
      hasOwnRow: (id: string) => id === 'P',
      hasCategoryRow: (id: string) => id === 'CAT',
    };
    expect(isInScope('read', facts(base))).toBe('P');
    expect(isInScope('archive', facts(base))).toBeUndefined();
  });
  it('a category grants its channels and threads', () => {
    expect(
      isInScope('read', facts({ categoryId: 'CAT', hasCategoryRow: (id) => id === 'CAT' })),
    ).toBe('CAT');
    expect(
      isInScope(
        'read',
        facts({
          channelId: 'T',
          parentChannelId: 'P',
          categoryId: 'CAT',
          hasCategoryRow: (id) => id === 'CAT',
          parentIncludesThreads: () => false,
        }),
      ),
    ).toBe('CAT');
  });
  it('an exclusion on the thread, parent or category vetoes', () => {
    for (const excluded of ['T', 'P', 'CAT'])
      expect(
        isInScope(
          'read',
          facts({
            channelId: 'T',
            parentChannelId: 'P',
            categoryId: 'CAT',
            hasOwnRow: () => true,
            hasCategoryRow: () => true,
            isExcluded: (id) => id === excluded,
          }),
        ),
      ).toBeUndefined();
  });
});

describe('isNoAccess', () => {
  it('is true for an exclusion at each of the three levels', () => {
    for (const excluded of ['T', 'P', 'CAT'])
      expect(
        isNoAccess({
          channelId: 'T',
          parentChannelId: 'P',
          categoryId: 'CAT',
          isExcluded: (id) => id === excluded,
        }),
      ).toBe(true);
  });
  it('is false with no exclusion', () =>
    expect(
      isNoAccess({
        channelId: 'T',
        parentChannelId: 'P',
        categoryId: 'CAT',
        isExcluded: () => false,
      }),
    ).toBe(false));
});
