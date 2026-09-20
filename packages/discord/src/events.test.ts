import { describe, expect, it } from 'vitest';
import { ChannelType, Client, Events, type Guild } from 'discord.js';
import type { AutoModerationEvent, DomainEvent, ReactionEvent } from '@bananasaurs/core';
import { buildClientOptions } from './client.js';
import { attachGatewayTranslation } from './events.js';

/**
 * Gateway translation, driven by **raw gateway packets through discord.js's own
 * action handlers**.
 *
 * That is the real path a dispatch takes: `client.actions.X.handle(packet)` is
 * what the websocket layer calls. So these tests exercise discord.js's partial
 * machinery, guild attribution and emoji parsing rather than a hand-made
 * `MessageReaction` that would only encode what we already believe. The whole
 * reason this slice was pulled forward is that our beliefs about discord.js had
 * been wrong twice.
 */

const GUILD = '234567890123456789';
const OTHER_GUILD = '345678901234567890';
const CHANNEL = '333333333333333333';
const MESSAGE = '444444444444444444';
const USER = '111111111111111111';
const BOT = '999999999999999999';
const ROLE = '222222222222222222';
const AUTOMOD_RULE = '666666666666666666';

/**
 * discord.js's own gateway entry points, which are private to the library.
 *
 * That is precisely why they are used here: `client.actions.X.handle(packet)`
 * and `manager._add(payload)` are what the websocket layer calls, so standing in
 * for the socket at this seam is the only way to test translation against real
 * structures — real partials, real guild attribution, real emoji parsing. The
 * cast is confined to this one function.
 */
interface Internals {
  actions: Record<string, { handle: (data: object, shard?: unknown) => unknown }>;
  guilds: { _add: (data: object) => Guild };
  channels: { _add: (data: object, guild: unknown, options: object) => unknown };
  users: { _add: (data: object) => never };
}
const internals = (client: Client): Internals => client as unknown as Internals;

const membersOf = (guild: Guild): { _add: (data: object) => never } =>
  guild.members as unknown as { _add: (data: object) => never };

interface Harness {
  client: Client;
  events: DomainEvent[];
  errors: unknown[];
  guild: Guild;
  packet: (action: string, data: object) => void;
}

/**
 * `allowAny` exists so a "this event has no guild" test cannot pass because the
 * allowlist happened to reject whatever the adapter attributed it to. With every
 * guild allowed, the *only* thing that can drop such an event is the guild
 * attribution rule under test.
 */
function harness(options: { allow?: readonly string[]; allowAny?: boolean } = {}): Harness {
  const allow = options.allow ?? [GUILD];
  const isGuildAllowed = (guildId: string): boolean =>
    options.allowAny === true || allow.includes(guildId);
  const client = new Client(buildClientOptions(() => BOT));

  // What READY would have established. Without it the client has no identity,
  // and discord.js reads `client.user.id` while handling a reaction.
  const mutable = client as unknown as { user: unknown; application: unknown };
  mutable.user = internals(client).users._add({
    id: BOT,
    username: 'bananasaurs',
    discriminator: '0',
  });
  mutable.application = { id: BOT, emojis: { cache: new Map() } };

  // What GUILD_CREATE would have delivered. Channels are cached in full because
  // ChannelManager is one of the managers discord.js refuses to have limited.
  const guild = internals(client).guilds._add({
    id: GUILD,
    name: 'test guild',
    owner_id: USER,
    channels: [{ id: CHANNEL, type: ChannelType.GuildText, name: 'panels', guild_id: GUILD }],
    roles: [
      { id: GUILD, name: '@everyone', position: 0, managed: false },
      { id: ROLE, name: 'alpha', position: 1, managed: false },
    ],
    members: [],
    emojis: [],
    unavailable: false,
  });

  const events: DomainEvent[] = [];
  const errors: unknown[] = [];
  attachGatewayTranslation(client, {
    now: () => 1_700_000_000_000,
    isGuildAllowed,
    emit: (event) => void events.push(event),
    onError: (err) => void errors.push(err),
  });

  const actions = internals(client).actions;

  /**
   * The second argument means different things per action, which is a trap worth
   * naming: `MessageReactionAdd.handle(data, fromStructure)` **returns before
   * emitting** when the second argument is truthy, while
   * `GuildMemberUpdate.handle(data, shard)` requires `shard.status === Ready`
   * before it emits at all. Passing one shape to both silently produces no
   * events, which is how this harness was wrong on its first run.
   */
  const NEEDS_SHARD = new Set(['GuildMemberUpdate', 'GuildMemberRemove']);
  const packet = (action: string, data: object): void => {
    if (NEEDS_SHARD.has(action)) {
      actions[action]?.handle(data, { status: 0 /* Status.Ready */ });
      return;
    }
    actions[action]?.handle(data);
  };

  return { client, events, errors, guild, packet };
}

