import { describe, expect, it } from 'vitest';
import { REST } from 'discord.js';
import { DiscordApiError, DiscordErrorCode } from '@bananasaurs/core';
import { REST_OPTIONS } from '../client.js';
import { createDiscordRestPort } from './index.js';

/**
 * The REST port, tested against the real `@discordjs/rest` stack with only the
 * socket replaced.
 *
 * `makeRequest` is the documented injection point, so route building, query
 * serialisation, rate-limit accounting and `DiscordAPIError` construction are
 * all the library's own — which is the point. A hand-rolled fake of the HTTP
 * layer would let the error mapping be tested against errors we invented, and
 * mapping *discord.js's* errors onto `packages/core/src/discord/errors.ts` is
 * the entire job of this file's subject.
 */

const GUILD = '234567890123456789';
const OTHER_GUILD = '345678901234567890';
const BOT = '999999999999999999';
const USER = '111111111111111111';
const ROLE = '222222222222222222';
const CHANNEL = '333333333333333333';
const MESSAGE = '444444444444444444';
const APPLICATION = '555555555555555555';

const THUMBS_UP = 'u:1f44d'; // 👍
const CUSTOM = 'c:666666666666666666';

interface Reply {
  status: number;
  body?: unknown;
  headers?: Record<string, string>;
}

interface Recorded {
  method: string;
  path: string;
  query: string;
  body: unknown;
  reason: string | undefined;
  authorization: string | undefined;
}

function harness(replies: Reply[] = [{ status: 204 }], restOptions: Record<string, unknown> = {}) {
  const requests: Recorded[] = [];
  let next = 0;

  const rest = new REST({
    ...REST_OPTIONS,
    ...restOptions,
    makeRequest: async (url, init) => {
      const parsed = new URL(url);
      const headers = new Headers(init.headers);
      requests.push({
        method: init.method ?? 'GET',
        path: parsed.pathname,
        query: parsed.search,
        body: typeof init.body === 'string' ? JSON.parse(init.body) : undefined,
        // discord.js percent-encodes this header, correctly: it must be
        // ASCII-safe on the wire and a reason can contain anything.
        reason: decodeURIComponent(headers.get('x-audit-log-reason') ?? '') || undefined,
        authorization: headers.get('authorization') ?? undefined,
      });
      const reply = replies[Math.min(next, replies.length - 1)] ?? { status: 204 };
      next += 1;
      const hasBody = reply.body !== undefined;
      return new Response(hasBody ? JSON.stringify(reply.body) : null, {
        status: reply.status,
        headers: {
          ...(hasBody ? { 'content-type': 'application/json' } : {}),
          ...reply.headers,
        },
      });
    },
  });
  rest.setToken('not-a-real-token');

  const port = createDiscordRestPort({
    rest,
    applicationId: APPLICATION,
    botUserId: () => BOT,
  });

  return { port, requests, rest };
}

const last = (requests: Recorded[]): Recorded => {
  const call = requests.at(-1);
  if (!call) throw new Error('no request was made');
  return call;
};

describe('roles', () => {
  it('adds a role on the guild-scoped route, with the reason in the audit header', async () => {
    const { port, requests } = harness();
    await port.addRole(GUILD, USER, ROLE, 'panel: alpha');

    expect(last(requests).method).toBe('PUT');
    expect(last(requests).path).toBe(`/api/v10/guilds/${GUILD}/members/${USER}/roles/${ROLE}`);
    expect(last(requests).reason).toBe('panel: alpha');
  });

  it('removes a role with DELETE on the same route', async () => {
    const { port, requests } = harness();
    await port.removeRole(GUILD, USER, ROLE, 'panel: alpha withdrawn');

    expect(last(requests).method).toBe('DELETE');
    expect(last(requests).path).toBe(`/api/v10/guilds/${GUILD}/members/${USER}/roles/${ROLE}`);
    expect(last(requests).reason).toBe('panel: alpha withdrawn');
  });

  /**
   * Guild scope is a mandatory partition key (CLAUDE.md rule 2). For this port
   * it is structural in the strongest available sense: the guild id is a path
   * segment, so a call that omitted it would not address a valid endpoint at all.
   */
  it('puts the guild id in the URL, so a call cannot reach another guild', async () => {
    const { port, requests } = harness();
    await port.addRole(OTHER_GUILD, USER, ROLE, 'r');
    expect(last(requests).path).toContain(`/guilds/${OTHER_GUILD}/`);
    expect(last(requests).path).not.toContain(GUILD);
  });

  it('reads live role positions, including whether a role is integration-managed', async () => {
    const { port } = harness([
      {
        status: 200,
        body: [
          { id: ROLE, name: 'alpha', position: 3, managed: false },
          { id: '777777777777777777', name: 'booster', position: 9, managed: true },
        ],
      },
    ]);

    await expect(port.fetchRoles(GUILD)).resolves.toEqual([
      { id: ROLE, name: 'alpha', position: 3, managed: false },
      { id: '777777777777777777', name: 'booster', position: 9, managed: true },
    ]);
  });

  it("computes the bot's highest position from the roles it actually holds", async () => {
    const { port } = harness([
      { status: 200, body: { user: { id: BOT }, roles: [ROLE, '777777777777777777'] } },
      {
        status: 200,
        body: [
          { id: ROLE, name: 'alpha', position: 3, managed: false },
          { id: '777777777777777777', name: 'bot-role', position: 12, managed: true },
          { id: '888888888888888888', name: 'above', position: 30, managed: false },
        ],
      },
    ]);

    await expect(port.fetchBotHighestRolePosition(GUILD)).resolves.toBe(12);
  });

  /**
   * A bot with no roles sits at @everyone, which is position 0. Returning
   * anything else would make every role look assignable.
   */
  it('reports position 0 when the bot holds no roles at all', async () => {
    const { port } = harness([
      { status: 200, body: { user: { id: BOT }, roles: [] } },
      { status: 200, body: [{ id: ROLE, name: 'alpha', position: 3, managed: false }] },
    ]);

    await expect(port.fetchBotHighestRolePosition(GUILD)).resolves.toBe(0);
  });
});

