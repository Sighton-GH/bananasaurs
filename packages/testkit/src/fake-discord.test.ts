import { beforeEach, describe, expect, it } from 'vitest';
import {
  DiscordApiError,
  unicodeEmojiKey,
  type AuditLogEntry,
  type DomainEvent,
} from '@bananasaurs/core';
import { BOT_USER_ID, FakeDiscord } from './fake-discord.js';

const GUILD = '111111111111111111';
const CHANNEL = '222222222222222222';
const MESSAGE = '333333333333333333';
const ROLE = '444444444444444444';
const USER = '555555555555555555';
const BRAIN = unicodeEmojiKey('🧠');

let d: FakeDiscord;
let seen: DomainEvent[];

beforeEach(() => {
  d = new FakeDiscord({ guildId: GUILD, botHighestRolePosition: 100 });
  d.defineRole({ id: ROLE, position: 10 });
  d.defineMember(USER);
  d.defineMessage({ channelId: CHANNEL, messageId: MESSAGE });
  seen = [];
  d.onEvent((e) => {
    seen.push(e);
  });
});

const ref = { channelId: CHANNEL, messageId: MESSAGE };

/**
 * The six conditions docs/19 section 3 requires the harness to drive. Each is
 * the trigger a feature test will use, so if these do not work the features
 * cannot be tested at all.
 */
describe('the six required conditions', () => {
  it('1. duplicate event — a replayed reaction produces a second event, not a second state change', async () => {
    await d.emitReactionAdd({ ...ref, userId: USER, emoji: BRAIN });
    await d.emitDuplicateReactionAdd({ ...ref, userId: USER, emoji: BRAIN });

    expect(seen.filter((e) => e.kind === 'reactionAdd')).toHaveLength(2);
    // The reaction is present once; Discord does not double-count.
    const page = await d.fetchReactionUsers(GUILD, ref, BRAIN);
    expect(page.userIds).toEqual([USER]);
  });

  it('2. reconnect gap — offline reactions emit nothing and are never replayed', async () => {
    d.disconnect();
    d.offlineReactionAdd({ ...ref, userId: USER, emoji: BRAIN });
    expect(seen).toHaveLength(0);

    await d.reconnect({ resumed: false });

    // Exactly one event: the connection notice. The reaction is NOT replayed.
    expect(seen.map((e) => e.kind)).toEqual(['connection']);
    const conn = seen[0];
    expect(conn?.kind === 'connection' && conn.resumed).toBe(false);

    // But the state changed, which is why reconciliation exists.
    const page = await d.fetchReactionUsers(GUILD, ref, BRAIN);
    expect(page.userIds).toEqual([USER]);
  });

  it('2b. a resumed reconnect reports no gap', async () => {
    d.disconnect();
    await d.reconnect({ resumed: true });
    const conn = seen[0];
    expect(conn?.kind === 'connection' && conn.resumed).toBe(true);
  });

  it('3. 429 — one-shot, with retryAfter, and the next call succeeds', async () => {
    d.failNext('addRole', FakeDiscord.rateLimited(1.5));
    await expect(d.addRole(GUILD, USER, ROLE, 'test')).rejects.toMatchObject({
      status: 429,
      options: { retryAfter: 1.5 },
    });
    // one-shot: the retry goes through
    await expect(d.addRole(GUILD, USER, ROLE, 'test')).resolves.toBeUndefined();
    expect(d.memberRoles(USER)).toEqual([ROLE]);
  });

  it('3b. failTimes exhausts, so a breaker test can drive N consecutive failures', async () => {
    d.failTimes('addRole', 3, FakeDiscord.rateLimited());
    for (let i = 0; i < 3; i += 1) {
      await expect(d.addRole(GUILD, USER, ROLE, 'x')).rejects.toBeInstanceOf(DiscordApiError);
    }
    await expect(d.addRole(GUILD, USER, ROLE, 'x')).resolves.toBeUndefined();
  });

  it('4. missing permission — 403 / 50013, and the role is not applied', async () => {
    d.failNext('addRole', FakeDiscord.missingPermissions());
    await expect(d.addRole(GUILD, USER, ROLE, 'test')).rejects.toMatchObject({
      status: 403,
      code: 50013,
    });
    expect(d.memberRoles(USER)).toEqual([]);
  });

  it('5. role-hierarchy failure — declarative, and reported the way Discord reports it', async () => {
    d.setRolePosition(ROLE, 120); // above the bot's 100
    const err = await d.addRole(GUILD, USER, ROLE, 'test').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DiscordApiError);
    // Discord cannot distinguish hierarchy from permission: both are 50013.
    // This is why hierarchy must be checked before acting, not inferred after.
    expect((err as DiscordApiError).code).toBe(50013);
    expect(d.memberRoles(USER)).toEqual([]);
  });

  it('5b. an integration-managed role is unassignable at any position', async () => {
    d.defineRole({ id: '666666666666666666', position: 1, managed: true });
    await expect(d.addRole(GUILD, USER, '666666666666666666', 'x')).rejects.toMatchObject({
      code: 50013,
    });
  });

  it('6. reaction on an uncached message — the event arrives flagged partial', async () => {
    d.setMessageCached(ref, false);
    await d.emitReactionAdd({ ...ref, userId: USER, emoji: BRAIN });

    const e = seen[0];
    expect(e?.kind).toBe('reactionAdd');
    expect(e?.kind === 'reactionAdd' && e.wasPartial).toBe(true);

    // Hydrating it is what our adapter must do before reading the message.
    await d.fetchMessage(GUILD, ref);
    await d.emitReactionAdd({ ...ref, userId: '777777777777777777', emoji: BRAIN });
    const e2 = seen[1];
    expect(e2?.kind === 'reactionAdd' && e2.wasPartial).toBe(false);
  });

  it('6b. fetching a deleted panel message fails with Unknown Message', async () => {
    d.simulateDeletedMessage(ref);
    await expect(d.fetchMessage(GUILD, ref)).rejects.toMatchObject({ code: 10008 });
  });
});

