import { describe, expect, it } from 'vitest';
import { pino } from 'pino';
import { createLoggingSubscriber, createLogPoster, type LoggingPorts } from './subscriber.js';
import type { LogRoute } from './routing.js';
import type { MemberSnapshotLike } from './member-changes.js';
import type {
  AuditLogEntryEvent,
  AutoModerationEvent,
  MemberEvent,
  MessageBulkDeleteEvent,
  MessageEvent,
} from '../discord/events.js';
import type { OutgoingMessage } from '../discord/port.js';
import { cardCustomIds, cardTexts } from '../ui/discord/inspect.js';

const GUILD = '111111111111111111';
const SOURCE = '222222222222222222';
const DEST_A = '333333333333333333';
const DEST_B = '444444444444444444';
const logger = pino({ level: 'silent' });

interface SentCard {
  channelId: string;
  message: OutgoingMessage;
}

const sentMessage = (sent: SentCard[], index: number): OutgoingMessage => {
  const card = sent[index];
  if (card === undefined) throw new Error(`expected a sent card at index ${index}`);
  return card.message;
};

const makeRoute = (over: Partial<LogRoute> & { routeId: string }): LogRoute => ({
  channelId: DEST_A,
  includeContent: true,
  enabled: true,
  excludedChannelIds: [],
  ...over,
});

function makeFake() {
  const claims = new Set<string>();
  const sent: SentCard[] = [];
  const failing = new Set<string>();
  const excluded = new Set<string>();
  const enqueued: { dedupeKey: string; payload: string; runAfter: number }[] = [];
  let routes: LogRoute[] = [];
  // The event kinds each route includes, like the real
  // `loggingRepo.listEnabledRoutesFor` filtering. A route with no entry
  // matches every kind, preserving the older tests' behaviour.
  const routeKinds = new Map<string, readonly string[]>();
  const snapshots = new Map<string, MemberSnapshotLike>();
  const ports: LoggingPorts = {
    guildId: GUILD,
    listEnabledRoutesFor: (eventKind) =>
      routes.filter((r) => {
        const kinds = routeKinds.get(r.routeId);
        return kinds === undefined || kinds.includes(eventKind);
      }),
    isChannelExcluded: (id) => excluded.has(id),
    listEnabledLogChannels: () => [...new Set(routes.map((r) => r.channelId))],
    claim: ({ eventKind, fingerprint }) => {
      const key = `${eventKind}:${fingerprint}`;
      if (claims.has(key)) return false;
      claims.add(key);
      return true;
    },
    release: ({ eventKind, fingerprint }) => {
      claims.delete(`${eventKind}:${fingerprint}`);
    },
    sendMessage: async (channelId, message) => {
      sent.push({ channelId, message });
      if (failing.has(channelId)) throw new Error(`send failed: ${channelId}`);
      return undefined;
    },
    enqueueDeletionAttribution: (input) => {
      enqueued.push(input);
      return { enqueued: true };
    },
    getMemberSnapshot: (userId) => snapshots.get(userId),
    saveMemberSnapshot: (snapshot) => {
      snapshots.set(snapshot.userId, { ...snapshot, roleIds: [...snapshot.roleIds] });
    },
    deleteMemberSnapshot: (userId) => {
      snapshots.delete(userId);
    },
    logger,
    now: () => 0,
  };
  return {
    ports,
    sent,
    failing,
    excluded,
    enqueued,
    claims,
    snapshots,
    setRoutes: (next: LogRoute[]) => {
      routes = next;
    },
    setRouteKinds: (routeId: string, kinds: readonly string[]) => {
      routeKinds.set(routeId, kinds);
    },
  };
}

const AUTHOR = '555555555555555555';
const MESSAGE = '444444444444444444';

const editEvent = (over: Partial<MessageEvent> = {}): MessageEvent => ({
  kind: 'messageUpdate',
  guildId: GUILD,
  receivedAtMs: 1,
  channelId: SOURCE,
  parentChannelId: undefined,
  categoryId: undefined,
  isPrivateThread: false,
  messageId: MESSAGE,
  authorId: AUTHOR,
  authorDisplayName: undefined,
  authorIsBot: false,
  content: 'edited text',
  editedTimestampMs: 5,
  mentionedUserIds: [],
  mentionedRoleIds: [],
  mentionsEveryone: false,
  attachments: [],
  ...over,
});