describe('members', () => {
  it('maps a member to the port shape', async () => {
    const { port } = harness([
      { status: 200, body: { user: { id: USER }, roles: [ROLE] } },
      { status: 200, body: { id: GUILD, owner_id: '000000000000000001' } },
    ]);

    await expect(port.fetchMember(GUILD, USER)).resolves.toEqual({
      userId: USER,
      roleIds: [ROLE],
      isGuildOwner: false,
    });
  });

  it('recognises the guild owner, whom Discord never lets a bot act on', async () => {
    const { port } = harness([
      { status: 200, body: { user: { id: USER }, roles: [] } },
      { status: 200, body: { id: GUILD, owner_id: USER } },
    ]);

    await expect(port.fetchMember(GUILD, USER)).resolves.toMatchObject({ isGuildOwner: true });
  });

  /**
   * Ownership is read from the gateway cache when the composition root supplies
   * a resolver, because `GUILD_CREATE` already carries `owner_id` and keeps it
   * current through `GUILD_UPDATE`. Without this every member fetch costs two
   * requests against the same rate cap — and reconciliation fetches one member
   * per drifted member.
   */
  it('uses the supplied owner resolver instead of a second request', async () => {
    const rest = harness([{ status: 200, body: { user: { id: USER }, roles: [ROLE] } }]);
    const port = createDiscordRestPort({
      rest: rest.rest,
      applicationId: APPLICATION,
      botUserId: () => BOT,
      guildOwnerId: (guildId) => (guildId === GUILD ? USER : undefined),
    });

    await expect(port.fetchMember(GUILD, USER)).resolves.toMatchObject({ isGuildOwner: true });
    expect(rest.requests).toHaveLength(1);
  });

  it('falls back to fetching the guild when the resolver does not know', async () => {
    const rest = harness([
      { status: 200, body: { user: { id: USER }, roles: [] } },
      { status: 200, body: { id: GUILD, owner_id: USER } },
    ]);
    const port = createDiscordRestPort({
      rest: rest.rest,
      applicationId: APPLICATION,
      botUserId: () => BOT,
      guildOwnerId: () => undefined,
    });

    await expect(port.fetchMember(GUILD, USER)).resolves.toMatchObject({ isGuildOwner: true });
    expect(rest.requests).toHaveLength(2);
  });
});