describe('moderation (ADR 0035)', () => {
  it('deletes a message and records the call', async () => {
    await d.deleteMessage(GUILD, ref, 'automod: blocked keyword');
    await expect(d.fetchMessage(GUILD, ref)).rejects.toMatchObject({ code: 10008 });
    expect(d.restCalls('deleteMessage')).toHaveLength(1);
  });

  it('deleteMessage is NOT hierarchy-gated — it deletes even the owner’s message', async () => {
    d.defineMember('777777777777777777', [], true); // guild owner
    d.defineMessage({
      channelId: CHANNEL,
      messageId: '888888888888888888',
      authorId: '777777777777777777',
    });
    await expect(
      d.deleteMessage(GUILD, { channelId: CHANNEL, messageId: '888888888888888888' }, 'x'),
    ).resolves.toBeUndefined();
  });

  it('deleteMessage is NOT hierarchy-gated — it deletes a message from a member above the bot', async () => {
    d.defineRole({ id: '999999999999999998', position: 200 }); // above the bot's 100
    d.defineMember('777777777777777777', ['999999999999999998']);
    d.defineMessage({
      channelId: CHANNEL,
      messageId: '888888888888888888',
      authorId: '777777777777777777',
    });
    await expect(
      d.deleteMessage(GUILD, { channelId: CHANNEL, messageId: '888888888888888888' }, 'x'),
    ).resolves.toBeUndefined();
  });

  it('times out a member and records the state', async () => {
    d.advance(0);
    await d.timeoutMember(GUILD, USER, 60_000, 'automod: rate limit');
    expect(d.memberModerationState(USER)).toEqual({ until: d.now() + 60_000 });
  });

  it('kicks a member, records the state, and removes them from the guild', async () => {
    await d.kickMember(GUILD, USER, 'automod: repeated violations');
    expect(d.memberModerationState(USER)).toBe('kicked');
    await expect(d.fetchMember(GUILD, USER)).rejects.toMatchObject({ code: 10007 });
  });

  it('timeoutMember refuses the guild owner, mirroring Discord itself', async () => {
    d.defineMember('777777777777777777', [], true);
    await expect(d.timeoutMember(GUILD, '777777777777777777', 60_000, 'x')).rejects.toMatchObject({
      code: 50013,
    });
    expect(d.memberModerationState('777777777777777777')).toBeUndefined();
  });

  it('kickMember refuses a member whose role sits at or above the bot', async () => {
    d.defineRole({ id: '999999999999999998', position: 100 }); // at the bot's own position
    d.defineMember('777777777777777777', ['999999999999999998']);
    await expect(d.kickMember(GUILD, '777777777777777777', 'x')).rejects.toMatchObject({
      code: 50013,
    });
    expect(d.memberModerationState('777777777777777777')).toBeUndefined();
  });
});

