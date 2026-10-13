import { describe, expect, it } from 'vitest';
import { buildRows } from './rows.js';
import type { ArchiveChannelStatus, GuildChannelInfo } from '../../api/ops.js';

const channels: GuildChannelInfo[] = [
  { channelId: 'cat', name: 'Community', kind: 'category' },
  { channelId: 'child', name: 'general', kind: 'text', parentId: 'cat' },
  { channelId: 'orphan', name: 'ungrouped', kind: 'text' },
];
const arch = (
  channelId: string,
  scopeKind: 'category' | 'channel' | 'derived',
  collecting = true,
): ArchiveChannelStatus => ({
  channelId,
  scopeKind,
  collecting,
  attachmentPolicy: 'none',
  enabledAt: 1,
  cursorMessageId: undefined,
  backfillState: 'done',
  messageCount: 0,
  ...(scopeKind === 'derived' ? { derivedFrom: 'cat' } : {}),
});

describe('Permissions effective rows', () => {
  it('keeps category-first order, child depth and ungrouped channels', () => {
    const rows = buildRows(channels, [], [], [], []);
    expect(rows.map((row) => [row.id, row.depth])).toEqual([
      ['cat', 0],
      ['child', 1],
      ['orphan', 0],
    ]);
    expect(rows[1]).toMatchObject({ archive: 'off', read: 'off', send: 'off' });
  });
  it('inherits all category scopes, with the category name', () => {
    const rows = buildRows(
      channels,
      [arch('cat', 'category')],
      [{ channelId: 'cat', scopeKind: 'category', addedByAccountId: 'a', addedAt: 1 }],
      [{ channelId: 'cat', scopeKind: 'category', addedAt: 1 }],
      [],
    );
    expect(rows[1]).toMatchObject({
      archive: 'via-category',
      read: 'via-category',
      send: 'via-category',
      archiveVia: 'Community',
      readVia: 'Community',
      sendVia: 'Community',
    });
  });
  it('own channel scopes beat inherited values and own pause vetoes collecting category', () => {
    const rows = buildRows(
      channels,
      [arch('cat', 'category'), arch('child', 'channel', false)],
      [{ channelId: 'child', scopeKind: 'channel', addedByAccountId: 'a', addedAt: 1 }],
      [{ channelId: 'child', scopeKind: 'channel', addedAt: 1 }],
      [],
    );
    expect(rows[1]).toMatchObject({ archive: 'paused', read: 'on', send: 'on' });
    expect(rows[1]?.archiveVia).toBeUndefined();
  });
  it('exclusion beats every own/inherited grant; paused category remains inherited pause', () => {
    const excluded = buildRows(
      channels,
      [arch('cat', 'category'), arch('child', 'channel')],
      [{ channelId: 'child', addedByAccountId: 'a', addedAt: 1 }],
      [{ channelId: 'child', scopeKind: 'channel', addedAt: 1 }],
      ['child'],
    );
    expect(excluded[1]).toMatchObject({
      excluded: true,
      archive: 'excluded',
      read: 'excluded',
      send: 'excluded',
    });
    expect(
      buildRows(
        channels,
        [arch('cat', 'category', false), arch('child', 'derived')],
        [],
        [],
        [],
      )[1],
    ).toMatchObject({ archive: 'paused-via-category', archiveVia: 'Community' });
  });
});
