import { describe, expect, it } from 'vitest';
import {
  isSourceExcluded,
  routeAccepts,
  routeDedupeKind,
  type LogRoute,
  type LogSource,
} from './routing.js';

const route = (over: Partial<LogRoute> = {}): LogRoute => ({
  routeId: 'r1',
  channelId: 'dest',
  includeContent: true,
  enabled: true,
  excludedChannelIds: [],
  ...over,
});

describe('routeAccepts', () => {
  it('rejects a disabled route', () => {
    expect(routeAccepts(route({ enabled: false }), undefined)).toBe(false);
    expect(
      routeAccepts(route({ enabled: false }), { channelId: 'c', parentChannelId: undefined }),
    ).toBe(false);
  });

  it('rejects an excluded source channel', () => {
    const r = route({ excludedChannelIds: ['excluded'] });
    expect(
      routeAccepts(r, { channelId: 'excluded', parentChannelId: undefined }),
    ).toBe(false);
  });

  it('rejects a thread whose parent is excluded', () => {
    const r = route({ excludedChannelIds: ['parent'] });
    const source: LogSource = { channelId: 'thread', parentChannelId: 'parent' };
    expect(routeAccepts(r, source)).toBe(false);
  });

  it('rejects a source channel equal to the destination', () => {
    const r = route({ channelId: 'dest' });
    expect(routeAccepts(r, { channelId: 'dest', parentChannelId: undefined })).toBe(false);
  });

  it('rejects a thread whose parent is the destination', () => {
    const r = route({ channelId: 'parent' });
    expect(routeAccepts(r, { channelId: 'thread', parentChannelId: 'parent' })).toBe(false);
  });

  it('accepts an unrelated channel', () => {
    expect(
      routeAccepts(route(), { channelId: 'other', parentChannelId: undefined }),
    ).toBe(true);
  });

  it('accepts an undefined source for an enabled route and rejects for a disabled one', () => {
    expect(routeAccepts(route({ enabled: true }), undefined)).toBe(true);
    expect(routeAccepts(route({ enabled: false }), undefined)).toBe(false);
  });
});

describe('isSourceExcluded', () => {
  it('is true for a channel on the list', () => {
    expect(isSourceExcluded({ channelId: 'x', parentChannelId: undefined }, (id) => id === 'x')).toBe(
      true,
    );
  });

  it('is true for a thread parent on the list', () => {
    expect(
      isSourceExcluded({ channelId: 'thread', parentChannelId: 'parent' }, (id) => id === 'parent'),
    ).toBe(true);
  });

  it('is false for an undefined source', () => {
    expect(isSourceExcluded(undefined, () => true)).toBe(false);
  });

  it('is false when neither channel nor parent is listed', () => {
    expect(
      isSourceExcluded({ channelId: 'a', parentChannelId: 'b' }, () => false),
    ).toBe(false);
  });
});

describe('routeDedupeKind', () => {
  it('namespaces by route and kind', () => {
    expect(routeDedupeKind('abc', 'message_edit')).toBe('log:rabc:message_edit');
  });
});