describe('reaction pagination', () => {
  it('caps a page at 100 and walks the rest with nextAfter', async () => {
    const ids = Array.from({ length: 250 }, (_, i) => String(600000000000000000n + BigInt(i)));
    for (const id of ids) d.offlineReactionAdd({ ...ref, userId: id, emoji: BRAIN });

    const collected: string[] = [];
    let after: string | undefined;
    let pages = 0;
    do {
      const page = await d.fetchReactionUsers(GUILD, ref, BRAIN, { after });
      collected.push(...page.userIds);
      after = page.nextAfter;
      pages += 1;
      expect(page.userIds.length).toBeLessThanOrEqual(100);
    } while (after);

    expect(pages).toBe(3); // 100 + 100 + 50
    expect(collected).toEqual(ids);
  });

  /**
   * Discord's `GET /reactions` returns users and nothing else — no total, no
   * "has more" flag — so a full page is indistinguishable from a full page that
   * happened to be the last one. Every adapter over the real API therefore has
   * to offer a cursor whenever the page came back full, and find out by getting
   * an empty page next.
   *
   * This fake used to answer `undefined` here, because it can see the whole
   * array and real Discord cannot. That let a caller look correct while relying
   * on knowledge that never arrives on the wire. Corrected in WP5 slice 6b while
   * writing the adapter's own pagination; `pageReactors` already loops in a way
   * that tolerates the extra empty page.
   */
  it('still offers a cursor when a full page exactly exhausts the reactors', async () => {
    const ids = Array.from({ length: 100 }, (_, i) => String(600000000000000000n + BigInt(i)));
    for (const id of ids) d.offlineReactionAdd({ ...ref, userId: id, emoji: BRAIN });

    const first = await d.fetchReactionUsers(GUILD, ref, BRAIN);
    expect(first.userIds).toHaveLength(100);
    expect(first.nextAfter).toBe(ids[99]);

    const second = await d.fetchReactionUsers(GUILD, ref, BRAIN, { after: first.nextAfter });
    expect(second.userIds).toEqual([]);
    expect(second.nextAfter).toBeUndefined();
  });

  it('ignores a request for more than 100', async () => {
    for (let i = 0; i < 150; i += 1) {
      d.offlineReactionAdd({
        ...ref,
        userId: String(600000000000000000n + BigInt(i)),
        emoji: BRAIN,
      });
    }
    const page = await d.fetchReactionUsers(GUILD, ref, BRAIN, { limit: 500 });
    expect(page.userIds).toHaveLength(100);
  });

  it('includes the bot seed reaction in the reactor list, as Discord does', async () => {
    // Discord returns every user who reacted, bots included. Excluding the bot
    // here — which this fake originally did — makes the adoption pass's own
    // filter untestable, and a pass without that filter grants the bot every
    // role on the panel it just seeded. The exclusion belongs in the
    // application, and the harness must not do its job for it.
    await d.createReaction(GUILD, ref, BRAIN);
    d.offlineReactionAdd({ ...ref, userId: USER, emoji: BRAIN });
    const page = await d.fetchReactionUsers(GUILD, ref, BRAIN);
    expect(page.userIds).toContain(BOT_USER_ID);
    expect(page.userIds).toContain(USER);
  });
});