const reactionPacket = (over: Record<string, unknown> = {}): object => ({
  user_id: USER,
  channel_id: CHANNEL,
  message_id: MESSAGE,
  guild_id: GUILD,
  emoji: { id: null, name: '👍' },
  type: 0,
  burst: false,
  ...over,
});

describe('reactions', () => {
  it('translates an add into the domain shape, guild id included', () => {
    const h = harness();
    h.packet('MessageReactionAdd', reactionPacket());

    expect(h.events).toHaveLength(1);
    expect(h.events[0]).toMatchObject({
      kind: 'reactionAdd',
      guildId: GUILD,
      channelId: CHANNEL,
      messageId: MESSAGE,
      userId: USER,
      emoji: 'u:1f44d',
      receivedAtMs: 1_700_000_000_000,
    });
  });

  it('translates a remove', () => {
    const h = harness();
    h.packet('MessageReactionRemove', reactionPacket());
    expect(h.events[0]).toMatchObject({ kind: 'reactionRemove', userId: USER });
  });

  /**
   * The flag exists to make "the panel looks dead" diagnosable, so it has to be
   * honest. A message the client has never seen arrives partial — which is the
   * normal case for an adopted panel, since the panel message is usually far
   * older than the 25-message cache.
   */
  it('reports wasPartial for a message outside the cache', () => {
    const h = harness();
    h.packet('MessageReactionAdd', reactionPacket());
    expect((h.events[0] as ReactionEvent).wasPartial).toBe(true);
  });

  it('canonicalises a custom emoji to its id', () => {
    const h = harness();
    h.packet(
      'MessageReactionAdd',
      reactionPacket({ emoji: { id: '666666666666666666', name: 'blob', animated: false } }),
    );
    expect((h.events[0] as ReactionEvent).emoji).toBe('c:666666666666666666');
  });

  /**
   * Clients differ on whether they append U+FE0F, so a naive comparison matches
   * one platform's members and silently ignores another's. `unicodeEmojiKey`
   * drops the selector; this asserts the adapter actually routes through it.
   */
  it('drops the variation selector, so both platforms match one panel option', () => {
    const h = harness();
    h.packet('MessageReactionAdd', reactionPacket({ emoji: { id: null, name: '✔️' } }));
    h.packet('MessageReactionAdd', reactionPacket({ emoji: { id: null, name: '✔' } }));

    const keys = h.events.map((e) => (e as ReactionEvent).emoji);
    expect(keys).toEqual(['u:2714', 'u:2714']);
  });

  it('does not filter the bot out; that belongs to the application', () => {
    const h = harness();
    h.packet('MessageReactionAdd', reactionPacket({ user_id: BOT }));
    expect(h.events[0]).toMatchObject({ userId: BOT });
  });

  /**
   * An event that cannot be attributed to a guild is dropped **at the adapter**
   * rather than travelling with an optional scope (`events.ts`). A DM reaction
   * carries no `guild_id` at all.
   */
  it('drops a reaction that carries no guild', () => {
    const h = harness();
    // A real DM channel, which is the ordinary way this happens. Note that
    // omitting `guild_id` alone is NOT enough: discord.js falls back to
    // `channel.guild?.id`, so a cached guild channel still attributes the event.
    const dm = '888888888888888888';
    internals(h.client).channels._add(
      { id: dm, type: ChannelType.DM, recipients: [{ id: USER }] },
      null,
      {},
    );
    h.packet('MessageReactionAdd', reactionPacket({ guild_id: undefined, channel_id: dm }));
    expect(h.events).toEqual([]);
  });

  /**
   * `member.roles.cache` *adds* @everyone, whose id is the guild id, while the
   * gateway payload never does. Letting it through would inflate every count
   * that matters: a `max_roles: 2` panel would refuse a member's second option
   * having already counted a role nobody chose.
   */
  it('never reports @everyone as a role the member holds', () => {
    const h = harness();
    h.packet('GuildMemberUpdate', {
      guild_id: GUILD,
      user: { id: USER, username: 'member', discriminator: '0' },
      roles: [ROLE],
      joined_at: new Date(1_699_000_000_000).toISOString(),
    });
    expect((h.events[0] as { roleIds: readonly string[] }).roleIds).toEqual([ROLE]);
  });

  it('drops a reaction from a guild that is not allowlisted', () => {
    const h = harness({ allow: [OTHER_GUILD] });
    h.packet('MessageReactionAdd', reactionPacket());
    expect(h.events).toEqual([]);
  });
});

