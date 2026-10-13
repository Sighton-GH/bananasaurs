import { describe, expect, it } from 'vitest';
import type { AuditLogEntryEvent } from '../discord/events.js';
import { AUDIT_EVENT_KINDS, auditItemsFor, formatAuditValue } from './audit-items.js';

const GUILD = '000000000000000001';
const ACTOR = '111111111111111111';
const TARGET = '222222222222222222';
const CHANNEL = '333333333333333333';
const AT = 1_760_000_000_000;

function entry(over: Partial<AuditLogEntryEvent> & { action: number }): AuditLogEntryEvent {
  return {
    kind: 'auditLogEntry',
    guildId: GUILD,
    receivedAtMs: 1,
    entryId: '999999999999999999',
    actorId: ACTOR,
    targetId: TARGET,
    reason: undefined,
    changes: [],
    count: undefined,
    channelId: undefined,
    ...over,
  };
}

describe('formatAuditValue', () => {
  it('wraps strings in double quotes', () => {
    expect(formatAuditValue('general')).toBe('"general"');
  });

  it('renders numbers and booleans as-is', () => {
    expect(formatAuditValue(42)).toBe('42');
    expect(formatAuditValue(true)).toBe('true');
    expect(formatAuditValue(false)).toBe('false');
  });

  it('renders null and undefined as (none)', () => {
    expect(formatAuditValue(null)).toBe('(none)');
    expect(formatAuditValue(undefined)).toBe('(none)');
  });

  it('renders arrays and objects as compact JSON', () => {
    expect(formatAuditValue([1, 'a', null] as never)).toBe('[1,"a",null]');
    expect(formatAuditValue({ a: 1, b: [true] })).toBe('{"a":1,"b":[true]}');
  });

  it('truncates results longer than 100 characters with …', () => {
    const long = 'x'.repeat(200);
    const out = formatAuditValue(long);
    expect(out.length).toBe(100);
    expect(out.endsWith('…')).toBe(true);
  });
});

describe('auditItemsFor member actions', () => {
  it('maps 20 to member_kick naming the target and the actor', () => {
    const items = auditItemsFor(entry({ action: 20, changes: [] }));
    expect(items).toHaveLength(1);
    expect(items[0]?.eventKind).toBe('member_kick');
    const view = items[0]?.view(AT);
    expect(view?.headline).toBe(`Kicked: <@${TARGET}> by <@${ACTOR}>`);
    expect(view?.memberId).toBe(TARGET);
    expect(view?.at).toBe(AT);
  });

  it('maps 22 to member_ban', () => {
    const items = auditItemsFor(entry({ action: 22, changes: [] }));
    expect(items[0]?.eventKind).toBe('member_ban');
    expect(items[0]?.view(AT).headline).toBe(`Banned: <@${TARGET}> by <@${ACTOR}>`);
  });

  it('maps 23 to member_unban', () => {
    const items = auditItemsFor(entry({ action: 23, changes: [] }));
    expect(items[0]?.eventKind).toBe('member_unban');
    expect(items[0]?.view(AT).headline).toBe(`Unbanned: <@${TARGET}> by <@${ACTOR}>`);
  });

  it('maps 24 with a timeout string to member_timeout with a discord timestamp', () => {
    const iso = '2030-01-01T00:00:00.000Z';
    const seconds = Math.floor(Date.parse(iso) / 1000);
    const items = auditItemsFor(
      entry({
        action: 24,
        changes: [{ key: 'communication_disabled_until', old: null, new: iso }],
      }),
    );
    expect(items).toHaveLength(1);
    expect(items[0]?.eventKind).toBe('member_timeout');
    expect(items[0]?.view(AT).headline).toBe(
      `Timed out: <@${TARGET}> until <t:${seconds}:f> by <@${ACTOR}>`,
    );
  });

  it('renders an unparsable timeout with formatAuditValue', () => {
    const items = auditItemsFor(
      entry({
        action: 24,
        changes: [{ key: 'communication_disabled_until', old: null, new: 'not-a-date' }],
      }),
    );
    expect(items[0]?.eventKind).toBe('member_timeout');
    expect(items[0]?.view(AT).headline).toContain('until "not-a-date"');
  });

  it('maps 24 with a cleared timeout to member_timeout_removed', () => {
    const items = auditItemsFor(
      entry({
        action: 24,
        changes: [
          { key: 'communication_disabled_until', old: '2030-01-01T00:00:00.000Z', new: null },
        ],
      }),
    );
    expect(items).toHaveLength(1);
    expect(items[0]?.eventKind).toBe('member_timeout_removed');
    expect(items[0]?.view(AT).headline).toBe(`Timeout removed: <@${TARGET}> by <@${ACTOR}>`);
  });

  it('maps 24 without a timeout change to []', () => {
    const items = auditItemsFor(
      entry({ action: 24, changes: [{ key: 'nick', old: 'a', new: 'b' }] }),
    );
    expect(items).toEqual([]);
  });
});