describe('interaction deadlines, which Discord enforces strictly', () => {
  /**
   * "Interaction times out" is in `docs/REVIEWING_AGENT_OUTPUT.md` for a
   * reason: three seconds to acknowledge, fifteen minutes to follow up, and a
   * missed acknowledgement discards the token rather than queueing. The handler
   * must defer first and act afterwards, so the fake has to be able to punish
   * doing it the other way round.
   */
  it('accepts a defer inside three seconds', async () => {
    const id = await d.emitInteraction({ ...ref, userId: USER, customId: 'x' });
    await expect(
      d.deferInteraction(GUILD, { interactionId: id, token: `tok-${id}` }, { ephemeral: true }),
    ).resolves.toBeUndefined();
    expect(d.wasDeferred(id)).toBe(true);
  });

  it('refuses a defer after three seconds', async () => {
    const id = await d.emitInteraction({ ...ref, userId: USER, customId: 'x' });
    d.advance(3_001);
    await expect(
      d.deferInteraction(GUILD, { interactionId: id, token: `tok-${id}` }, { ephemeral: true }),
    ).rejects.toMatchObject({ code: 10062 });
  });

  it('refuses a slow first response that never deferred', async () => {
    const id = await d.emitInteraction({ ...ref, userId: USER, customId: 'x' });
    d.advance(3_001);
    await expect(
      d.respondToInteraction(GUILD, { interactionId: id, token: `tok-${id}` }, { content: 'hi' }),
    ).rejects.toMatchObject({ code: 10062 });
  });

  it('allows a slow follow-up once deferred', async () => {
    const id = await d.emitInteraction({ ...ref, userId: USER, customId: 'x' });
    await d.deferInteraction(GUILD, { interactionId: id, token: `tok-${id}` }, { ephemeral: true });
    d.advance(60_000);
    await d.respondToInteraction(
      GUILD,
      { interactionId: id, token: `tok-${id}` },
      { content: 'hi' },
    );
    expect(d.interactionReplies(id)).toEqual([{ content: 'hi' }]);
    expect(d.wasEphemeral(id)).toBe(true);
  });

  it('refuses a follow-up after fifteen minutes', async () => {
    const id = await d.emitInteraction({ ...ref, userId: USER, customId: 'x' });
    await d.deferInteraction(GUILD, { interactionId: id, token: `tok-${id}` }, { ephemeral: true });
    d.advance(15 * 60_000 + 1);
    await expect(
      d.respondToInteraction(GUILD, { interactionId: id, token: `tok-${id}` }, { content: 'hi' }),
    ).rejects.toMatchObject({ code: 10062 });
  });

  it('refuses a wrong token, as Discord does', async () => {
    const id = await d.emitInteraction({ ...ref, userId: USER, customId: 'x' });
    await expect(
      d.deferInteraction(GUILD, { interactionId: id, token: 'guessed' }, { ephemeral: true }),
    ).rejects.toMatchObject({ code: 10062 });
  });
});

describe('respondToInteraction returns a ref (ADR 0072)', () => {
  it('reports the channel it knows about from emitInteraction, and a fresh message id', async () => {
    const id = await d.emitInteraction({ ...ref, userId: USER, customId: 'x' });
    await d.deferInteraction(GUILD, { interactionId: id, token: `tok-${id}` }, { ephemeral: true });
    const posted = await d.respondToInteraction(
      GUILD,
      { interactionId: id, token: `tok-${id}` },
      { content: 'ok' },
    );
    expect(posted?.channelId).toBe(CHANNEL);
    expect(posted?.messageId).toBeDefined();
  });

  it('reports undefined when the interaction was registered with no channel', async () => {
    d.registerInteraction({ interactionId: '666666666666666666', token: 'tok' });
    await d.deferInteraction(
      GUILD,
      { interactionId: '666666666666666666', token: 'tok' },
      { ephemeral: true },
    );
    const posted = await d.respondToInteraction(
      GUILD,
      { interactionId: '666666666666666666', token: 'tok' },
      { content: 'ok' },
    );
    expect(posted).toBeUndefined();
  });
});

describe('fetchMessageContent and sendTyping (ADR 0072)', () => {
  it("returns a known message's author and content", async () => {
    d.defineMessage({
      channelId: CHANNEL,
      messageId: '777777777777777777',
      authorId: USER,
      authorName: 'someone',
      content: 'the handbook is pinned in #welcome',
    });
    await expect(d.fetchMessageContent(GUILD, CHANNEL, '777777777777777777')).resolves.toEqual({
      authorId: USER,
      authorName: 'someone',
      content: 'the handbook is pinned in #welcome',
    });
  });

  it('reports undefined for a message it was never told about, or one with no known content', async () => {
    await expect(
      d.fetchMessageContent(GUILD, CHANNEL, '888888888888888888'),
    ).resolves.toBeUndefined();
    // `MESSAGE` was defined in beforeEach with no content.
    await expect(d.fetchMessageContent(GUILD, CHANNEL, MESSAGE)).resolves.toBeUndefined();
  });

  it('records a typing call', async () => {
    await d.sendTyping(GUILD, CHANNEL);
    expect(d.restCalls('sendTyping')).toHaveLength(1);
  });
});