describe('members', () => {
  const memberPacket = (over: Record<string, unknown> = {}): object => ({
    guild_id: GUILD,
    user: { id: USER, username: 'member', discriminator: '0' },
    roles: [ROLE],
    joined_at: new Date(1_699_000_000_000).toISOString(),
    ...over,
  });

  /**
   * `GUILD_MEMBER_ADD` has no action class — it is a raw packet handler that adds
   * the member and emits. The member is still built by the real manager here;
   * only the dispatch is stood in for.
   */
  it('translates a join, keeping joinedAt because it fingerprints the event', () => {
    const h = harness();
    h.client.emit(Events.GuildMemberAdd, membersOf(h.guild)._add(memberPacket()));
    expect(h.events[0]).toMatchObject({
      kind: 'memberAdd',
      guildId: GUILD,
      userId: USER,
      roleIds: [ROLE],
      joinedAtMs: 1_699_000_000_000,
    });
  });

  it('translates a leave', () => {
    const h = harness();
    h.packet('GuildMemberRemove', memberPacket());
    expect(h.events[0]).toMatchObject({ kind: 'memberRemove', userId: USER });
  });

  /**
   * The finding that matters most in this file.
   *
   * `GuildMemberUpdate` builds `oldMember` from the cache. For a member outside
   * the 50-entry `GuildMemberManager`, discord.js creates one from the dispatch's
   * `user` alone and hands us that as "old" — so its role collection is **empty**,
   * not merely unknown. Reporting `previousRoleIds: []` would tell amendment 5's
   * drift detector that the member just gained every role they have, and it would
   * "repair" a change nobody made.
   *
   * `oldMember.partial` is the honest signal, and `reconcile.ts:360` already
   * returns early on `undefined`. The cost is real and belongs in the report:
   * for a member not resident in cache, a hand-made role change is repaired by
   * the periodic pass rather than promptly.
   */
  it('reports previousRoleIds as unknown when the old member was not cached', () => {
    const h = harness();
    h.packet('GuildMemberUpdate', memberPacket());

    expect(h.events[0]).toMatchObject({ kind: 'memberUpdate', roleIds: [ROLE] });
    expect((h.events[0] as { previousRoleIds?: unknown }).previousRoleIds).toBeUndefined();
  });

  it('diffs against the real previous roles when the member was resident', () => {
    const h = harness();
    // Put the member in cache with a known role set, as GUILD_CREATE would.
    membersOf(h.guild)._add(memberPacket({ roles: [] }));

    h.packet('GuildMemberUpdate', memberPacket({ roles: [ROLE] }));

    expect(h.events[0]).toMatchObject({ kind: 'memberUpdate', roleIds: [ROLE] });
    expect((h.events[0] as { previousRoleIds?: readonly string[] }).previousRoleIds).toEqual([]);
  });
});