describe('logging subscriber fan-out', () => {
  it('sends nothing when no routes match', async () => {
    const fake = makeFake();
    fake.setRoutes([]);
    await createLoggingSubscriber(fake.ports).handle(editEvent());
    expect(fake.sent).toHaveLength(0);
  });

  it('posts once to each of two routes with the same kind', async () => {
    const fake = makeFake();
    fake.setRoutes([
      makeRoute({ routeId: 'a', channelId: DEST_A }),
      makeRoute({ routeId: 'b', channelId: DEST_B }),
    ]);
    await createLoggingSubscriber(fake.ports).handle(editEvent());
    expect(fake.sent.map((s) => s.channelId).sort()).toEqual([DEST_A, DEST_B].sort());
  });

  it('every log post disables mention parsing, so logged text never pings', async () => {
    const fake = makeFake();
    fake.setRoutes([
      makeRoute({ routeId: 'a', channelId: DEST_A }),
      makeRoute({ routeId: 'b', channelId: DEST_B }),
    ]);
    await createLoggingSubscriber(fake.ports).handle(
      editEvent({ content: 'hello @everyone <@&123> <@456>' }),
    );
    expect(fake.sent.length).toBeGreaterThan(0);
    for (const card of fake.sent) {
      expect(card.message.allowedMentions).toEqual({ parse: [] });
    }
  });

  it('posts a Components V2 card with the eyebrow, the headline and a jump link', async () => {
    const fake = makeFake();
    fake.setRoutes([makeRoute({ routeId: 'a', channelId: DEST_A })]);
    await createLoggingSubscriber(fake.ports).handle(editEvent());
    expect(fake.sent).toHaveLength(1);
    const message = sentMessage(fake.sent, 0);
    expect(message.flags).toBe(32768);
    expect(message.allowedMentions).toEqual({ parse: [] });
    const text = cardTexts(message.components ?? []);
    expect(text).toContain('-# ✏️ MESSAGE EDITED');
    expect(text).toContain(`<@${AUTHOR}> edited a message in <#${SOURCE}>`);
    expect(text).toContain('edited text');
    expect(text).toContain(`https://discord.com/channels/${GUILD}/${SOURCE}/${MESSAGE}`);
    expect(cardCustomIds(message.components ?? [])).toEqual([
      `bs.mod:delete:${SOURCE}:${MESSAGE}:${AUTHOR}`,
      `bs.mod:warn:${AUTHOR}`,
      `bs.mod:timeout:${AUTHOR}`,
    ]);
  });

  it('skips a disabled route', async () => {
    const fake = makeFake();
    fake.setRoutes([
      makeRoute({ routeId: 'a', channelId: DEST_A, enabled: false }),
      makeRoute({ routeId: 'b', channelId: DEST_B }),
    ]);
    await createLoggingSubscriber(fake.ports).handle(editEvent());
    expect(fake.sent.map((s) => s.channelId)).toEqual([DEST_B]);
  });

  it('a per-route exclusion skips only that route', async () => {
    const fake = makeFake();
    fake.setRoutes([
      makeRoute({ routeId: 'a', channelId: DEST_A, excludedChannelIds: [SOURCE] }),
      makeRoute({ routeId: 'b', channelId: DEST_B }),
    ]);
    await createLoggingSubscriber(fake.ports).handle(editEvent());
    expect(fake.sent.map((s) => s.channelId)).toEqual([DEST_B]);
  });

  it('a guild-wide exclusion of the thread parent skips all routes', async () => {
    const fake = makeFake();
    fake.setRoutes([
      makeRoute({ routeId: 'a', channelId: DEST_A }),
      makeRoute({ routeId: 'b', channelId: DEST_B }),
    ]);
    fake.excluded.add('parent-channel');
    await createLoggingSubscriber(fake.ports).handle(
      editEvent({ channelId: 'thread-channel', parentChannelId: 'parent-channel' }),
    );
    expect(fake.sent).toHaveLength(0);
  });

  it('does not post to a route whose destination is the source channel', async () => {
    const fake = makeFake();
    fake.setRoutes([
      makeRoute({ routeId: 'a', channelId: SOURCE }),
      makeRoute({ routeId: 'b', channelId: DEST_B }),
    ]);
    await createLoggingSubscriber(fake.ports).handle(editEvent());
    expect(fake.sent.map((s) => s.channelId)).toEqual([DEST_B]);
  });

  it('renders content per route', async () => {
    const fake = makeFake();
    fake.setRoutes([
      makeRoute({ routeId: 'a', channelId: DEST_A, includeContent: false }),
      makeRoute({ routeId: 'b', channelId: DEST_B, includeContent: true }),
    ]);
    await createLoggingSubscriber(fake.ports).handle(editEvent({ content: 'secret words' }));
    const byChannel = new Map(
      fake.sent.map((s) => [s.channelId, cardTexts(s.message.components ?? [])]),
    );
    expect(byChannel.get(DEST_A)).not.toContain('secret words');
    expect(byChannel.get(DEST_B)).toContain('secret words');
  });

  it('a redelivered event posts nothing new', async () => {
    const fake = makeFake();
    fake.setRoutes([
      makeRoute({ routeId: 'a', channelId: DEST_A }),
      makeRoute({ routeId: 'b', channelId: DEST_B }),
    ]);
    const subscriber = createLoggingSubscriber(fake.ports);
    const event = editEvent();
    await subscriber.handle(event);
    await subscriber.handle(event);
    expect(fake.sent).toHaveLength(2);
  });

  it('a send failure on route 1 still posts route 2, releases only route 1, and rejects', async () => {
    const fake = makeFake();
    fake.setRoutes([
      makeRoute({ routeId: 'a', channelId: DEST_A }),
      makeRoute({ routeId: 'b', channelId: DEST_B }),
    ]);
    fake.failing.add(DEST_A);
    const subscriber = createLoggingSubscriber(fake.ports);
    const event = editEvent();
    await expect(subscriber.handle(event)).rejects.toThrow();
    // Both routes attempted; only route 2's delivery stands.
    expect(fake.sent).toHaveLength(2);
    expect(fake.claims.has('log:ra:message_edit')).toBe(false);
    expect(fake.claims.size).toBe(1);

    // A retry posts only to route 1.
    fake.failing.clear();
    await subscriber.handle(event);
    expect(fake.sent).toHaveLength(3);
    expect(fake.sent[2]?.channelId).toBe(DEST_A);
  });

  it('posts nothing for a bot-authored messageCreate', async () => {
    const fake = makeFake();
    fake.setRoutes([makeRoute({ routeId: 'a', channelId: DEST_A })]);
    await createLoggingSubscriber(fake.ports).handle({
      ...editEvent(),
      kind: 'messageCreate',
      authorIsBot: true,
      editedTimestampMs: undefined,
    });
    expect(fake.sent).toHaveLength(0);
  });
});