describe('pins, reactions and reply context', () => {
  it('pin then unpin records the call and flips the flag fetchMessageMeta reports', async () => {
    await d.pinMessage(GUILD, ref);
    expect((await d.fetchMessageMeta(GUILD, ref))?.pinned).toBe(true);
    expect(d.restCalls('pinMessage')).toHaveLength(1);

    await d.unpinMessage(GUILD, ref);
    expect((await d.fetchMessageMeta(GUILD, ref))?.pinned).toBe(false);
    expect(d.restCalls('unpinMessage')).toHaveLength(1);
  });

  it('deleteOwnReaction removes the bot reaction from the bucket, others untouched', async () => {
    await d.createReaction(GUILD, ref, BRAIN);
    d.offlineReactionAdd({ ...ref, userId: USER, emoji: BRAIN });

    await d.deleteOwnReaction(GUILD, ref, BRAIN);

    const page = await d.fetchReactionUsers(GUILD, ref, BRAIN);
    expect(page.userIds).toEqual([USER]);
    expect(d.restCalls('deleteOwnReaction')).toHaveLength(1);
  });

  it("fetchMessageAuthor returns a known message's author and content, undefined when unknown", async () => {
    d.defineMessage({
      channelId: CHANNEL,
      messageId: '777777777777777777',
      authorId: USER,
      content: 'the handbook is pinned in #welcome',
    });
    await expect(
      d.fetchMessageAuthor(GUILD, { channelId: CHANNEL, messageId: '777777777777777777' }),
    ).resolves.toEqual({
      authorId: USER,
      content: 'the handbook is pinned in #welcome',
      embeds: [],
    });
    await expect(
      d.fetchMessageAuthor(GUILD, { channelId: CHANNEL, messageId: '888888888888888888' }),
    ).resolves.toBeUndefined();
  });
});

describe('message emitters (PR-66, PR-68, PR-71)', () => {
  it('emitMessageCreate carries attachment ids and shows up in fetchRecentMessages', async () => {
    const attachmentMessageId = '333333333333333335';
    await d.emitMessageCreate({
      channelId: CHANNEL,
      messageId: attachmentMessageId,
      authorId: USER,
      content: 'see attached',
      attachments: [{ attachmentId: 'att-1', fileName: 'a.png', sizeBytes: 10 }],
    });

    const created = seen[0];
    expect(created?.kind).toBe('messageCreate');
    expect(created?.kind === 'messageCreate' ? created.attachments : undefined).toEqual([
      { attachmentId: 'att-1', fileName: 'a.png', sizeBytes: 10 },
    ]);

    // emitMessageCreate does not itself define the message, so it must be
    // defined for fetchRecentMessages to see it — matching defineMessage's
    // existing contract for every other emitter's pre-existing message.
    d.defineMessage({
      channelId: CHANNEL,
      messageId: attachmentMessageId,
      attachments: [{ attachmentId: 'att-1', fileName: 'a.png', sizeBytes: 10 }],
    });
    const page = await d.fetchRecentMessages(GUILD, CHANNEL);
    const fetched = page.messages.find((m) => m.messageId === attachmentMessageId);
    expect(fetched?.attachments).toEqual([
      { attachmentId: 'att-1', fileName: 'a.png', sizeBytes: 10 },
    ]);
  });

  it('emitMessageUpdate updates content and edit timestamp, and fetchRecentMessages agrees', async () => {
    await d.emitMessageUpdate({
      channelId: CHANNEL,
      messageId: MESSAGE,
      authorId: USER,
      content: 'edited content',
      editedTimestampMs: 1_700_000_005_000,
    });

    const updated = seen[0];
    expect(updated?.kind).toBe('messageUpdate');
    expect(updated?.kind === 'messageUpdate' ? updated.content : undefined).toBe('edited content');
    expect(updated?.kind === 'messageUpdate' ? updated.editedTimestampMs : undefined).toBe(
      1_700_000_005_000,
    );

    const page = await d.fetchRecentMessages(GUILD, CHANNEL);
    const fetched = page.messages.find((m) => m.messageId === MESSAGE);
    expect(fetched?.content).toBe('edited content');
    expect(fetched?.editedTimestampMs).toBe(1_700_000_005_000);
  });

  it('emitMessageDelete marks the message deleted so fetchRecentMessages omits it', async () => {
    await d.emitMessageDelete({ channelId: CHANNEL, messageId: MESSAGE, authorId: USER });

    const deleted = seen[0];
    expect(deleted?.kind).toBe('messageDelete');
    expect(deleted?.kind === 'messageDelete' ? deleted.authorId : undefined).toBe(USER);

    const page = await d.fetchRecentMessages(GUILD, CHANNEL);
    expect(page.messages.find((m) => m.messageId === MESSAGE)).toBeUndefined();
  });

  it('emitMessageDeleteBulk emits one event naming every id and deletes them all', async () => {
    const second = '333333333333333336';
    d.defineMessage({ channelId: CHANNEL, messageId: second });

    await d.emitMessageDeleteBulk({ channelId: CHANNEL, messageIds: [MESSAGE, second] });

    expect(seen).toHaveLength(1);
    const bulk = seen[0];
    expect(bulk?.kind).toBe('messageDeleteBulk');
    expect(bulk?.kind === 'messageDeleteBulk' ? bulk.messageIds : undefined).toEqual([
      MESSAGE,
      second,
    ]);

    const page = await d.fetchRecentMessages(GUILD, CHANNEL);
    expect(page.messages).toEqual([]);
  });
});