describe('messages and reactions', () => {
  it('fetches a message to prove it exists', async () => {
    const { port, requests } = harness([{ status: 200, body: { id: MESSAGE } }]);
    await expect(
      port.fetchMessage(GUILD, { channelId: CHANNEL, messageId: MESSAGE }),
    ).resolves.toEqual({ exists: true });
    expect(last(requests).path).toBe(`/api/v10/channels/${CHANNEL}/messages/${MESSAGE}`);
  });

  /**
   * Asserted on the **decoded** path, deliberately.
   *
   * The obvious assertion — that the path equals the `encodeURIComponent` form —
   * is decoration: `new URL()` percent-encodes a raw emoji in a path anyway, so
   * it passes whether or not the adapter encodes. (Measured: mutation 50 removed
   * the encoding and every test still passed.) What can actually go wrong is
   * *double* encoding, which sends `%F0%9F%91%8D` as a literal and reacts with
   * nonsense, and decoding once catches exactly that.
   */
  it('seeds a unicode reaction on the @me route, encoded exactly once', async () => {
    const { port, requests } = harness();
    await port.createReaction(GUILD, { channelId: CHANNEL, messageId: MESSAGE }, THUMBS_UP);

    expect(last(requests).method).toBe('PUT');
    expect(decodeURIComponent(last(requests).path)).toBe(
      `/api/v10/channels/${CHANNEL}/messages/${MESSAGE}/reactions/👍/@me`,
    );
  });

  /**
   * Live-verified, `docs/reports/WP5-slice-6-live-test.md` finding 1: 🅱️ is
   * U+1F171 U+FE0F, `unicodeEmojiKey` strips U+FE0F for storage, and a bare
   * U+1F171 query against real Discord matched nothing — every reactor query
   * for the doc's own default emoji silently returned zero people.
   */
  it('restores the variation selector for a button emoji whose canonical form needs it', async () => {
    const { port, requests } = harness();
    await port.createReaction(GUILD, { channelId: CHANNEL, messageId: MESSAGE }, 'u:1f171');
    expect(decodeURIComponent(last(requests).path)).toBe(
      `/api/v10/channels/${CHANNEL}/messages/${MESSAGE}/reactions/🅱️/@me`,
    );
  });

  it('restores the selector when fetching reactors too, not only when reacting', async () => {
    const { port, requests } = harness([{ status: 200, body: [] }]);
    await port.fetchReactionUsers(GUILD, { channelId: CHANNEL, messageId: MESSAGE }, 'u:1f171', {
      limit: 100,
    });
    expect(decodeURIComponent(last(requests).path)).toContain('/reactions/🅱️');
  });

  it('turns a multi-codepoint emoji key back into the whole sequence', async () => {
    const { port, requests } = harness();
    // U+1F468 U+200D U+1F4BB — one emoji, three codepoints. Splitting on the
    // hyphen wrongly, or taking only the first, silently reacts with something
    // else and the panel option never matches.
    await port.createReaction(
      GUILD,
      { channelId: CHANNEL, messageId: MESSAGE },
      'u:1f468-200d-1f4bb',
    );
    expect(decodeURIComponent(last(requests).path)).toContain('/reactions/👨‍💻/@me');
  });

  /**
   * `EmojiKey` carries a custom emoji's id and not its name, but Discord's
   * reaction route is documented as `name:id`. The name is a placeholder here —
   * flagged for the live smoke test, since it cannot be verified without a
   * connection.
   */
  it('sends a custom reaction in name:id form', async () => {
    const { port, requests } = harness();
    await port.createReaction(GUILD, { channelId: CHANNEL, messageId: MESSAGE }, CUSTOM);
    expect(decodeURIComponent(last(requests).path)).toContain('reactions/_:666666666666666666/@me');
  });

  it('pages reaction users and asks for the documented maximum', async () => {
    const { port, requests } = harness([{ status: 200, body: [{ id: USER }, { id: BOT }] }]);
    const page = await port.fetchReactionUsers(
      GUILD,
      { channelId: CHANNEL, messageId: MESSAGE },
      THUMBS_UP,
      { limit: 100 },
    );

    // The bot is NOT filtered out: Discord's GET /reactions returns every user
    // who reacted, bot accounts included. WP1 modelled this the other way.
    expect(page.userIds).toEqual([USER, BOT]);
    expect(last(requests).query).toContain('limit=100');
  });

  /**
   * Real Discord cannot say "that was the last page" — it returns users and
   * nothing else. So a *full* page always yields a cursor, even when it happens
   * to have exhausted the reactors, and the caller finds out by getting an empty
   * page next. The fake used to know the total and answer `undefined` early,
   * which no adapter over the real API can do.
   */
  it('offers a cursor whenever the page came back full', async () => {
    const body = Array.from({ length: 100 }, (_, i) => ({
      id: String(100000000000000000n + BigInt(i)),
    }));
    const { port } = harness([{ status: 200, body }]);
    const page = await port.fetchReactionUsers(
      GUILD,
      { channelId: CHANNEL, messageId: MESSAGE },
      THUMBS_UP,
      { limit: 100 },
    );
    expect(page.nextAfter).toBe(body[99]?.id);
  });

  it('stops when a short page proves there is no more', async () => {
    const { port } = harness([{ status: 200, body: [{ id: USER }] }]);
    const page = await port.fetchReactionUsers(
      GUILD,
      { channelId: CHANNEL, messageId: MESSAGE },
      THUMBS_UP,
      { limit: 100 },
    );
    expect(page.nextAfter).toBeUndefined();
  });

  it('passes the cursor back as after', async () => {
    const { port, requests } = harness([{ status: 200, body: [] }]);
    await port.fetchReactionUsers(GUILD, { channelId: CHANNEL, messageId: MESSAGE }, THUMBS_UP, {
      after: USER,
    });
    expect(last(requests).query).toContain(`after=${USER}`);
  });

  it('posts a message and returns the ref the caller needs', async () => {
    const { port, requests } = harness([
      { status: 200, body: { id: MESSAGE, channel_id: CHANNEL } },
    ]);
    await expect(port.sendMessage(GUILD, CHANNEL, { content: 'hello' })).resolves.toEqual({
      channelId: CHANNEL,
      messageId: MESSAGE,
    });
    expect(last(requests).method).toBe('POST');
    expect(last(requests).body).toMatchObject({ content: 'hello' });
  });

  it('carries allowedMentions to the wire as snake_case allowed_mentions (C1)', async () => {
    // Asserted on the wire body, not on the OutgoingMessage: the adapter once
    // dropped this field, and a fake-port assertion one layer up could not see
    // it. `@everyone` content without this key pings the whole guild.
    const { port, requests } = harness([
      { status: 200, body: { id: MESSAGE, channel_id: CHANNEL } },
    ]);
    await port.sendMessage(GUILD, CHANNEL, {
      content: '@everyone hello club',
      allowedMentions: { parse: [] },
    });
    expect(last(requests).body).toMatchObject({
      content: '@everyone hello club',
      allowed_mentions: { parse: [] },
    });
  });

  it('carries allowedMentions roles to the wire (IT escalation reviewer ping)', async () => {
    // The integration once dropped `roles`, so the escalation posted the
    // reviewer role as plain text and nobody was notified.
    const { port, requests } = harness([
      { status: 200, body: { id: MESSAGE, channel_id: CHANNEL } },
    ]);
    await port.sendMessage(GUILD, CHANNEL, {
      content: '<@&555555555555555555> IT request it-1',
      allowedMentions: { parse: [], roles: ['555555555555555555'] },
    });
    expect(last(requests).body).toMatchObject({
      allowed_mentions: { parse: [], roles: ['555555555555555555'] },
    });
  });

  it('carries parse everyone, users and roles to the wire as snake_case', async () => {
    // Task C: reminder delivery pings exactly the stored targets — `parse:
    // ['everyone']` plus explicit user and role id lists.
    const { port, requests } = harness([
      { status: 200, body: { id: MESSAGE, channel_id: CHANNEL } },
    ]);
    await port.sendMessage(GUILD, CHANNEL, {
      content: '@everyone <@&222222222222222222> <@111111111111111111> standup',
      allowedMentions: {
        parse: ['everyone'],
        users: ['111111111111111111'],
        roles: ['222222222222222222'],
      },
    });
    expect(last(requests).body).toMatchObject({
      allowed_mentions: {
        parse: ['everyone'],
        users: ['111111111111111111'],
        roles: ['222222222222222222'],
      },
    });
  });

  it('sends no users key at all when the message does not set it', async () => {
    const { port, requests } = harness([
      { status: 200, body: { id: MESSAGE, channel_id: CHANNEL } },
    ]);
    await port.sendMessage(GUILD, CHANNEL, {
      content: 'hello',
      allowedMentions: { parse: [] },
    });
    expect(last(requests).body).toMatchObject({ allowed_mentions: { parse: [] } });
    expect(
      (last(requests).body as { allowed_mentions: Record<string, unknown> }).allowed_mentions,
    ).not.toHaveProperty('users');
  });

  it('sends no allowed_mentions key at all when the message does not set it (M5-D2)', async () => {
    // Opt-in: panel posts and log messages never set `allowedMentions`, and a
    // default here would change what they send while two guilds are observed.
    const { port, requests } = harness([
      { status: 200, body: { id: MESSAGE, channel_id: CHANNEL } },
    ]);
    await port.sendMessage(GUILD, CHANNEL, { content: 'hello' });
    expect(last(requests).body).toMatchObject({ content: 'hello' });
    expect(last(requests).body).not.toHaveProperty('allowed_mentions');
    expect(last(requests).body).not.toHaveProperty('allowedMentions');
  });

  it('edits a message in place', async () => {
    const { port, requests } = harness([{ status: 200, body: { id: MESSAGE } }]);
    await port.editMessage(GUILD, { channelId: CHANNEL, messageId: MESSAGE }, { content: 'new' });
    expect(last(requests).method).toBe('PATCH');
    expect(last(requests).path).toBe(`/api/v10/channels/${CHANNEL}/messages/${MESSAGE}`);
  });

  /**
   * ADR 0035: deletion is deliberately NOT hierarchy-gated. A bot with Manage
   * Messages can delete any member's message, owner included, so this route
   * carries only the audit reason, the same shape as `addRole`/`removeRole`.
   */
  it('deletes a message with the reason in the audit header', async () => {
    const { port, requests } = harness();
    await port.deleteMessage(
      GUILD,
      { channelId: CHANNEL, messageId: MESSAGE },
      'automod: blocked keyword',
    );
    expect(last(requests).method).toBe('DELETE');
    expect(last(requests).path).toBe(`/api/v10/channels/${CHANNEL}/messages/${MESSAGE}`);
    expect(last(requests).reason).toBe('automod: blocked keyword');
  });

  /**
   * ADR 0072: replying carries a `message_reference` and forces
   * `replied_user: true` in on top of `parse: []`, so a reply actually pings
   * the member being replied to.
   */
  it('emits message_reference and replied_user: true when replyTo is set', async () => {
    const { port, requests } = harness([
      { status: 200, body: { id: MESSAGE, channel_id: CHANNEL } },
    ]);
    await port.sendMessage(GUILD, CHANNEL, {
      content: 'and what about parking?',
      replyTo: '600000000000000001',
    });
    expect(last(requests).body).toMatchObject({
      content: 'and what about parking?',
      message_reference: { message_id: '600000000000000001', fail_if_not_exists: false },
      allowed_mentions: { parse: [], replied_user: true },
    });
  });

  it('keeps replyTo output byte-identical when it is absent (no regression)', async () => {
    const { port, requests } = harness([
      { status: 200, body: { id: MESSAGE, channel_id: CHANNEL } },
    ]);
    await port.sendMessage(GUILD, CHANNEL, { content: 'hello' });
    expect(last(requests).body).toEqual({ content: 'hello' });
  });

  it("keeps replyTo's replied_user alongside an explicit allowedMentions.roles", async () => {
    const { port, requests } = harness([
      { status: 200, body: { id: MESSAGE, channel_id: CHANNEL } },
    ]);
    await port.sendMessage(GUILD, CHANNEL, {
      content: 'reply with a role ping',
      allowedMentions: { parse: [], roles: ['555555555555555555'] },
      replyTo: '600000000000000001',
    });
    expect(last(requests).body).toMatchObject({
      allowed_mentions: { parse: [], roles: ['555555555555555555'], replied_user: true },
      message_reference: { message_id: '600000000000000001', fail_if_not_exists: false },
    });
  });

  it("fetches one message's content and author", async () => {
    const { port, requests } = harness([
      {
        status: 200,
        body: {
          id: MESSAGE,
          channel_id: CHANNEL,
          author: { id: USER, username: 'member', global_name: 'Member Name' },
          content: 'the handbook is pinned in #welcome',
        },
      },
    ]);
    await expect(port.fetchMessageContent(GUILD, CHANNEL, MESSAGE)).resolves.toEqual({
      authorId: USER,
      authorName: 'Member Name',
      content: 'the handbook is pinned in #welcome',
    });
    expect(last(requests).method).toBe('GET');
    expect(last(requests).path).toBe(`/api/v10/channels/${CHANNEL}/messages/${MESSAGE}`);
  });

  it('prefers the guild nickname over the global name for the quoted author', async () => {
    const { port } = harness([
      {
        status: 200,
        body: {
          id: MESSAGE,
          channel_id: CHANNEL,
          author: { id: USER, username: 'member', global_name: 'Member Name' },
          member: { nick: 'Clubhouse Nick' },
          content: 'hi',
        },
      },
    ]);
    await expect(port.fetchMessageContent(GUILD, CHANNEL, MESSAGE)).resolves.toMatchObject({
      authorName: 'Clubhouse Nick',
    });
  });

  it('reports undefined rather than throwing on 404 or 403', async () => {
    const gone = harness([
      { status: 404, body: { code: DiscordErrorCode.UnknownMessage, message: 'Unknown Message' } },
    ]);
    await expect(gone.port.fetchMessageContent(GUILD, CHANNEL, MESSAGE)).resolves.toBeUndefined();

    const forbidden = harness([
      { status: 403, body: { code: DiscordErrorCode.MissingAccess, message: 'Missing Access' } },
    ]);
    await expect(
      forbidden.port.fetchMessageContent(GUILD, CHANNEL, MESSAGE),
    ).resolves.toBeUndefined();
  });

  it('still raises anything else (e.g. a rate limit)', async () => {
    const { port } = harness([{ status: 500, body: { message: 'internal error' } }]);
    await expect(port.fetchMessageContent(GUILD, CHANNEL, MESSAGE)).rejects.toBeInstanceOf(
      DiscordApiError,
    );
  });

  it('fetches channel messages oldest first with before and limit', async () => {
    const { port, requests } = harness([
      {
        status: 200,
        // Discord returns newest first; the port reports oldest first.
        body: [
          {
            id: '444444444444444446',
            channel_id: CHANNEL,
            author: { id: USER, username: 'sam' },
            content: 'second',
            timestamp: '2026-09-20T12:01:00.000Z',
            attachments: [{ id: '1', filename: 'notes.txt', size: 12 }],
            referenced_message: {
              id: '444444444444444444',
              author: { id: '777777777777777777', username: 'ana' },
            },
          },
          {
            id: '444444444444444445',
            channel_id: CHANNEL,
            author: { id: BOT, username: 'bananasaurs', bot: true },
            content: 'first',
            timestamp: '2026-09-20T12:00:00.000Z',
            attachments: [],
          },
        ],
      },
    ]);
    const messages = await port.fetchChannelMessages(GUILD, CHANNEL, {
      before: MESSAGE,
      limit: 15,
    });
    expect(messages).toEqual([
      {
        messageId: '444444444444444445',
        authorId: BOT,
        authorName: 'bananasaurs',
        authorIsBot: true,
        content: 'first',
        at: Date.parse('2026-09-20T12:00:00.000Z'),
        hasAttachments: false,
      },
      {
        messageId: '444444444444444446',
        authorId: USER,
        authorName: 'sam',
        authorIsBot: false,
        content: 'second',
        at: Date.parse('2026-09-20T12:01:00.000Z'),
        referencedAuthorName: 'ana',
        hasAttachments: true,
      },
    ]);
    expect(last(requests).method).toBe('GET');
    expect(last(requests).path).toBe(`/api/v10/channels/${CHANNEL}/messages`);
    expect(last(requests).query).toContain(`before=${MESSAGE}`);
    expect(last(requests).query).toContain('limit=15');
  });

  it('prefers the guild nickname for channel message authors', async () => {
    const { port } = harness([
      {
        status: 200,
        body: [
          {
            id: '444444444444444445',
            channel_id: CHANNEL,
            author: { id: USER, username: 'sam', global_name: 'Sam Global' },
            member: { nick: 'Sam Nick' },
            content: 'hi',
            timestamp: '2026-09-20T12:00:00.000Z',
            attachments: [],
          },
        ],
      },
    ]);
    const messages = await port.fetchChannelMessages(GUILD, CHANNEL, {
      before: MESSAGE,
      limit: 15,
    });
    expect(messages?.[0]).toMatchObject({ authorName: 'Sam Nick' });
  });

  it('clamps the channel message limit to 1–50', async () => {
    const high = harness([{ status: 200, body: [] }]);
    await high.port.fetchChannelMessages(GUILD, CHANNEL, { before: MESSAGE, limit: 200 });
    expect(last(high.requests).query).toContain('limit=50');

    const low = harness([{ status: 200, body: [] }]);
    await low.port.fetchChannelMessages(GUILD, CHANNEL, { before: MESSAGE, limit: 0 });
    expect(last(low.requests).query).toContain('limit=1');
  });

  it('omits before from the channel messages query when absent', async () => {
    const { port, requests } = harness([{ status: 200, body: [] }]);
    await port.fetchChannelMessages(GUILD, CHANNEL, { limit: 15 });
    expect(last(requests).method).toBe('GET');
    expect(last(requests).path).toBe(`/api/v10/channels/${CHANNEL}/messages`);
    expect(last(requests).query).toContain('limit=15');
    expect(last(requests).query).not.toContain('before');
  });

  it('reports undefined rather than throwing on 404 or 403', async () => {
    const gone = harness([
      { status: 404, body: { code: DiscordErrorCode.UnknownMessage, message: 'Unknown Message' } },
    ]);
    await expect(
      gone.port.fetchChannelMessages(GUILD, CHANNEL, { before: MESSAGE, limit: 15 }),
    ).resolves.toBeUndefined();

    const forbidden = harness([
      { status: 403, body: { code: DiscordErrorCode.MissingAccess, message: 'Missing Access' } },
    ]);
    await expect(
      forbidden.port.fetchChannelMessages(GUILD, CHANNEL, { before: MESSAGE, limit: 15 }),
    ).resolves.toBeUndefined();
  });

  it('still raises anything else for channel messages (e.g. a server error)', async () => {
    const { port } = harness([{ status: 500, body: { message: 'internal error' } }]);
    await expect(
      port.fetchChannelMessages(GUILD, CHANNEL, { before: MESSAGE, limit: 15 }),
    ).rejects.toBeInstanceOf(DiscordApiError);
  });

  it('sends a typing indicator on the channel typing route', async () => {
    const { port, requests } = harness();
    await port.sendTyping(GUILD, CHANNEL);
    expect(last(requests).method).toBe('POST');
    expect(last(requests).path).toBe(`/api/v10/channels/${CHANNEL}/typing`);
  });
});