describe('roles and guild lifecycle', () => {
  it('translates role create, update and delete', () => {
    const h = harness();
    // A role the harness guild does not already have: discord.js treats
    // GUILD_ROLE_CREATE for a cached role as a no-op and emits nothing.
    const fresh = '777777777777777777';
    const role = { id: fresh, name: 'beta', position: 2, managed: false, permissions: '0' };
    h.packet('GuildRoleCreate', { guild_id: GUILD, role });
    h.packet('GuildRoleUpdate', { guild_id: GUILD, role: { ...role, name: 'renamed' } });
    h.packet('GuildRoleDelete', { guild_id: GUILD, role_id: fresh });

    expect(h.events.map((e) => e.kind)).toEqual(['roleCreate', 'roleUpdate', 'roleDelete']);
    expect(h.events.every((e) => e.guildId === GUILD)).toBe(true);
  });

  /**
   * The logging module (WP4, ADR 0023) needs a name to render "Role deleted:
   * @old-name" rather than a bare id nobody recognises — and discord.js hands
   * the listener the role's last-known state for free on every one of these
   * three dispatches, including delete, where it is already gone from
   * `guild.roles.cache` by the time the handler runs.
   */
  it('carries the role name on create, update and delete', () => {
    const h = harness();
    const fresh = '888888888888888888';
    const role = { id: fresh, name: 'beta', position: 2, managed: false, permissions: '0' };
    h.packet('GuildRoleCreate', { guild_id: GUILD, role });
    h.packet('GuildRoleUpdate', { guild_id: GUILD, role: { ...role, name: 'renamed' } });
    h.packet('GuildRoleDelete', { guild_id: GUILD, role_id: fresh });

    expect(h.events.map((e) => (e as { name?: unknown }).name)).toEqual([
      'beta',
      'renamed',
      // discord.js hands the delete listener the role as it stood the instant
      // before removal — the update above already renamed it.
      'renamed',
    ]);
  });

  /**
   * `guildCreate` is deliberately NOT filtered by the allowlist. It is the event
   * the composition root uses to *leave* an unlisted guild — filtering it here
   * would silence the one behaviour `docs/21` exercise 1 calls the single most
   * important in the document.
   */
  it('emits guildCreate even for a guild that is not allowlisted', () => {
    const h = harness({ allow: [OTHER_GUILD] });
    const uninvited = internals(h.client).guilds._add({
      id: OTHER_GUILD.replace('3', '4'),
      name: 'uninvited',
      owner_id: USER,
      channels: [],
      roles: [],
      members: [],
      emojis: [],
      unavailable: false,
    });
    h.client.emit(Events.GuildCreate, uninvited);

    expect(h.events.map((e) => e.kind)).toContain('guildCreate');
    expect(h.events.find((e) => e.kind === 'guildCreate')?.guildId).toBe(uninvited.id);
  });
});

const messageCreatePacket = (over: Record<string, unknown> = {}): object => ({
  id: MESSAGE,
  channel_id: CHANNEL,
  guild_id: GUILD,
  author: { id: USER, username: 'member', discriminator: '0' },
  content: 'hello',
  timestamp: '2026-08-30T00:00:00.000Z',
  type: 0,
  ...over,
});