const MEMBER = '666666666666666666';

const memberProfile = (nickname: string | undefined) => ({
  username: 'member',
  globalName: undefined,
  nickname,
  avatarHash: undefined,
  guildAvatarHash: undefined,
});

const memberUpdate = (over: Partial<MemberEvent> = {}): MemberEvent => ({
  kind: 'memberUpdate',
  guildId: GUILD,
  receivedAtMs: 1_000,
  userId: MEMBER,
  roleIds: [],
  previousRoleIds: undefined,
  joinedAtMs: undefined,
  profile: memberProfile(undefined),
  previousMember: undefined,
  ...over,
});

const memberJoin = (over: Partial<MemberEvent> = {}): MemberEvent => ({
  kind: 'memberAdd',
  guildId: GUILD,
  receivedAtMs: 1_000,
  userId: MEMBER,
  roleIds: [],
  previousRoleIds: undefined,
  joinedAtMs: 100,
  profile: memberProfile(undefined),
  previousMember: undefined,
  ...over,
});

const memberLeave = (over: Partial<MemberEvent> = {}): MemberEvent => ({
  kind: 'memberRemove',
  guildId: GUILD,
  receivedAtMs: 1_000,
  userId: MEMBER,
  roleIds: [],
  previousRoleIds: undefined,
  joinedAtMs: 100,
  ...over,
});