describe('message metadata (slice 2 task 6)', () => {
  const metaBody = (over: Record<string, unknown> = {}) => ({
    id: MESSAGE,
    channel_id: CHANNEL,
    author: { id: USER, username: 'sam' },
    content: 'the handbook is pinned in #welcome',
    pinned: true,
    reactions: [
      { count: 2, emoji: { id: null, name: '👍' } },
      { count: 1, emoji: { id: '666666666666666666', name: 'party' } },
    ],
    ...over,
  });

  it('projects pinned and reactions off the channel-message route', async () => {
    const { port, requests } = harness([{ status: 200, body: metaBody() }]);
    await expect(
      port.fetchMessageMeta(GUILD, { channelId: CHANNEL, messageId: MESSAGE }),
    ).resolves.toEqual({
      pinned: true,
      reactions: [
        { emoji: '👍', count: 2 },
        { emoji: '<:party:666666666666666666>', count: 1 },
      ],
    });
    expect(last(requests).method).toBe('GET');
    expect(last(requests).path).toBe(`/api/v10/channels/${CHANNEL}/messages/${MESSAGE}`);
  });

  it('reports an unpinned message with no reactions as empty rather than absent', async () => {
    const { port } = harness([{ status: 200, body: metaBody({ pinned: false }) }]);
    await expect(
      port.fetchMessageMeta(GUILD, { channelId: CHANNEL, messageId: MESSAGE }),
    ).resolves.toEqual({
      pinned: false,
      reactions: [
        { emoji: '👍', count: 2 },
        { emoji: '<:party:666666666666666666>', count: 1 },
      ],
    });
  });

  it('reports no reactions field as an empty list', async () => {
    const { port } = harness([
      {
        status: 200,
        body: {
          id: MESSAGE,
          channel_id: CHANNEL,
          author: { id: USER, username: 'sam' },
          content: 'no one reacted to this',
          pinned: true,
        },
      },
    ]);
    await expect(
      port.fetchMessageMeta(GUILD, { channelId: CHANNEL, messageId: MESSAGE }),
    ).resolves.toEqual({ pinned: true, reactions: [] });
  });

  it('answers undefined rather than throwing on 404 or 403', async () => {
    const gone = harness([
      { status: 404, body: { code: DiscordErrorCode.UnknownMessage, message: 'Unknown Message' } },
    ]);
    await expect(
      gone.port.fetchMessageMeta(GUILD, { channelId: CHANNEL, messageId: MESSAGE }),
    ).resolves.toBeUndefined();

    const forbidden = harness([
      { status: 403, body: { code: DiscordErrorCode.MissingAccess, message: 'Missing Access' } },
    ]);
    await expect(
      forbidden.port.fetchMessageMeta(GUILD, { channelId: CHANNEL, messageId: MESSAGE }),
    ).resolves.toBeUndefined();
  });

  it('still raises anything else (e.g. a server error)', async () => {
    const { port } = harness([{ status: 500, body: { message: 'internal error' } }]);
    await expect(
      port.fetchMessageMeta(GUILD, { channelId: CHANNEL, messageId: MESSAGE }),
    ).rejects.toBeInstanceOf(DiscordApiError);
  });
});