describe('messages', () => {
  it('carries the parent and category for a message in a public thread', () => {
    const h = harness();
    const categoryId = '111111111111111111';
    const parentId = '222222222222222222';
    const threadId = '555555555555555551';
    internals(h.client).channels._add(
      { id: categoryId, guild_id: GUILD, type: ChannelType.GuildCategory, name: 'cat' },
      h.client.guilds.cache.get(GUILD),
      {},
    );
    internals(h.client).channels._add(
      {
        id: parentId,
        guild_id: GUILD,
        parent_id: categoryId,
        type: ChannelType.GuildText,
        name: 'parent',
      },
      h.client.guilds.cache.get(GUILD),
      {},
    );
    h.packet('ThreadCreate', {
      id: threadId,
      guild_id: GUILD,
      parent_id: parentId,
      type: ChannelType.PublicThread,
      name: 'thread',
      owner_id: USER,
      message_count: 0,
      member_count: 1,
      thread_metadata: {
        archived: false,
        auto_archive_duration: 60,
        archive_timestamp: '2026-08-30T00:00:00.000Z',
        locked: false,
        invitable: true,
      },
    });
    h.packet('MessageCreate', messageCreatePacket({ channel_id: threadId }));
    expect(h.events.at(-1)).toMatchObject({
      channelId: threadId,
      parentChannelId: parentId,
      categoryId,
      isPrivateThread: false,
    });
  });

  it('marks a private thread so downstream vetoes can refuse it', () => {
    const h = harness();
    const parentId = '222222222222222222';
    const threadId = '555555555555555552';
    internals(h.client).channels._add(
      { id: parentId, guild_id: GUILD, type: ChannelType.GuildText, name: 'parent' },
      h.client.guilds.cache.get(GUILD),
      {},
    );
    h.packet('ThreadCreate', {
      id: threadId,
      guild_id: GUILD,
      parent_id: parentId,
      type: ChannelType.PrivateThread,
      name: 'private',
      owner_id: USER,
      message_count: 0,
      member_count: 1,
      thread_metadata: {
        archived: false,
        auto_archive_duration: 60,
        archive_timestamp: '2026-08-30T00:00:00.000Z',
        locked: false,
        invitable: true,
      },
    });
    h.packet('MessageCreate', messageCreatePacket({ channel_id: threadId }));
    expect(h.events.at(-1)).toMatchObject({ isPrivateThread: true });
  });

  it('translates a create into the domain shape, guild id included', () => {
    const h = harness();
    h.packet('MessageCreate', messageCreatePacket());
    expect(h.events).toEqual<DomainEvent[]>([
      {
        kind: 'messageCreate',
        guildId: GUILD,
        receivedAtMs: 1_700_000_000_000,
        channelId: CHANNEL,
        parentChannelId: undefined,
        categoryId: undefined,
        isPrivateThread: false,
        messageId: MESSAGE,
        authorId: USER,
        authorIsBot: false,
        content: 'hello',
        editedTimestampMs: undefined,
        mentionedUserIds: [],
        mentionedRoleIds: [],
        mentionsEveryone: false,
        attachments: [],
      },
    ]);
  });

  /**
   * Automod must never process a bot's own output. The bot posts a
   * message-delete log entry that quotes the deleted content, discord.js
   * emits that as a `messageCreate`, and an enforce-mode rule would match the
   * quoted word and delete its own log message — logging it again, forever,
   * opening a case against the bot's own user id on every lap.
   */
  it('marks a bot-authored message as such', () => {
    const h = harness();
    h.packet(
      'MessageCreate',
      messageCreatePacket({
        author: { id: USER, username: 'bananasaurs', discriminator: '0', bot: true },
      }),
    );
    expect(h.events).toEqual<DomainEvent[]>([
      expect.objectContaining({ kind: 'messageCreate', authorIsBot: true }) as DomainEvent,
    ]);
  });

  /**
   * As with reactions: omitting `guild_id` alone is not enough. `Message`
   * falls back to `this.channel?.guild?.id` (`Message.js:51`), so posting to
   * `CHANNEL` — already cached as a guild channel by the harness — would still
   * attribute the event. A real DM channel is the only honest way to produce
   * a message discord.js cannot attach to a guild.
   */
  it('drops a message that carries no guild', () => {
    const h = harness();
    const dm = '888888888888888888';
    internals(h.client).channels._add(
      { id: dm, type: ChannelType.DM, recipients: [{ id: USER }] },
      null,
      {},
    );
    h.packet('MessageCreate', messageCreatePacket({ guild_id: undefined, channel_id: dm }));
    expect(h.events).toEqual([]);
  });

  it('drops a message from a guild that is not allowlisted', () => {
    const h = harness({ allow: [OTHER_GUILD] });
    h.packet('MessageCreate', messageCreatePacket());
    expect(h.events).toEqual([]);
  });

  /**
   * Mentions and attachments, for Slice 4's `mention_spam` and Slice 5's
   * `attachment_type`. `ROLE` is already cached by the harness (a mentioned
   * role discord.js cannot resolve from `guild.roles.cache` is dropped, not
   * reported as an id), so it stands in for a real mention here.
   */
  it('carries mentions and attachments on messageCreate', () => {
    const h = harness();
    h.packet(
      'MessageCreate',
      messageCreatePacket({
        content: 'hey @everyone',
        mentions: [{ id: USER, username: 'mentioned', discriminator: '0' }],
        mention_roles: [ROLE],
        mention_everyone: true,
        attachments: [
          {
            id: '1',
            filename: 'payload.exe',
            content_type: 'application/octet-stream',
            size: 4096,
          },
        ],
      }),
    );
    expect(h.events[0]).toMatchObject({
      mentionedUserIds: [USER],
      mentionedRoleIds: [ROLE],
      mentionsEveryone: true,
      attachments: [
        {
          attachmentId: '1',
          fileName: 'payload.exe',
          contentType: 'application/octet-stream',
          sizeBytes: 4096,
        },
      ],
    });
  });

  /**
   * A `MESSAGE_DELETE` for an id the client never cached arrives partial — the
   * dispatch carries only ids (`Action.getMessage`). Empty arrays and `false`
   * say "nothing is known", which is what every predicate downstream must
   * treat as "do not match" — the same reading `content: undefined` already
   * gets above.
   */
  it('reports no mentions and no attachments for a partial message', () => {
    const h = harness();
    h.packet('MessageDelete', { id: MESSAGE, channel_id: CHANNEL, guild_id: GUILD });
    expect(h.events[0]).toMatchObject({
      kind: 'messageDelete',
      mentionedUserIds: [],
      mentionedRoleIds: [],
      mentionsEveryone: false,
      attachments: [],
    });
  });
});