describe('auditItemsFor channel and thread actions', () => {
  it('maps 10 to channel_create with the new name', () => {
    const items = auditItemsFor(
      entry({
        action: 10,
        targetId: CHANNEL,
        changes: [{ key: 'name', old: undefined, new: 'general' }],
      }),
    );
    expect(items[0]?.eventKind).toBe('channel_create');
    expect(items[0]?.view(AT).headline).toBe(
      `Channel created: <#${CHANNEL}> (general) by <@${ACTOR}>`,
    );
    expect(items[0]?.view(AT).memberId).toBeUndefined();
  });

  it('escapes markdown in a channel name', () => {
    const items = auditItemsFor(
      entry({
        action: 10,
        targetId: CHANNEL,
        changes: [{ key: 'name', old: undefined, new: '**x**' }],
      }),
    );
    expect(items[0]?.view(AT).headline).toContain('(\\*\\*x\\*\\*)');
  });

  it('truncates a 150-character channel name to 100 characters', () => {
    const long = 'n'.repeat(150);
    const items = auditItemsFor(
      entry({
        action: 10,
        targetId: CHANNEL,
        changes: [{ key: 'name', old: undefined, new: long }],
      }),
    );
    const headline = items[0]?.view(AT).headline ?? '';
    expect(headline).toContain(`(${'n'.repeat(99)}…)`);
    expect(headline).not.toContain(long);
  });

  it('maps 11 to channel_update with one change per change', () => {
    const items = auditItemsFor(
      entry({
        action: 11,
        targetId: CHANNEL,
        changes: [
          { key: 'name', old: 'old-name', new: 'new-name' },
          { key: 'topic', old: null, new: 'hello' },
        ],
      }),
    );
    expect(items[0]?.eventKind).toBe('channel_update');
    const view = items[0]?.view(AT);
    expect(view?.headline).toBe(`Channel changed: <#${CHANNEL}> by <@${ACTOR}>`);
    expect(view?.changes).toEqual(['name: "old-name" → "new-name"', 'topic: (none) → "hello"']);
  });

  it('caps channel_update at 10 change lines with …and N more', () => {
    const changes = Array.from({ length: 12 }, (_, i) => ({
      key: `field${i}`,
      old: undefined as never,
      new: i as never,
    }));
    const items = auditItemsFor(entry({ action: 11, targetId: CHANNEL, changes }));
    const viewChanges = items[0]?.view(AT).changes ?? [];
    expect(viewChanges).toHaveLength(11);
    expect(viewChanges[viewChanges.length - 1]).toBe('…and 2 more');
  });

  it('skips permission_overwrites in channel_update', () => {
    const items = auditItemsFor(
      entry({
        action: 11,
        targetId: CHANNEL,
        changes: [
          { key: 'permission_overwrites', old: [], new: [] },
          { key: 'name', old: 'a', new: 'b' },
        ],
      }),
    );
    const view = items[0]?.view(AT);
    expect(view?.changes?.join('\n') ?? '').not.toContain('permission_overwrites');
    expect(view?.changes?.join('\n') ?? '').toContain('name:');
  });

  it('maps 12 to channel_delete with the old name', () => {
    const items = auditItemsFor(
      entry({
        action: 12,
        targetId: CHANNEL,
        changes: [{ key: 'name', old: 'general', new: undefined }],
      }),
    );
    expect(items[0]?.eventKind).toBe('channel_delete');
    expect(items[0]?.view(AT).headline).toBe(`Channel deleted: #general by <@${ACTOR}>`);
  });

  it('maps 110 to thread_create', () => {
    const items = auditItemsFor(
      entry({
        action: 110,
        targetId: CHANNEL,
        changes: [{ key: 'name', old: undefined, new: 'help-desk' }],
      }),
    );
    expect(items[0]?.eventKind).toBe('thread_create');
    expect(items[0]?.view(AT).headline).toBe(
      `Thread created: <#${CHANNEL}> (help-desk) by <@${ACTOR}>`,
    );
  });

  it('maps 112 to thread_delete with the old name', () => {
    const items = auditItemsFor(
      entry({
        action: 112,
        targetId: CHANNEL,
        changes: [{ key: 'name', old: 'help-desk', new: undefined }],
      }),
    );
    expect(items[0]?.eventKind).toBe('thread_delete');
    expect(items[0]?.view(AT).headline).toBe(`Thread deleted: help-desk by <@${ACTOR}>`);
  });
});