describe('moderation', () => {
  it('times out a member with an ISO timestamp and the reason in the audit header', async () => {
    const { port, requests } = harness();
    await port.timeoutMember(GUILD, USER, 60_000, 'automod: rate limit');

    expect(last(requests).method).toBe('PATCH');
    expect(last(requests).path).toBe(`/api/v10/guilds/${GUILD}/members/${USER}`);
    expect(last(requests).body).toMatchObject({
      communication_disabled_until: expect.any(String),
    });
    expect(last(requests).reason).toBe('automod: rate limit');
  });

  it('untimeouts by setting communication_disabled_until to null', async () => {
    const { port, requests } = harness();
    await port.untimeoutMember(GUILD, USER, 'mod: appeal accepted');

    expect(last(requests).method).toBe('PATCH');
    expect(last(requests).path).toBe(`/api/v10/guilds/${GUILD}/members/${USER}`);
    expect(last(requests).body).toMatchObject({
      communication_disabled_until: null,
    });
    expect(last(requests).reason).toBe('mod: appeal accepted');
  });

  it('kicks a member on the guild member route, with the reason in the audit header', async () => {
    const { port, requests } = harness();
    await port.kickMember(GUILD, USER, 'automod: repeated violations');

    expect(last(requests).method).toBe('DELETE');
    expect(last(requests).path).toBe(`/api/v10/guilds/${GUILD}/members/${USER}`);
    expect(last(requests).reason).toBe('automod: repeated violations');
  });

  /**
   * ADR 0037: ban carries no message-deletion parameter — message removal is
   * purge's explicit job, and Discord's `delete_message_days` is deprecated.
   */
  it('bans a member on the guild ban route, with no deletion parameter', async () => {
    const { port, requests } = harness();
    await port.banMember(GUILD, USER, 'mod: confirmed ban');

    expect(last(requests).method).toBe('PUT');
    expect(last(requests).path).toBe(`/api/v10/guilds/${GUILD}/bans/${USER}`);
    expect(last(requests).body).toBeUndefined();
    expect(last(requests).reason).toBe('mod: confirmed ban');
  });

  it('lifts a ban with DELETE on the same route', async () => {
    const { port, requests } = harness();
    await port.unbanMember(GUILD, USER, 'mod: appeal accepted');

    expect(last(requests).method).toBe('DELETE');
    expect(last(requests).path).toBe(`/api/v10/guilds/${GUILD}/bans/${USER}`);
    expect(last(requests).reason).toBe('mod: appeal accepted');
  });

  it('bulk-deletes on the bulk-delete route, ids in the body', async () => {
    const { port, requests } = harness();
    await port.bulkDeleteMessages(GUILD, CHANNEL, [MESSAGE, '444444444444444445'], 'mod: purge');

    expect(last(requests).method).toBe('POST');
    expect(last(requests).path).toBe(`/api/v10/channels/${CHANNEL}/messages/bulk-delete`);
    expect(last(requests).body).toMatchObject({
      messages: [MESSAGE, '444444444444444445'],
    });
    expect(last(requests).reason).toBe('mod: purge');
  });

  it('fetches recent messages newest-first, honouring before and limit', async () => {
    const { port } = harness([
      {
        status: 200,
        body: [
          { id: '444444444444444445', author: { id: USER }, content: 'newer' },
          { id: MESSAGE, author: { id: USER }, content: 'older' },
        ],
      },
    ]);
    const page = await port.fetchRecentMessages(GUILD, CHANNEL, {
      before: '444444444444444446',
      limit: 2,
    });

    expect(page.messages).toEqual([
      {
        messageId: '444444444444444445',
        authorId: USER,
        createdAtMs: expect.any(Number),
        content: 'newer',
        editedTimestampMs: undefined,
        attachments: [],
      },
      {
        messageId: MESSAGE,
        authorId: USER,
        createdAtMs: expect.any(Number),
        content: 'older',
        editedTimestampMs: undefined,
        attachments: [],
      },
    ]);
    // A full page offers a cursor; the caller pages until it is undefined.
    expect(page.nextBefore).toBe(MESSAGE);
  });

  it('maps edited_timestamp and attachment metadata on a fetched message', async () => {
    const { port } = harness([
      {
        status: 200,
        body: [
          {
            id: MESSAGE,
            author: { id: USER },
            content: 'edited with a file',
            edited_timestamp: '2026-08-30T01:00:00.000Z',
            attachments: [
              {
                id: '123456789012345678',
                filename: 'notes.txt',
                content_type: 'text/plain',
                size: 12,
              },
            ],
          },
        ],
      },
    ]);
    const page = await port.fetchRecentMessages(GUILD, CHANNEL, { limit: 2 });

    expect(page.messages).toEqual([
      {
        messageId: MESSAGE,
        authorId: USER,
        createdAtMs: expect.any(Number),
        content: 'edited with a file',
        editedTimestampMs: Date.parse('2026-08-30T01:00:00.000Z'),
        attachments: [
          {
            attachmentId: '123456789012345678',
            fileName: 'notes.txt',
            contentType: 'text/plain',
            sizeBytes: 12,
          },
        ],
      },
    ]);
    expect(page.nextBefore).toBeUndefined();
  });

  it('reports no cursor when the page came back short', async () => {
    const { port } = harness([
      { status: 200, body: [{ id: MESSAGE, author: { id: USER }, content: 'only' }] },
    ]);
    const page = await port.fetchRecentMessages(GUILD, CHANNEL, { limit: 2 });
    expect(page.messages).toHaveLength(1);
    expect(page.nextBefore).toBeUndefined();
  });
});