describe('guild scope', () => {
  it('refuses a call for another guild rather than quietly answering', async () => {
    await expect(d.fetchMember('888888888888888888', USER)).rejects.toThrow(/scoped to guild/);
  });
});

describe('adopted vs managed panels', () => {
  it('refuses to edit a message the bot did not author', async () => {
    // An adopted panel is somebody else's message. This is the API limit that
    // makes adopted panels reaction-only.
    await expect(d.editMessage(GUILD, ref, { content: 'x' })).rejects.toMatchObject({
      code: 50013,
    });
  });

  it('allows editing a message the bot posted', async () => {
    const posted = await d.sendMessage(GUILD, CHANNEL, { content: 'panel' });
    await expect(d.editMessage(GUILD, posted, { content: 'edited' })).resolves.toBeUndefined();
  });
});

describe('call recording', () => {
  it('records each REST call once, in order, for assertions about duplication', async () => {
    await d.addRole(GUILD, USER, ROLE, 'a');
    await d.removeRole(GUILD, USER, ROLE, 'b');
    expect(d.restCalls().map((c) => c.method)).toEqual(['addRole', 'removeRole']);
    expect(d.restCalls('addRole')).toHaveLength(1);
  });

  it('records a call even when it fails, so retries are visible', async () => {
    d.failNext('addRole', FakeDiscord.rateLimited());
    await expect(d.addRole(GUILD, USER, ROLE, 'x')).rejects.toBeInstanceOf(DiscordApiError);
    expect(d.restCalls('addRole')).toHaveLength(1);
  });
});

/**
 * The audit log, which was the least-modelled part of this fake and the part
 * WP4 is built entirely on.
 *
 * Before this it was a hand-populated array with a filter over it, and
 * **nothing in the suite called it** — `defineAuditLogEntry` and
 * `fetchAuditLog` had no callers at all. It modelled none of the four
 * behaviours in ADR 0019, each of which changes the design of inferred
 * deletion attribution. A fixture that makes the problem look easy is how you
 * ship a bot that confidently names the wrong moderator.
 */