describe('auditItemsFor guild action', () => {
  it('maps 1 to guild_update with change lines', () => {
    const items = auditItemsFor(
      entry({ action: 1, changes: [{ key: 'name', old: 'old-server', new: 'new-server' }] }),
    );
    expect(items[0]?.eventKind).toBe('guild_update');
    const view = items[0]?.view(AT);
    expect(view?.headline).toBe(`Server settings changed by <@${ACTOR}>`);
    expect(view?.changes).toEqual(['name: "old-server" → "new-server"']);
  });
});

describe('auditItemsFor invite actions', () => {
  it('maps 40 to invite_create with never and unlimited', () => {
    const items = auditItemsFor(
      entry({
        action: 40,
        changes: [
          { key: 'code', old: undefined, new: 'abc123' },
          { key: 'channel_id', old: undefined, new: CHANNEL },
          { key: 'max_age', old: undefined, new: 0 },
          { key: 'max_uses', old: undefined, new: 0 },
        ],
      }),
    );
    expect(items[0]?.eventKind).toBe('invite_create');
    expect(items[0]?.view(AT).headline).toBe(
      `Invite created: discord.gg/abc123 for <#${CHANNEL}> (expires: never, uses: unlimited) by <@${ACTOR}>`,
    );
  });

  it('renders invite expiry in rounded hours and a numeric use count', () => {
    const items = auditItemsFor(
      entry({
        action: 40,
        changes: [
          { key: 'code', old: undefined, new: 'xyz' },
          { key: 'channel_id', old: undefined, new: CHANNEL },
          { key: 'max_age', old: undefined, new: 7200 },
          { key: 'max_uses', old: undefined, new: 5 },
        ],
      }),
    );
    expect(items[0]?.view(AT).headline).toContain('(expires: in 2 hours, uses: 5)');
  });

  it('maps 42 to invite_delete with the old code', () => {
    const items = auditItemsFor(
      entry({ action: 42, changes: [{ key: 'code', old: 'gone123', new: undefined }] }),
    );
    expect(items[0]?.eventKind).toBe('invite_delete');
    expect(items[0]?.view(AT).headline).toBe(`Invite deleted: discord.gg/gone123 by <@${ACTOR}>`);
  });
});