describe('interactions', () => {
  it('defers with the deferred-reply callback type', async () => {
    const { port, requests } = harness();
    await port.deferInteraction(
      GUILD,
      { interactionId: MESSAGE, token: 'tok' },
      { ephemeral: true },
    );

    expect(last(requests).method).toBe('POST');
    expect(last(requests).path).toBe(`/api/v10/interactions/${MESSAGE}/tok/callback`);
    expect(last(requests).body).toMatchObject({ type: 5, data: { flags: 64 } });
  });

  it('omits the ephemeral flag when the reply is meant to be public', async () => {
    const { port, requests } = harness();
    await port.deferInteraction(
      GUILD,
      { interactionId: MESSAGE, token: 'tok' },
      { ephemeral: false },
    );
    expect(last(requests).body).toMatchObject({ type: 5 });
    expect((last(requests).body as { data?: { flags?: number } }).data?.flags ?? 0).toBe(0);
  });

  /**
   * The follow-up is a webhook call addressed by the *application* id and the
   * interaction token, so the port has to be told the application id — the
   * interaction itself does not carry it.
   */
  it('follows up on the application webhook route', async () => {
    const { port, requests } = harness();
    await port.deferInteraction(
      GUILD,
      { interactionId: MESSAGE, token: 'tok' },
      { ephemeral: true },
    );
    await port.respondToInteraction(
      GUILD,
      { interactionId: MESSAGE, token: 'tok' },
      { content: 'ok' },
    );

    expect(last(requests).path).toBe(`/api/v10/webhooks/${APPLICATION}/tok`);
    expect(last(requests).body).toMatchObject({ content: 'ok', flags: 64 });
  });

  /**
   * Discord does not infer it: a follow-up to an ephemeral defer is public
   * unless the flag is repeated. Getting this wrong announces a member's role
   * changes to the whole channel.
   */
  it('remembers that the defer was ephemeral', async () => {
    const { port, requests } = harness();
    await port.deferInteraction(
      GUILD,
      { interactionId: MESSAGE, token: 'tok' },
      { ephemeral: false },
    );
    await port.respondToInteraction(
      GUILD,
      { interactionId: MESSAGE, token: 'tok' },
      { content: 'ok' },
    );
    expect((last(requests).body as { flags?: number }).flags ?? 0).toBe(0);
  });

  /**
   * The interaction follow-up route behaves as though `?wait=true` were
   * always set, so Discord's response body is the created message — the ref
   * `respondToInteraction` needs to link an assistant answer into a
   * conversation (ADR 0072).
   */
  it('returns the ref from the posted follow-up message', async () => {
    const { port } = harness([{ status: 200, body: { id: MESSAGE, channel_id: CHANNEL } }]);
    await expect(
      port.respondToInteraction(GUILD, { interactionId: MESSAGE, token: 'tok' }, { content: 'ok' }),
    ).resolves.toEqual({ channelId: CHANNEL, messageId: MESSAGE });
  });

  it('returns undefined when Discord answers with no body', async () => {
    const { port } = harness([{ status: 204 }]);
    await expect(
      port.respondToInteraction(GUILD, { interactionId: MESSAGE, token: 'tok' }, { content: 'ok' }),
    ).resolves.toBeUndefined();
  });

  it('does not put the interaction token in the error it raises', async () => {
    const { port } = harness([
      {
        status: 404,
        body: { code: DiscordErrorCode.UnknownInteraction, message: 'Unknown interaction' },
      },
    ]);
    const err = await port
      .deferInteraction(
        GUILD,
        { interactionId: MESSAGE, token: 'super-secret-token' },
        { ephemeral: true },
      )
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(DiscordApiError);
    expect(JSON.stringify({ m: (err as Error).message })).not.toContain('super-secret-token');
  });
});