describe('the audit log, per ADR 0019', () => {
  const AUTHOR = '666666666666666666';
  const OTHER_AUTHOR = '661666666666666666';
  const MODERATOR = '777777777777777777';
  const OTHER_MODERATOR = '771777777777777777';

  /**
   * Author a message and delete it as `actorUserId`. Nothing useful comes
   * back: a MESSAGE_DELETE entry carries no message id, so there is no handle
   * on the deletion to return.
   */
  const deleteOne = async (actorUserId: string, authorId = AUTHOR): Promise<void> => {
    const messageId = d.nextId();
    d.defineMessage({ channelId: CHANNEL, messageId, authorId });
    await d.deleteMessageAs({ channelId: CHANNEL, messageId, actorUserId });
  };

  const deletions = async (): Promise<readonly AuditLogEntry[]> =>
    d.fetchAuditLog(GUILD, { actionType: 'message_delete' });

  it('records a moderator deletion against the message AUTHOR, not the message', async () => {
    await deleteOne(MODERATOR);
    d.advance(5_000);

    const entries = await deletions();
    expect(entries).toHaveLength(1);
    // There is no message id anywhere in a MESSAGE_DELETE entry, so nothing
    // can correlate on one. This is the fact ADR 0019 exists to record.
    expect(entries[0]?.targetId).toBe(AUTHOR);
    expect(entries[0]?.channelId).toBe(CHANNEL);
    expect(entries[0]?.actorUserId).toBe(MODERATOR);
    expect(entries[0]?.count).toBe(1);
  });

  /**
   * The delete dispatch arrives before the entry exists, so a fetch issued on
   * receipt is expected to find nothing — and finding nothing is not evidence
   * that there was no actor.
   */
  it('dispatches the delete before the entry exists', async () => {
    await deleteOne(MODERATOR);

    expect(seen.filter((e) => e.kind === 'messageDelete')).toHaveLength(1);
    expect(await deletions()).toEqual([]);

    d.advance(5_000);
    expect(await deletions()).toHaveLength(1);
  });

  /**
   * MESSAGE_DELETE carries id, channel and guild and nothing else; discord.js
   * fills the author in from its cache when it has one. An uncached message
   * therefore names nobody, which is the case WP4 has to survive.
   */
  it('dispatches no author when the deleted message was not cached', async () => {
    const messageId = d.nextId();
    d.defineMessage({ channelId: CHANNEL, messageId, authorId: AUTHOR, cached: false });
    await d.deleteMessageAs({ channelId: CHANNEL, messageId, actorUserId: MODERATOR });

    const event = seen.find((e) => e.kind === 'messageDelete');
    expect(event).toBeDefined();
    expect(event?.kind === 'messageDelete' ? event.authorId : 'wrong kind').toBeUndefined();

    // The audit entry still knows the author. The gateway is the impoverished
    // side here, not the log.
    d.advance(5_000);
    expect((await deletions())[0]?.targetId).toBe(AUTHOR);
  });

  /**
   * "Actor unknown" is a common outcome, not an edge case. If this produced an
   * entry, WP4 could attribute every self-deletion to whoever happened to be
   * nearest in the log.
   */
  it('produces NO entry at all when a member deletes their own message', async () => {
    await deleteOne(AUTHOR);
    d.advance(60_000);

    expect(await deletions()).toEqual([]);
  });

  /**
   * The one most likely to break the design. Discord updates ONE entry's count
   * rather than writing an entry per message, so an entry describes a *run* of
   * deletions and the only evidence a new one joined is that the count went up.
   */
  it('coalesces repeated deletions into one entry with a rising count', async () => {
    for (let i = 0; i < 3; i += 1) {
      await deleteOne(MODERATOR);
      d.advance(1_000);
    }
    d.advance(5_000);

    const entries = await deletions();
    expect(entries).toHaveLength(1);
    expect(entries[0]?.count).toBe(3);
  });

  /**
   * The entry's id is minted once, so its timestamp is the FIRST deletion in
   * the run and not the latest. Correlating "the newest entry" against "the
   * delete that just arrived" therefore compares against a timestamp that can
   * be arbitrarily old.
   */
  it('keeps the timestamp of the first deletion in a coalesced run', async () => {
    await deleteOne(MODERATOR);
    const firstAt = d.now();

    d.advance(10_000);
    await deleteOne(MODERATOR);
    d.advance(5_000);

    const entries = await deletions();
    expect(entries).toHaveLength(1);
    expect(entries[0]?.count).toBe(2);
    expect(entries[0]?.createdAtMs).toBe(firstAt);
  });

  /**
   * A consequence of the last one, stated on its own because it is the trap:
   * an entry updated a second ago can sit *below* an older entry, so "read the
   * newest entry" is not a way to find the deletion that just happened.
   */
  it('does not move a coalesced entry to the front when its count rises', async () => {
    await deleteOne(MODERATOR);
    const firstAt = d.now();

    d.advance(30_000);
    await deleteOne(OTHER_MODERATOR);
    const secondAt = d.now();

    d.advance(10_000);
    await deleteOne(MODERATOR); // joins the FIRST run
    d.advance(5_000);

    const entries = await deletions();
    expect(entries.map((e) => e.createdAtMs)).toEqual([secondAt, firstAt]);
    expect(entries.map((e) => e.count)).toEqual([1, 2]);
  });

  it('does not coalesce across different actors', async () => {
    await deleteOne(MODERATOR);
    await deleteOne(OTHER_MODERATOR);
    d.advance(5_000);

    expect(await deletions()).toHaveLength(2);
  });

  it('does not coalesce across different authors', async () => {
    await deleteOne(MODERATOR, AUTHOR);
    await deleteOne(MODERATOR, OTHER_AUTHOR);
    d.advance(5_000);

    expect(await deletions()).toHaveLength(2);
  });

  it('does not coalesce once the window has passed', async () => {
    await deleteOne(MODERATOR);
    d.advance(10 * 60_000);
    await deleteOne(MODERATOR);
    d.advance(5_000);

    const entries = await deletions();
    expect(entries).toHaveLength(2);
    expect(entries.map((e) => e.count)).toEqual([1, 1]);
  });

  it('returns the newest entry first, as Discord does', async () => {
    await deleteOne(MODERATOR);
    d.advance(10 * 60_000);
    await deleteOne(MODERATOR);
    const secondAt = d.now();
    d.advance(5_000);

    expect((await deletions())[0]?.createdAtMs).toBe(secondAt);
  });

  it('filters by action type and honours the limit', async () => {
    await deleteOne(MODERATOR);
    d.defineAuditLogEntry({ actionType: 'member_kick', actorUserId: MODERATOR, targetId: USER });
    d.advance(5_000);

    const kicks = await d.fetchAuditLog(GUILD, { actionType: 'member_kick' });
    expect(kicks).toHaveLength(1);
    expect(kicks[0]?.targetId).toBe(USER);
    // A kick entry has no options, so it has no count — an absent field, not a
    // fabricated one.
    expect(kicks[0]?.count).toBeUndefined();
    expect(await d.fetchAuditLog(GUILD, { actionType: 'message_delete', limit: 0 })).toEqual([]);
  });
});