describe('member snapshots and change lines', () => {
  it('a first-seen update with a partial before posts nothing but saves the baseline', async () => {
    const fake = makeFake();
    fake.setRoutes([makeRoute({ routeId: 'n', channelId: DEST_A })]);
    fake.setRouteKinds('n', ['member_nickname_changed']);
    await createLoggingSubscriber(fake.ports).handle(
      memberUpdate({ receivedAtMs: 1_000, profile: memberProfile('Nick') }),
    );
    expect(fake.sent).toHaveLength(0);
    expect(fake.snapshots.get(MEMBER)?.nickname).toBe('Nick');
  });

  it('saves nothing when no route wants member changes', async () => {
    const fake = makeFake();
    fake.setRoutes([makeRoute({ routeId: 'j', channelId: DEST_A })]);
    fake.setRouteKinds('j', ['member_join']);
    await createLoggingSubscriber(fake.ports).handle(
      memberUpdate({ receivedAtMs: 1_000, profile: memberProfile('Nick') }),
    );
    expect(fake.sent).toHaveLength(0);
    expect(fake.snapshots.has(MEMBER)).toBe(false);
  });

  it('an update with no member-change route deletes an existing snapshot', async () => {
    const fake = makeFake();
    fake.setRoutes([makeRoute({ routeId: 'n', channelId: DEST_A })]);
    fake.setRouteKinds('n', ['member_nickname_changed']);
    const subscriber = createLoggingSubscriber(fake.ports);
    await subscriber.handle(memberUpdate({ receivedAtMs: 1_000, profile: memberProfile('Nick') }));
    expect(fake.snapshots.has(MEMBER)).toBe(true);

    // The owner turns every member-change action off: the next sighting of
    // the member drops the record instead of refreshing it.
    fake.setRouteKinds('n', ['member_join']);
    await subscriber.handle(memberUpdate({ receivedAtMs: 2_000, profile: memberProfile('Nick') }));
    expect(fake.sent).toHaveLength(0);
    expect(fake.snapshots.has(MEMBER)).toBe(false);
  });

  it('a join saves the baseline when a member-change route exists', async () => {
    const fake = makeFake();
    fake.setRoutes([makeRoute({ routeId: 'n', channelId: DEST_A })]);
    fake.setRouteKinds('n', ['member_nickname_changed']);
    await createLoggingSubscriber(fake.ports).handle(
      memberJoin({ receivedAtMs: 1_000, profile: memberProfile('Nick') }),
    );
    // No member_join route, so nothing posts — but the baseline is kept.
    expect(fake.sent).toHaveLength(0);
    expect(fake.snapshots.get(MEMBER)?.nickname).toBe('Nick');
  });

  it('a join saves no snapshot when no route wants member changes', async () => {
    const fake = makeFake();
    fake.setRoutes([makeRoute({ routeId: 'j', channelId: DEST_A })]);
    fake.setRouteKinds('j', ['member_join']);
    await createLoggingSubscriber(fake.ports).handle(
      memberJoin({ receivedAtMs: 1_000, profile: memberProfile('Nick') }),
    );
    // The join line still posts to its own route — only the snapshot is skipped.
    expect(fake.sent).toHaveLength(1);
    expect(fake.snapshots.has(MEMBER)).toBe(false);
  });

  it('a join with no member-change route deletes an existing snapshot', async () => {
    const fake = makeFake();
    fake.setRoutes([makeRoute({ routeId: 'n', channelId: DEST_A })]);
    fake.setRouteKinds('n', ['member_nickname_changed']);
    const subscriber = createLoggingSubscriber(fake.ports);
    await subscriber.handle(memberJoin({ receivedAtMs: 1_000, profile: memberProfile('Nick') }));
    expect(fake.snapshots.has(MEMBER)).toBe(true);

    // The owner turns every member-change action off: the next sighting of
    // the member drops the record instead of refreshing it.
    fake.setRouteKinds('n', ['member_join']);
    await subscriber.handle(memberJoin({ receivedAtMs: 2_000, profile: memberProfile('Nick') }));
    expect(fake.snapshots.has(MEMBER)).toBe(false);
  });

  it('a join whose send fails saves no snapshot', async () => {
    const fake = makeFake();
    fake.setRoutes([makeRoute({ routeId: 'j', channelId: DEST_A })]);
    fake.setRouteKinds('j', ['member_join', 'member_nickname_changed']);
    fake.failing.add(DEST_A);
    await expect(
      createLoggingSubscriber(fake.ports).handle(
        memberJoin({ receivedAtMs: 1_000, profile: memberProfile('Nick') }),
      ),
    ).rejects.toThrow();
    expect(fake.sent).toHaveLength(1);
    expect(fake.snapshots.has(MEMBER)).toBe(false);
  });

  it('a later update with a new nickname posts one card and updates the snapshot', async () => {
    const fake = makeFake();
    fake.setRoutes([makeRoute({ routeId: 'n', channelId: DEST_A })]);
    fake.setRouteKinds('n', ['member_nickname_changed']);
    const subscriber = createLoggingSubscriber(fake.ports);
    await subscriber.handle(memberUpdate({ receivedAtMs: 1_000, profile: memberProfile('Old') }));
    await subscriber.handle(memberUpdate({ receivedAtMs: 2_000, profile: memberProfile('New') }));
    expect(fake.sent).toHaveLength(1);
    const text = cardTexts(sentMessage(fake.sent, 0).components ?? []);
    expect(text).toContain('changed nickname');
    expect(text).toContain(`<@${MEMBER}>`);
    expect(text).toContain('Old → New');
    expect(sentMessage(fake.sent, 0).allowedMentions).toEqual({ parse: [] });
    expect(sentMessage(fake.sent, 0).flags).toBe(32768);
    expect(fake.snapshots.get(MEMBER)?.nickname).toBe('New');
  });

  it('replaying the identical event posts nothing — the snapshot now matches', async () => {
    const fake = makeFake();
    fake.setRoutes([makeRoute({ routeId: 'n', channelId: DEST_A })]);
    fake.setRouteKinds('n', ['member_nickname_changed']);
    const subscriber = createLoggingSubscriber(fake.ports);
    await subscriber.handle(memberUpdate({ receivedAtMs: 1_000, profile: memberProfile('Old') }));
    const change = memberUpdate({ receivedAtMs: 2_000, profile: memberProfile('New') });
    await subscriber.handle(change);
    expect(fake.sent).toHaveLength(1);
    await subscriber.handle(change);
    expect(fake.sent).toHaveLength(1);
  });

  it('a failed send leaves the snapshot unchanged and a retry posts only to the failed route', async () => {
    const fake = makeFake();
    fake.setRoutes([
      makeRoute({ routeId: 'a', channelId: DEST_A }),
      makeRoute({ routeId: 'b', channelId: DEST_B }),
    ]);
    fake.setRouteKinds('a', ['member_nickname_changed']);
    fake.setRouteKinds('b', ['member_nickname_changed']);
    const subscriber = createLoggingSubscriber(fake.ports);
    await subscriber.handle(memberUpdate({ receivedAtMs: 1_000, profile: memberProfile('Old') }));
    expect(fake.sent).toHaveLength(0);

    fake.failing.add(DEST_A);
    const change = memberUpdate({ receivedAtMs: 2_000, profile: memberProfile('New') });
    await expect(subscriber.handle(change)).rejects.toThrow();
    expect(fake.sent).toHaveLength(2);
    // The replay must see the same baseline, so the snapshot is untouched.
    expect(fake.snapshots.get(MEMBER)?.nickname).toBe('Old');

    fake.failing.clear();
    await subscriber.handle(change);
    expect(fake.sent).toHaveLength(3);
    expect(fake.sent[2]?.channelId).toBe(DEST_A);
    expect(fake.snapshots.get(MEMBER)?.nickname).toBe('New');
  });

  it('an A→B→A→B nickname sequence posts four cards', async () => {
    const fake = makeFake();
    fake.setRoutes([makeRoute({ routeId: 'n', channelId: DEST_A })]);
    fake.setRouteKinds('n', ['member_nickname_changed']);
    const subscriber = createLoggingSubscriber(fake.ports);
    await subscriber.handle(memberJoin({ receivedAtMs: 1_000, profile: memberProfile('Zero') }));
    expect(fake.sent).toHaveLength(0);

    let at = 2_000;
    for (const nickname of ['A', 'B', 'A', 'B']) {
      await subscriber.handle(memberUpdate({ receivedAtMs: at, profile: memberProfile(nickname) }));
      at += 1_000;
    }
    expect(fake.sent).toHaveLength(4);
    expect(fake.sent.map((s) => cardTexts(s.message.components ?? []))).toEqual([
      expect.stringContaining('Zero → A'),
      expect.stringContaining('A → B'),
      expect.stringContaining('B → A'),
      expect.stringContaining('A → B'),
    ]);
  });

  it('a leave posts the leave card and deletes the snapshot', async () => {
    const fake = makeFake();
    fake.setRoutes([makeRoute({ routeId: 'l', channelId: DEST_A })]);
    fake.setRouteKinds('l', ['member_leave', 'member_nickname_changed']);
    const subscriber = createLoggingSubscriber(fake.ports);
    await subscriber.handle(memberJoin({ receivedAtMs: 1_000, profile: memberProfile('Nick') }));
    expect(fake.snapshots.has(MEMBER)).toBe(true);

    await subscriber.handle(memberLeave({ receivedAtMs: 2_000 }));
    const text = cardTexts(sentMessage(fake.sent, fake.sent.length - 1).components ?? []);
    expect(text).toContain(`<@${MEMBER}>`);
    expect(text).toContain('left');
    expect(fake.snapshots.has(MEMBER)).toBe(false);
  });

  it('a leave whose send fails still deletes the snapshot, and the handler still rejects', async () => {
    const fake = makeFake();
    fake.setRoutes([makeRoute({ routeId: 'l', channelId: DEST_A })]);
    fake.setRouteKinds('l', ['member_leave', 'member_nickname_changed']);
    const subscriber = createLoggingSubscriber(fake.ports);
    await subscriber.handle(memberJoin({ receivedAtMs: 1_000, profile: memberProfile('Nick') }));
    expect(fake.snapshots.has(MEMBER)).toBe(true);

    fake.failing.add(DEST_A);
    await expect(subscriber.handle(memberLeave({ receivedAtMs: 2_000 }))).rejects.toThrow();
    expect(fake.snapshots.has(MEMBER)).toBe(false);
  });
});