describe('message bulk deletes', () => {
  it('translates a bulk delete of two ids into one event with both ids', () => {
    const h = harness();
    const OTHER = '444444444444444445';
    h.packet('MessageDeleteBulk', { ids: [MESSAGE, OTHER], channel_id: CHANNEL, guild_id: GUILD });

    expect(h.events).toHaveLength(1);
    expect(h.events[0]).toMatchObject({
      kind: 'messageDeleteBulk',
      guildId: GUILD,
      channelId: CHANNEL,
      receivedAtMs: 1_700_000_000_000,
    });
    expect((h.events[0] as { messageIds: readonly string[] }).messageIds).toEqual([MESSAGE, OTHER]);
  });

  it('emits no event for an empty collection', () => {
    const h = harness();
    h.packet('MessageDeleteBulk', { ids: [], channel_id: CHANNEL, guild_id: GUILD });
    expect(h.events).toEqual([]);
  });
});

/**
 * Native AutoMod observability (ADR 0038, slice 0). `AUTO_MODERATION_ACTION_
 * EXECUTION` has a real action class (`client.actions.AutoModerationActionExecution`),
 * so this is driven through `h.packet` exactly like the other gateway dispatches
 * — a raw packet through discord.js's own handler — rather than a hand-built
 * `AutoModerationActionExecution` instance.
 */
const autoModPacket = (over: Record<string, unknown> = {}): object => ({
  guild_id: GUILD,
  action: { type: 1, metadata: {} }, // BlockMessage
  rule_id: AUTOMOD_RULE,
  rule_trigger_type: 1, // Keyword
  user_id: USER,
  channel_id: CHANNEL,
  message_id: null, // blocked: Discord omits it
  alert_system_message_id: null,
  content: 'a forbidden word',
  matched_keyword: 'forbidden',
  matched_content: 'forbidden',
  ...over,
});