describe('auditItemsFor emoji and sticker actions', () => {
  it('maps 60 to emoji_create', () => {
    const items = auditItemsFor(
      entry({ action: 60, changes: [{ key: 'name', old: undefined, new: 'party' }] }),
    );
    expect(items[0]?.eventKind).toBe('emoji_create');
    expect(items[0]?.view(AT).headline).toBe(`Emoji added: :party: by <@${ACTOR}>`);
  });

  it('maps 61 to emoji_update', () => {
    const items = auditItemsFor(
      entry({ action: 61, changes: [{ key: 'name', old: 'party', new: 'party2' }] }),
    );
    expect(items[0]?.eventKind).toBe('emoji_update');
    expect(items[0]?.view(AT).headline).toBe(`Emoji renamed: :party: → :party2: by <@${ACTOR}>`);
  });

  it('maps 62 to emoji_delete', () => {
    const items = auditItemsFor(
      entry({ action: 62, changes: [{ key: 'name', old: 'party', new: undefined }] }),
    );
    expect(items[0]?.eventKind).toBe('emoji_delete');
    expect(items[0]?.view(AT).headline).toBe(`Emoji removed: :party: by <@${ACTOR}>`);
  });

  it('maps 90 to sticker_create', () => {
    const items = auditItemsFor(
      entry({ action: 90, changes: [{ key: 'name', old: undefined, new: 'cool-sticker' }] }),
    );
    expect(items[0]?.eventKind).toBe('sticker_create');
    expect(items[0]?.view(AT).headline).toBe(`Sticker added: cool-sticker by <@${ACTOR}>`);
  });

  it('maps 91 to sticker_update with change lines', () => {
    const items = auditItemsFor(
      entry({
        action: 91,
        changes: [
          { key: 'name', old: 'old-sticker', new: 'new-sticker' },
          { key: 'description', old: 'a', new: 'b' },
        ],
      }),
    );
    expect(items[0]?.eventKind).toBe('sticker_update');
    const view = items[0]?.view(AT);
    expect(view?.headline).toBe(`Sticker changed: new-sticker by <@${ACTOR}>`);
    expect(view?.changes?.join('\n') ?? '').toContain('description:');
  });

  it('maps 92 to sticker_delete', () => {
    const items = auditItemsFor(
      entry({ action: 92, changes: [{ key: 'name', old: 'old-sticker', new: undefined }] }),
    );
    expect(items[0]?.eventKind).toBe('sticker_delete');
    expect(items[0]?.view(AT).headline).toBe(`Sticker removed: old-sticker by <@${ACTOR}>`);
  });
});

describe('auditItemsFor shared behaviour', () => {
  it('maps unknown action 26 to []', () => {
    expect(auditItemsFor(entry({ action: 26, changes: [] }))).toEqual([]);
  });

  it('renders an unknown member when the actor is missing', () => {
    const items = auditItemsFor(entry({ action: 20, actorId: undefined, changes: [] }));
    expect(items[0]?.view(AT).headline).toBe(`Kicked: <@${TARGET}> by an unknown member`);
    expect(items[0]?.view(AT).headline).not.toContain('<@undefined>');
  });

  it('carries the reason as a quote beside the change lines', () => {
    const items = auditItemsFor(
      entry({
        action: 11,
        targetId: CHANNEL,
        reason: 'spam cleanup',
        changes: [{ key: 'name', old: 'a', new: 'b' }],
      }),
    );
    const view = items[0]?.view(AT);
    expect(view?.headline).toBe(`Channel changed: <#${CHANNEL}> by <@${ACTOR}>`);
    expect(view?.changes).toEqual(['name: "a" → "b"']);
    expect(view?.quote).toEqual({ label: 'Reason', text: 'spam cleanup' });
  });

  it('truncates a long reason to 300 characters ending with …', () => {
    const items = auditItemsFor(entry({ action: 20, reason: 'r'.repeat(400), changes: [] }));
    const quote = items[0]?.view(AT).quote;
    expect(quote?.label).toBe('Reason');
    expect(quote?.text.length).toBe(300);
    expect(quote?.text.endsWith('…')).toBe(true);
  });

  it('never writes attribution inference markers', () => {
    const samples = [
      auditItemsFor(entry({ action: 20, changes: [] }))[0]?.view(AT).headline ?? '',
      auditItemsFor(
        entry({
          action: 11,
          targetId: CHANNEL,
          changes: [{ key: 'name', old: 'a', new: 'b' }],
        }),
      )[0]?.view(AT).headline ?? '',
    ];
    for (const headline of samples) {
      expect(headline.toLowerCase()).not.toContain('infer');
    }
  });

  it('lists every mapped kind', () => {
    expect([...AUDIT_EVENT_KINDS].sort()).toEqual(
      [
        'member_kick',
        'member_ban',
        'member_unban',
        'member_timeout',
        'member_timeout_removed',
        'channel_create',
        'channel_update',
        'channel_delete',
        'thread_create',
        'thread_delete',
        'guild_update',
        'invite_create',
        'invite_delete',
        'emoji_create',
        'emoji_update',
        'emoji_delete',
        'sticker_create',
        'sticker_update',
        'sticker_delete',
      ].sort(),
    );
  });
});