const auditEntry = (
  over: Partial<AuditLogEntryEvent> & { action: number },
): AuditLogEntryEvent => ({
  kind: 'auditLogEntry',
  guildId: GUILD,
  receivedAtMs: 1,
  entryId: '999999999999999999',
  actorId: '666666666666666666',
  targetId: '777777777777777777',
  reason: undefined,
  changes: [],
  count: undefined,
  channelId: undefined,
  ...over,
});

const bulkDelete = (over: Partial<MessageBulkDeleteEvent> = {}): MessageBulkDeleteEvent => ({
  kind: 'messageDeleteBulk',
  guildId: GUILD,
  receivedAtMs: 1,
  channelId: SOURCE,
  parentChannelId: undefined,
  categoryId: undefined,
  isPrivateThread: false,
  messageIds: ['555555555555555555', '666666666666666666', '777777777777777777'],
  ...over,
});

describe('audit-log entries and bulk deletes', () => {
  it('posts one kick card to a member_kick route', async () => {
    const fake = makeFake();
    fake.setRoutes([makeRoute({ routeId: 'a', channelId: DEST_A })]);
    fake.setRouteKinds('a', ['member_kick']);
    await createLoggingSubscriber(fake.ports).handle(auditEntry({ action: 20 }));
    expect(fake.sent).toHaveLength(1);
    expect(fake.sent[0]?.channelId).toBe(DEST_A);
    const text = cardTexts(sentMessage(fake.sent, 0).components ?? []);
    expect(text).toContain('Kicked: <@777777777777777777>');
    expect(sentMessage(fake.sent, 0).allowedMentions).toEqual({ parse: [] });
    expect(sentMessage(fake.sent, 0).flags).toBe(32768);
  });

  it('replaying the same entry posts nothing', async () => {
    const fake = makeFake();
    fake.setRoutes([makeRoute({ routeId: 'a', channelId: DEST_A })]);
    fake.setRouteKinds('a', ['member_kick']);
    const subscriber = createLoggingSubscriber(fake.ports);
    const event = auditEntry({ action: 20 });
    await subscriber.handle(event);
    await subscriber.handle(event);
    expect(fake.sent).toHaveLength(1);
  });

  it('an entry with no handled kind posts nothing', async () => {
    const fake = makeFake();
    fake.setRoutes([makeRoute({ routeId: 'a', channelId: DEST_A })]);
    await createLoggingSubscriber(fake.ports).handle(auditEntry({ action: 26 }));
    expect(fake.sent).toHaveLength(0);
  });

  it('a purge posts one card per matching route', async () => {
    const fake = makeFake();
    fake.setRoutes([
      makeRoute({ routeId: 'a', channelId: DEST_A }),
      makeRoute({ routeId: 'b', channelId: DEST_B }),
    ]);
    fake.setRouteKinds('a', ['message_bulk_delete']);
    fake.setRouteKinds('b', ['message_bulk_delete']);
    await createLoggingSubscriber(fake.ports).handle(bulkDelete());
    expect(fake.sent).toHaveLength(2);
    for (const card of fake.sent) {
      expect(cardTexts(card.message.components ?? [])).toContain(
        `3 messages were purged in <#${SOURCE}>`,
      );
      expect(card.message.allowedMentions).toEqual({ parse: [] });
    }
  });

  it('a purge in a route-excluded channel is skipped for that route', async () => {
    const fake = makeFake();
    fake.setRoutes([
      makeRoute({ routeId: 'a', channelId: DEST_A, excludedChannelIds: [SOURCE] }),
      makeRoute({ routeId: 'b', channelId: DEST_B }),
    ]);
    fake.setRouteKinds('a', ['message_bulk_delete']);
    fake.setRouteKinds('b', ['message_bulk_delete']);
    await createLoggingSubscriber(fake.ports).handle(bulkDelete());
    expect(fake.sent.map((s) => s.channelId)).toEqual([DEST_B]);
  });

  it('replaying the same purge posts nothing', async () => {
    const fake = makeFake();
    fake.setRoutes([makeRoute({ routeId: 'a', channelId: DEST_A })]);
    fake.setRouteKinds('a', ['message_bulk_delete']);
    const subscriber = createLoggingSubscriber(fake.ports);
    const event = bulkDelete();
    await subscriber.handle(event);
    await subscriber.handle(event);
    expect(fake.sent).toHaveLength(1);
  });
});