describe('native auto-moderation (ADR 0038)', () => {
  it('translates a blocked auto-moderation execution', () => {
    const h = harness();
    h.packet('AutoModerationActionExecution', autoModPacket());

    expect(h.events).toEqual<DomainEvent[]>([
      {
        kind: 'autoModerationAction',
        guildId: GUILD,
        receivedAtMs: 1_700_000_000_000,
        ruleId: AUTOMOD_RULE,
        triggerType: 'keyword',
        userId: USER,
        actionType: 'block',
        channelId: CHANNEL,
        messageId: undefined,
        alertMessageId: undefined,
        content: 'a forbidden word',
        matchedKeyword: 'forbidden',
        matchedContent: 'forbidden',
      },
    ]);
  });

  it('maps an unrecognised trigger type to unknown rather than dropping the event', () => {
    const h = harness();
    h.packet('AutoModerationActionExecution', autoModPacket({ rule_trigger_type: 99 }));

    expect(h.events).toHaveLength(1);
    expect((h.events[0] as AutoModerationEvent).triggerType).toBe('unknown');
  });

  /**
   * The asymmetric half of the mapping: an action type we cannot name is
   * dropped rather than guessed, unlike a trigger type. Covered separately
   * because the brief's translator tests only exercise the trigger path. A
   * gap is reported so an unrecognised value is not silently swallowed —
   * ADR 0038 exists to record native decisions, and silent drops produce
   * exactly the unrecorded decision it warns against.
   */
  it('drops the event but reports an error when the action type is unrecognised', () => {
    const h = harness();
    h.packet(
      'AutoModerationActionExecution',
      autoModPacket({ action: { type: 99, metadata: {} } }),
    );

    expect(h.events).toEqual([]);
    expect(h.errors).toHaveLength(1);
    expect(h.errors[0]).toBeInstanceOf(Error);
    expect((h.errors[0] as Error).message).toContain('Unrecognised native AutoMod action type: 99');
  });

  it('drops an execution from a guild that is not allowlisted', () => {
    const h = harness({ allow: [OTHER_GUILD] });
    h.packet('AutoModerationActionExecution', autoModPacket());
    expect(h.events).toEqual([]);
  });
});

describe('translation never takes the process down', () => {
  /**
   * `MessageReaction.emoji` dereferences `client.application.emojis` for a custom
   * emoji, and throws a TypeError when the application is not yet resolved
   * (measured — see the session log). A handler that lets that escape becomes an
   * unhandled rejection and takes the daemon with it, over one malformed event.
   */
  it('reports a translation failure and drops the event instead of throwing', () => {
    const h = harness();
    (h.client as unknown as { application: unknown }).application = null;

    expect(() =>
      h.packet(
        'MessageReactionAdd',
        reactionPacket({ emoji: { id: '666666666666666666', name: 'blob' } }),
      ),
    ).not.toThrow();

    expect(h.errors).toHaveLength(1);
    expect(h.events).toEqual([]);
  });
});

/**
 * Slash commands (WP5 slice 15, ADR 0032/0033).
 *
 * `INTERACTION_CREATE` reaches `client.actions.InteractionCreate.handle`, which
 * picks a structure class from `data.type` and `data.data.type` and constructs a
 * real `ChatInputCommandInteraction`. Driving it through that path rather than
 * through a hand-made interaction is what makes the option-flattening assertions
 * mean anything: the nesting under test is Discord's payload grammar, and a
 * fake would only encode what we already believe about it.
 */
const APPLICATION = '555555555555555555';
const COMMAND_ID = '777777777777777777';
const INTERACTION = '888888888888888888';

const commandPacket = (over: Record<string, unknown> = {}): object => ({
  id: INTERACTION,
  application_id: APPLICATION,
  // InteractionType.ApplicationCommand
  type: 2,
  token: 'interaction-token',
  version: 1,
  guild_id: GUILD,
  channel: { id: CHANNEL, type: ChannelType.GuildText, guild_id: GUILD },
  member: {
    user: { id: USER, username: 'member', discriminator: '0' },
    roles: [],
    joined_at: '2026-01-01T00:00:00.000Z',
    permissions: '0',
    deaf: false,
    mute: false,
  },
  app_permissions: '0',
  locale: 'en-GB',
  entitlements: [],
  authorizing_integration_owners: {},
  // ApplicationCommandType.ChatInput
  data: { id: COMMAND_ID, name: 'status', type: 1 },
  ...over,
});

