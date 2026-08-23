import { beforeEach, describe, expect, it } from 'vitest';
import { DiscordApiError, unicodeEmojiKey, type DomainEvent } from '@bananasaurs/core';
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
    d.deleteMessage(ref);
    await expect(d.fetchMessage(GUILD, ref)).rejects.toMatchObject({ code: 10008 });
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