const automodEvent = (over: Partial<AutoModerationEvent> = {}): AutoModerationEvent => ({
  kind: 'autoModerationAction',
  guildId: GUILD,
  receivedAtMs: 1,
  ruleId: '888888888888888888',
  triggerType: 'keyword',
  userId: MEMBER,
  actionType: 'block',
  channelId: SOURCE,
  messageId: MESSAGE,
  alertMessageId: undefined,
  content: '',
  matchedKeyword: undefined,
  matchedContent: undefined,
  ...over,
});

describe('native automod actions', () => {
  it('posts a card with the action words, the rule and moderator buttons', async () => {
    const fake = makeFake();
    fake.setRoutes([makeRoute({ routeId: 'a', channelId: DEST_A })]);
    fake.setRouteKinds('a', ['automod_action']);
    await createLoggingSubscriber(fake.ports).handle(automodEvent());
    expect(fake.sent).toHaveLength(1);
    const message = sentMessage(fake.sent, 0);
    const text = cardTexts(message.components ?? []);
    expect(text).toContain('-# 🛡️ DISCORD AUTOMOD');
    expect(text).toContain(`Discord AutoMod acted on a message by <@${MEMBER}>`);
    expect(text).toContain('Action: Blocked the message');
    expect(text).toContain('-# Rule 888888888888888888');
    expect(cardCustomIds(message.components ?? [])).toEqual([
      `bs.mod:delete:${SOURCE}:${MESSAGE}:${MEMBER}`,
      `bs.mod:warn:${MEMBER}`,
      `bs.mod:timeout:${MEMBER}`,
    ]);
  });

  it('names the other actions in words, never raw codes', async () => {
    const fake = makeFake();
    fake.setRoutes([makeRoute({ routeId: 'a', channelId: DEST_A })]);
    fake.setRouteKinds('a', ['automod_action']);
    const subscriber = createLoggingSubscriber(fake.ports);
    const cases = [
      ['alert', 'Sent an alert'],
      ['timeout', 'Timed the member out'],
      ['block_interaction', 'Blocked an interaction'],
    ] as const;
    let at = 2;
    for (const [actionType] of cases) {
      await subscriber.handle(
        automodEvent({
          actionType,
          receivedAtMs: at,
          ruleId: '888888888888888888',
        }),
      );
      at += 1;
    }
    const texts = fake.sent.map((s) => cardTexts(s.message.components ?? []));
    // Each card carries its own fingerprint, so all three post.
    expect(texts).toEqual([
      expect.stringContaining('Sent an alert'),
      expect.stringContaining('Timed the member out'),
      expect.stringContaining('Blocked an interaction'),
    ]);
  });
});