describe('slash commands', () => {
  it('translates a chat-input command into the domain shape, guild id included', () => {
    const h = harness();
    h.packet('InteractionCreate', commandPacket());

    expect(h.events).toHaveLength(1);
    expect(h.events[0]).toMatchObject({
      kind: 'slashCommand',
      guildId: GUILD,
      channelId: CHANNEL,
      userId: USER,
      interactionId: INTERACTION,
      token: 'interaction-token',
      commandName: 'status',
      subcommandPath: [],
      options: [],
      receivedAtMs: 1_700_000_000_000,
    });
  });

  /**
   * The branch this slice replaced. Before it, `isChatInputCommand()` fell
   * through `if (!interaction.isButton() && !interaction.isStringSelectMenu())`
   * and the invocation was dropped with no log, no error and no event — a
   * registered command that answered nothing.
   */
  it('no longer falls into the component branch and vanishes', () => {
    const h = harness();
    h.packet('InteractionCreate', commandPacket());
    expect(h.events.map((e) => e.kind)).toEqual(['slashCommand']);
    expect(h.errors).toEqual([]);
  });

  /**
   * A subcommand is an *option* whose own options are the real arguments, and a
   * group nests one level deeper again. Reading `data.options[0].value` without
   * unwrapping reports the subcommand as an argument with no value.
   */
  it('flattens a subcommand group, a subcommand and their options', () => {
    const h = harness();
    h.packet(
      'InteractionCreate',
      commandPacket({
        data: {
          id: COMMAND_ID,
          name: 'logging',
          type: 1,
          options: [
            {
              name: 'route',
              // ApplicationCommandOptionType.SubcommandGroup
              type: 2,
              options: [
                {
                  name: 'set',
                  // ApplicationCommandOptionType.Subcommand
                  type: 1,
                  options: [
                    // String, Channel, Boolean
                    { name: 'kind', type: 3, value: 'messageDelete' },
                    { name: 'channel', type: 7, value: CHANNEL },
                    { name: 'content', type: 5, value: true },
                  ],
                },
              ],
            },
          ],
          resolved: {},
        },
      }),
    );

    expect(h.events[0]).toMatchObject({
      kind: 'slashCommand',
      commandName: 'logging',
      subcommandPath: ['route', 'set'],
      options: [
        { name: 'kind', value: 'messageDelete' },
        // A channel option arrives as its snowflake. The event carries the id
        // rather than a resolved structure, so nothing fetches behind a field.
        { name: 'channel', value: CHANNEL },
        { name: 'content', value: true },
      ],
    });
  });

  /**
   * Guild attribution happens here or not at all. A user-installed application
   * can be invoked in a DM, and every handler downstream reaches storage through
   * a `GuildScope`, which a DM cannot produce.
   *
   * **Every guild is allowed here on purpose.** With the ordinary allowlist, an
   * adapter that invented a fallback guild id would still be dropped — by the
   * allowlist, not by the rule under test — and this test would pass while the
   * attribution rule was gone. Mutation 233 survived exactly that way.
   */
  it('drops an invocation that carries no guild', () => {
    const h = harness({ allowAny: true });
    h.packet(
      'InteractionCreate',
      commandPacket({
        guild_id: undefined,
        channel: { id: '555000555000555000', type: ChannelType.DM, recipients: [{ id: USER }] },
        member: undefined,
        user: { id: USER, username: 'member', discriminator: '0' },
      }),
    );

    expect(h.events).toEqual([]);
    expect(h.errors).toEqual([]);
  });

  /** The allowlist gate applies to a slash command exactly as to a reaction. */
  it('drops an invocation from a guild outside the allowlist', () => {
    const h = harness({ allow: [OTHER_GUILD] });
    h.packet('InteractionCreate', commandPacket());
    expect(h.events).toEqual([]);
  });

  /**
   * Adding the command branch must not widen the drop. An autocomplete request
   * is a real, well-formed dispatch for a surface Release 1 does not have.
   */
  it('still drops an interaction type this adapter does not handle', () => {
    const h = harness();
    // InteractionType.ApplicationCommandAutocomplete
    h.packet('InteractionCreate', commandPacket({ type: 4 }));
    expect(h.events).toEqual([]);
    expect(h.errors).toEqual([]);
  });
});