describe('thread membership (ADR 0115)', () => {
  const THREAD = '666666666666666666';
  const OWNER = '777777777777777777';

  it('answers true for an added member and false for anyone else', async () => {
    d.addThreadMember(THREAD, USER);
    await expect(d.isThreadMember(GUILD, THREAD, USER)).resolves.toBe(true);
    await expect(d.isThreadMember(GUILD, THREAD, OWNER)).resolves.toBe(false);
  });

  it('answers false for a thread the fake was never told about, like a 404', async () => {
    await expect(d.isThreadMember(GUILD, THREAD, USER)).resolves.toBe(false);
  });

  it('keeps membership per thread, not per guild', async () => {
    d.addThreadMember(THREAD, USER);
    await expect(d.isThreadMember(GUILD, '888888888888888888', USER)).resolves.toBe(false);
  });
});

describe('thread info (ADR 0115 sweeper fallback)', () => {
  const THREAD = '666666666666666666';
  const PARENT = '777777777777777777';
  const OTHER_GUILD = '999999999999999999';

  it('answers what defineThread recorded', async () => {
    d.defineThread({ threadId: THREAD, name: 'weekly build night', parentId: PARENT });
    await expect(d.fetchThreadInfo(GUILD, THREAD)).resolves.toEqual({
      id: THREAD,
      name: 'weekly build night',
      parentId: PARENT,
      isPrivate: false,
    });
    d.defineThread({ threadId: '888888888888888888', parentId: PARENT, isPrivate: true });
    await expect(d.fetchThreadInfo(GUILD, '888888888888888888')).resolves.toMatchObject({
      isPrivate: true,
    });
  });

  it('answers undefined for an unknown thread, like a 404', async () => {
    await expect(d.fetchThreadInfo(GUILD, THREAD)).resolves.toBeUndefined();
  });

  it('answers undefined for another guild\u2019s thread, not a scope error', async () => {
    d.defineThread({ threadId: THREAD, parentId: PARENT, guildId: OTHER_GUILD });
    await expect(d.fetchThreadInfo(GUILD, THREAD)).resolves.toBeUndefined();
  });
});