describe('No-access veto through the category (ADR 0126)', () => {
  const THREAD = '555555555555555555';
  const PARENT = '666666666666666666';
  const CATEGORY = '777777777777777777';

  const threadEvent = (over: Partial<MessageEvent> = {}): MessageEvent => ({
    ...editEvent(),
    channelId: THREAD,
    parentChannelId: PARENT,
    categoryId: CATEGORY,
    ...over,
  });

  it('logs a messageCreate in a thread when nothing above it is excluded (control)', async () => {
    const fake = makeFake();
    fake.setRoutes([makeRoute({ routeId: 'a', channelId: DEST_A })]);
    await createLoggingSubscriber(fake.ports).handle(
      threadEvent({ kind: 'messageCreate', editedTimestampMs: undefined }),
    );
    expect(fake.sent).toHaveLength(1);
  });

  it('does not log a messageCreate in a thread whose category is excluded', async () => {
    const fake = makeFake();
    fake.setRoutes([makeRoute({ routeId: 'a', channelId: DEST_A })]);
    fake.excluded.add(CATEGORY);
    await createLoggingSubscriber(fake.ports).handle(
      threadEvent({ kind: 'messageCreate', editedTimestampMs: undefined }),
    );
    expect(fake.sent).toHaveLength(0);
    expect(fake.enqueued).toHaveLength(0);
  });

  it('does not log a messageUpdate in a thread whose category is excluded', async () => {
    const fake = makeFake();
    fake.setRoutes([makeRoute({ routeId: 'a', channelId: DEST_A })]);
    fake.excluded.add(CATEGORY);
    await createLoggingSubscriber(fake.ports).handle(threadEvent({ kind: 'messageUpdate' }));
    expect(fake.sent).toHaveLength(0);
    expect(fake.enqueued).toHaveLength(0);
  });

  it('enqueues no attribution job for a messageDelete in a thread whose category is excluded', async () => {
    const fake = makeFake();
    fake.setRoutes([makeRoute({ routeId: 'a', channelId: DEST_A })]);
    fake.excluded.add(CATEGORY);
    await createLoggingSubscriber(fake.ports).handle(threadEvent({ kind: 'messageDelete' }));
    expect(fake.sent).toHaveLength(0);
    expect(fake.enqueued).toHaveLength(0);
  });
});

