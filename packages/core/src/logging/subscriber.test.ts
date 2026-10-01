import { describe, expect, it } from 'vitest';
import { pino } from 'pino';
import { createLoggingSubscriber, type LoggingPorts } from './subscriber.js';
import type { LogRoute } from './routing.js';
import type { MemberSnapshotLike } from './member-changes.js';
import type { MemberEvent, MessageEvent } from '../discord/events.js';

const GUILD = '111111111111111111';
const SOURCE = '222222222222222222';
const DEST_A = '333333333333333333';
const DEST_B = '444444444444444444';
const logger = pino({ level: 'silent' });

interface SentLine {
  channelId: string;
  content: string;
  allowedMentions: { parse: readonly [] };
}

const makeRoute = (over: Partial<LogRoute> & { routeId: string }): LogRoute => ({
  channelId: DEST_A,
  includeContent: true,
  enabled: true,
  excludedChannelIds: [],
  ...over,
});

function makeFake() {
  const claims = new Set<string>();
  const sent: SentLine[] = [];
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
      sent.push({
        channelId,
        content: message.content,
        allowedMentions: message.allowedMentions,
      });
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

const editEvent = (over: Partial<MessageEvent> = {}): MessageEvent => ({
  kind: 'messageUpdate',
  guildId: GUILD,
  receivedAtMs: 1,
  channelId: SOURCE,
  parentChannelId: undefined,
  categoryId: undefined,
  isPrivateThread: false,
  messageId: '444444444444444444',
  authorId: '555555555555555555',
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
    for (const line of fake.sent) {
      expect(line.allowedMentions).toEqual({ parse: [] });
    }
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
    const byChannel = new Map(fake.sent.map((s) => [s.channelId, s.content]));
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
    await subscriber.handle(
      memberUpdate({ receivedAtMs: 1_000, profile: memberProfile('Nick') }),
    );
    expect(fake.snapshots.has(MEMBER)).toBe(true);

    // The owner turns every member-change action off: the next sighting of
    // the member drops the record instead of refreshing it.
    fake.setRouteKinds('n', ['member_join']);
    await subscriber.handle(
      memberUpdate({ receivedAtMs: 2_000, profile: memberProfile('Nick') }),
    );
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

  it('a later update with a new nickname posts one line and updates the snapshot', async () => {
    const fake = makeFake();
    fake.setRoutes([makeRoute({ routeId: 'n', channelId: DEST_A })]);
    fake.setRouteKinds('n', ['member_nickname_changed']);
    const subscriber = createLoggingSubscriber(fake.ports);
    await subscriber.handle(
      memberUpdate({ receivedAtMs: 1_000, profile: memberProfile('Old') }),
    );
    await subscriber.handle(
      memberUpdate({ receivedAtMs: 2_000, profile: memberProfile('New') }),
    );
    expect(fake.sent).toHaveLength(1);
    expect(fake.sent[0]?.content).toContain('Nickname changed');
    expect(fake.sent[0]?.content).toContain(`<@${MEMBER}>`);
    expect(fake.sent[0]?.content).toContain('"Old"');
    expect(fake.sent[0]?.content).toContain('"New"');
    expect(fake.sent[0]?.allowedMentions).toEqual({ parse: [] });
    expect(fake.snapshots.get(MEMBER)?.nickname).toBe('New');
  });

  it('replaying the identical event posts nothing — the snapshot now matches', async () => {
    const fake = makeFake();
    fake.setRoutes([makeRoute({ routeId: 'n', channelId: DEST_A })]);
    fake.setRouteKinds('n', ['member_nickname_changed']);
    const subscriber = createLoggingSubscriber(fake.ports);
    await subscriber.handle(
      memberUpdate({ receivedAtMs: 1_000, profile: memberProfile('Old') }),
    );
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
    await subscriber.handle(
      memberUpdate({ receivedAtMs: 1_000, profile: memberProfile('Old') }),
    );
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

  it('an A→B→A→B nickname sequence posts four lines', async () => {
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
    expect(fake.sent.map((s) => s.content)).toEqual([
      expect.stringContaining('"Zero" → "A"'),
      expect.stringContaining('"A" → "B"'),
      expect.stringContaining('"B" → "A"'),
      expect.stringContaining('"A" → "B"'),
    ]);
  });

  it('a leave posts the leave line and deletes the snapshot', async () => {
    const fake = makeFake();
    fake.setRoutes([makeRoute({ routeId: 'l', channelId: DEST_A })]);
    fake.setRouteKinds('l', ['member_leave', 'member_nickname_changed']);
    const subscriber = createLoggingSubscriber(fake.ports);
    await subscriber.handle(memberJoin({ receivedAtMs: 1_000, profile: memberProfile('Nick') }));
    expect(fake.snapshots.has(MEMBER)).toBe(true);

    await subscriber.handle(memberLeave({ receivedAtMs: 2_000 }));
    expect(fake.sent.map((s) => s.content)).toContain(`Member left: <@${MEMBER}>`);
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