describe('audit log', () => {
  it('asks for the numeric action type Discord uses', async () => {
    const { port, requests } = harness([{ status: 200, body: { audit_log_entries: [] } }]);
    await port.fetchAuditLog(GUILD, { actionType: 'message_delete', limit: 10 });

    expect(last(requests).path).toBe(`/api/v10/guilds/${GUILD}/audit-logs`);
    expect(last(requests).query).toContain('action_type=72');
    expect(last(requests).query).toContain('limit=10');
  });

  it('maps entries back into the port shape', async () => {
    const { port } = harness([
      {
        status: 200,
        body: {
          audit_log_entries: [
            {
              id: '1',
              action_type: 72,
              user_id: USER,
              target_id: MESSAGE,
              reason: 'spam',
              options: { count: '3' },
            },
          ],
        },
      },
    ]);

    const entries = await port.fetchAuditLog(GUILD, { actionType: 'message_delete' });
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      actorUserId: USER,
      targetId: MESSAGE,
      actionType: 'message_delete',
      reason: 'spam',
    });
  });

  /**
   * A self-deletion produces no audit entry at all, so `user_id` absent must
   * degrade to "unknown" rather than being guessed. WP4 labels this inferred
   * everywhere it surfaces; the port's job is not to invent an actor.
   */
  it('leaves the actor undefined rather than guessing', async () => {
    const { port } = harness([
      {
        status: 200,
        body: { audit_log_entries: [{ id: '1', action_type: 72, target_id: MESSAGE }] },
      },
    ]);
    const entries = await port.fetchAuditLog(GUILD, { actionType: 'message_delete' });
    expect(entries[0]?.actorUserId).toBeUndefined();
    expect(entries[0]?.reason).toBeUndefined();
  });

  it('derives the entry timestamp from the snowflake, since Discord sends no other', async () => {
    // Discord epoch + 1s, shifted into snowflake position.
    const id = String((1_000n << 22n) + (1_420_070_400_000n - 1_420_070_400_000n));
    const { port } = harness([
      { status: 200, body: { audit_log_entries: [{ id, action_type: 72, target_id: MESSAGE }] } },
    ]);
    const entries = await port.fetchAuditLog(GUILD, { actionType: 'message_delete' });
    expect(entries[0]?.createdAtMs).toBe(1_420_070_400_000 + 1_000);
  });

  it.each([
    ['message_delete', 72],
    ['member_kick', 20],
    ['member_ban', 22],
    ['role_update', 25],
  ] as const)('asks Discord for %s as action type %i', async (actionType, expected) => {
    const { port, requests } = harness([{ status: 200, body: { audit_log_entries: [] } }]);
    await port.fetchAuditLog(GUILD, { actionType });
    expect(last(requests).query).toContain(`action_type=${expected}`);
  });
});

describe('archived thread pagination (S3)', () => {
  const THREAD_A = '666666666666666666';
  const THREAD_B = '777777777777777777';

  const publicThread = (id: string, archivedAt: string) => ({
    id,
    guild_id: GUILD,
    parent_id: CHANNEL,
    type: 11,
    name: `thread-${id}`,
    thread_metadata: {
      archived: true,
      archive_timestamp: archivedAt,
      auto_archive_duration: 60,
      locked: false,
    },
  });

  it('pages the archived endpoint by archive_timestamp, never by thread snowflake', async () => {
    const { port, requests } = harness([
      { status: 200, body: { threads: [], has_more: false } },
      {
        status: 200,
        body: { threads: [publicThread(THREAD_A, '2026-09-10T12:00:00.000Z')], has_more: true },
      },
      {
        status: 200,
        body: { threads: [publicThread(THREAD_B, '2026-09-01T12:00:00.000Z')], has_more: false },
      },
    ]);

    const threads = await port.listPublicThreads(GUILD, CHANNEL);
    expect(threads.map((thread) => thread.id).sort()).toEqual([THREAD_A, THREAD_B].sort());

    // Request 0 is guildActiveThreads; requests 1 and 2 are the archived
    // pages. The second page's `before` is the first page's last
    // archive_timestamp (discord.js ThreadManager.js:138-155), an ISO8601
    // string the API accepts for this endpoint — not the thread's id.
    const pageTwo = requests[2];
    expect(pageTwo).toBeDefined();
    const before = new URLSearchParams(pageTwo?.query ?? '').get('before');
    expect(before).toBe('2026-09-10T12:00:00.000Z');
    expect(before).not.toBe(THREAD_A);
  });

  it('refuses visibly rather than paging without bound', async () => {
    // globalRequestsPerSecond raised — the 51 rapid requests this test
    // makes would otherwise trip @discordjs/rest's own 50/s global limiter
    // (with REST_OPTIONS' rejectOnRateLimit, a visible refusal) before the
    // cap under test is reached. 0 would mean "always limited", not
    // "unlimited".
    const { port, requests } = harness(
      [
        { status: 200, body: { threads: [], has_more: false } },
        // Repeats forever: has_more is always true.
        {
          status: 200,
          body: { threads: [publicThread(THREAD_A, '2026-09-10T12:00:00.000Z')], has_more: true },
        },
      ],
      { globalRequestsPerSecond: 10_000 },
    );

    await expect(port.listPublicThreads(GUILD, CHANNEL)).rejects.toThrow(/page cap/);
    // 50 archived pages were fetched before the refusal.
    expect(requests.filter((request) => request.path.includes('/threads/archived')).length).toBe(
      50,
    );
  });
});

describe('thread membership (ADR 0112)', () => {
  const THREAD = '666666666666666666';

  it('answers true on 200, on the thread-member route', async () => {
    const { port, requests } = harness([
      { status: 200, body: { user_id: USER, thread_id: THREAD } },
    ]);
    await expect(port.isThreadMember(GUILD, THREAD, USER)).resolves.toBe(true);
    expect(last(requests).method).toBe('GET');
    expect(last(requests).path).toBe(`/api/v10/channels/${THREAD}/thread-members/${USER}`);
  });

  it('answers false on 404, never a throw', async () => {
    const { port } = harness([
      { status: 404, body: { code: DiscordErrorCode.UnknownMember, message: 'Unknown Member' } },
    ]);
    await expect(port.isThreadMember(GUILD, THREAD, USER)).resolves.toBe(false);
  });

  it('still raises anything else (e.g. 403 or a server error)', async () => {
    const forbidden = harness([
      { status: 403, body: { code: DiscordErrorCode.MissingAccess, message: 'Missing Access' } },
    ]);
    await expect(forbidden.port.isThreadMember(GUILD, THREAD, USER)).rejects.toBeInstanceOf(
      DiscordApiError,
    );
    const broken = harness([{ status: 500, body: { message: 'internal error' } }]);
    await expect(broken.port.isThreadMember(GUILD, THREAD, USER)).rejects.toBeInstanceOf(
      DiscordApiError,
    );
  });
});

describe('thread info (ADR 0112 sweeper fallback)', () => {
  const THREAD = '666666666666666666';
  const PARENT = '777777777777777777';

  const channel = (over: Record<string, unknown>) => ({
    id: THREAD,
    guild_id: GUILD,
    type: 11,
    name: 'weekly build night',
    parent_id: PARENT,
    ...over,
  });

  it('reads public thread facts off the channel route', async () => {
    const { port, requests } = harness([{ status: 200, body: channel({}) }]);
    await expect(port.fetchThreadInfo(GUILD, THREAD)).resolves.toEqual({
      id: THREAD,
      name: 'weekly build night',
      parentId: PARENT,
      isPrivate: false,
    });
    expect(last(requests).method).toBe('GET');
    expect(last(requests).path).toBe(`/api/v10/channels/${THREAD}`);
  });

  it('marks a private thread private', async () => {
    const { port } = harness([{ status: 200, body: channel({ type: 12 }) }]);
    await expect(port.fetchThreadInfo(GUILD, THREAD)).resolves.toMatchObject({
      isPrivate: true,
    });
  });

  it('answers undefined rather than throwing on 404 or 403', async () => {
    const gone = harness([
      { status: 404, body: { code: DiscordErrorCode.UnknownMessage, message: 'Unknown Channel' } },
    ]);
    await expect(gone.port.fetchThreadInfo(GUILD, THREAD)).resolves.toBeUndefined();

    const forbidden = harness([
      { status: 403, body: { code: DiscordErrorCode.MissingAccess, message: 'Missing Access' } },
    ]);
    await expect(forbidden.port.fetchThreadInfo(GUILD, THREAD)).resolves.toBeUndefined();
  });

  it('answers undefined for another guild\u2019s channel, a non-thread, or a missing parent', async () => {
    const foreign = harness([{ status: 200, body: channel({ guild_id: OTHER_GUILD }) }]);
    await expect(foreign.port.fetchThreadInfo(GUILD, THREAD)).resolves.toBeUndefined();

    const text = harness([{ status: 200, body: channel({ type: 0, parent_id: null }) }]);
    await expect(text.port.fetchThreadInfo(GUILD, THREAD)).resolves.toBeUndefined();

    const parentless = harness([{ status: 200, body: channel({ parent_id: null }) }]);
    await expect(parentless.port.fetchThreadInfo(GUILD, THREAD)).resolves.toBeUndefined();
  });

  it('still raises anything else (e.g. a server error)', async () => {
    const { port } = harness([{ status: 500, body: { message: 'internal error' } }]);
    await expect(port.fetchThreadInfo(GUILD, THREAD)).rejects.toBeInstanceOf(DiscordApiError);
  });
});