describe('createLogPoster', () => {
  const warnItem = () => ({
    eventKind: 'member_warn',
    fingerprint: 'interaction-1',
    source: undefined,
    view: () => ({
      kind: 'member_warn',
      headline: 'Warned: <@777777777777777777> by <@666666666666666666>',
      at: 0,
    }),
  });

  it('posts through every matching route and dedupes the replay', async () => {
    const fake = makeFake();
    fake.setRoutes([
      makeRoute({ routeId: 'a', channelId: DEST_A }),
      makeRoute({ routeId: 'b', channelId: DEST_B }),
    ]);
    const poster = createLogPoster(fake.ports);
    await poster.post(warnItem());
    expect(fake.sent.map((s) => s.channelId).sort()).toEqual([DEST_A, DEST_B].sort());
    expect(fake.sent[0]?.message.allowedMentions).toEqual({ parse: [] });
    expect(fake.sent[0]?.message.flags).toBe(32768);

    // The same warn id replays (a retried hook call): nothing new posts.
    await poster.post(warnItem());
    expect(fake.sent).toHaveLength(2);
  });

  it('claims per route, so a retry after a failure posts only to the failed route', async () => {
    const fake = makeFake();
    fake.setRoutes([
      makeRoute({ routeId: 'a', channelId: DEST_A }),
      makeRoute({ routeId: 'b', channelId: DEST_B }),
    ]);
    fake.failing.add(DEST_A);
    const poster = createLogPoster(fake.ports);
    await expect(poster.post(warnItem())).rejects.toThrow();
    expect(fake.sent).toHaveLength(2);

    fake.failing.clear();
    await poster.post(warnItem());
    expect(fake.sent).toHaveLength(3);
    expect(fake.sent[2]?.channelId).toBe(DEST_A);
  });
});
