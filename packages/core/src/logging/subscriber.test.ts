import { describe, expect, it } from 'vitest';
import { pino } from 'pino';
import { createLoggingSubscriber, type LoggingPorts } from './subscriber.js';
import type { LogRoute } from './routing.js';
import type { MessageEvent } from '../discord/events.js';

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
  const ports: LoggingPorts = {
    guildId: GUILD,
    listEnabledRoutesFor: () => routes,
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
    setRoutes: (next: LogRoute[]) => {
      routes = next;
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