describe('guild lifecycle', () => {
  it('leaves a guild on the @me route', async () => {
    const { port, requests } = harness();
    await port.leaveGuild(OTHER_GUILD);
    expect(last(requests).method).toBe('DELETE');
    expect(last(requests).path).toBe(`/api/v10/users/@me/guilds/${OTHER_GUILD}`);
  });
});

describe('scheduled events', () => {
  it('lists guild scheduled events with start, channel and location', async () => {
    const { port, requests } = harness([
      {
        status: 200,
        body: [
          {
            id: '777777777777777771',
            guild_id: GUILD,
            channel_id: CHANNEL,
            name: 'Build night',
            description: 'Bring tools.',
            scheduled_start_time: '2026-09-25T19:00:00.000Z',
            scheduled_end_time: null,
            entity_type: 2,
            entity_id: null,
            entity_metadata: null,
          },
          {
            id: '777777777777777772',
            guild_id: GUILD,
            channel_id: null,
            name: 'Track day',
            description: null,
            scheduled_start_time: '2026-09-26T19:00:00.000Z',
            scheduled_end_time: null,
            entity_type: 3,
            entity_id: null,
            entity_metadata: { location: 'Mission Raceway' },
          },
        ],
      },
    ]);
    const events = await port.listScheduledEvents(GUILD);
    expect(events).toEqual([
      {
        id: '777777777777777771',
        name: 'Build night',
        description: 'Bring tools.',
        scheduledStartAt: Date.parse('2026-09-25T19:00:00.000Z'),
        channelId: CHANNEL,
      },
      {
        id: '777777777777777772',
        name: 'Track day',
        scheduledStartAt: Date.parse('2026-09-26T19:00:00.000Z'),
        location: 'Mission Raceway',
      },
    ]);
    expect(last(requests).method).toBe('GET');
    expect(last(requests).path).toBe(`/api/v10/guilds/${GUILD}/scheduled-events`);
  });

  it('answers [] rather than throwing on 403', async () => {
    const { port } = harness([
      { status: 403, body: { code: DiscordErrorCode.MissingAccess, message: 'Missing Access' } },
    ]);
    await expect(port.listScheduledEvents(GUILD)).resolves.toEqual([]);
  });
});

describe('errors are mapped onto the vocabulary core already has', () => {
  it('maps 404 Unknown Message onto isGone', async () => {
    const { port } = harness([
      { status: 404, body: { code: DiscordErrorCode.UnknownMessage, message: 'Unknown Message' } },
    ]);
    const err = (await port
      .fetchMessage(GUILD, { channelId: CHANNEL, messageId: MESSAGE })
      .catch((e: unknown) => e)) as DiscordApiError;

    expect(err).toBeInstanceOf(DiscordApiError);
    expect(err.code).toBe(DiscordErrorCode.UnknownMessage);
    expect(err.status).toBe(404);
    expect(err.isGone).toBe(true);
  });

  it('maps 403 Missing Permissions onto isPermissionDenied', async () => {
    const { port } = harness([
      {
        status: 403,
        body: { code: DiscordErrorCode.MissingPermissions, message: 'Missing Permissions' },
      },
    ]);
    const err = (await port
      .addRole(GUILD, USER, ROLE, 'r')
      .catch((e: unknown) => e)) as DiscordApiError;
    expect(err.isPermissionDenied).toBe(true);
  });

  it('maps 10062 onto isExpiredInteraction', async () => {
    const { port } = harness([
      {
        status: 404,
        body: { code: DiscordErrorCode.UnknownInteraction, message: 'Unknown interaction' },
      },
    ]);
    const err = (await port
      .respondToInteraction(GUILD, { interactionId: MESSAGE, token: 'tok' }, { content: 'x' })
      .catch((e: unknown) => e)) as DiscordApiError;
    expect(err.isExpiredInteraction).toBe(true);
  });

  it('maps an unrecognised failure without inventing a code', async () => {
    const { port } = harness([
      { status: 500, body: { code: 0, message: 'Internal Server Error' } },
    ]);
    const err = (await port.fetchRoles(GUILD).catch((e: unknown) => e)) as DiscordApiError;
    expect(err).toBeInstanceOf(DiscordApiError);
    expect(err.status).toBe(500);
  });
});

describe('ADR 0018 — refuse, do not retry or wait', () => {
  /**
   * The default is `retries: 3`, which would charge a rate cap that authorised
   * one call for three, and would hide a failing guild behind latency instead of
   * tripping the breaker above.
   */
  it('does not retry a 500 underneath the effect gateway', async () => {
    const { port, requests } = harness([{ status: 500, body: { code: 0, message: 'boom' } }]);
    await port.fetchRoles(GUILD).catch(() => undefined);
    expect(requests).toHaveLength(1);
  });

  it('reports a rate limit as a 429 the gateway can see, rather than sleeping', async () => {
    const { port } = harness([
      {
        status: 429,
        body: { message: 'You are being rate limited.', retry_after: 1.5, global: false },
        headers: {
          'x-ratelimit-limit': '5',
          'x-ratelimit-remaining': '0',
          'x-ratelimit-reset-after': '1.5',
          'x-ratelimit-bucket': 'abc',
          'retry-after': '1.5',
        },
      },
    ]);

    const started = Date.now();
    const err = (await port
      .addRole(GUILD, USER, ROLE, 'r')
      .catch((e: unknown) => e)) as DiscordApiError;

    expect(err).toBeInstanceOf(DiscordApiError);
    expect(err.isRateLimit).toBe(true);
    expect(err.status).toBe(429);
    expect(err.options.retryAfter).toBeGreaterThan(0);
    // The whole point: it refused promptly instead of waiting the bucket out.
    expect(Date.now() - started).toBeLessThan(1_000);
  });
});
