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

function harness(replies: Reply[] = [{ status: 204 }]) {
  const requests: Recorded[] = [];
  let next = 0;

  const rest = new REST({
    ...REST_OPTIONS,
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

  it('edits a message in place', async () => {
    const { port, requests } = harness([{ status: 200, body: { id: MESSAGE } }]);
    await port.editMessage(GUILD, { channelId: CHANNEL, messageId: MESSAGE }, { content: 'new' });
    expect(last(requests).method).toBe('PATCH');
    expect(last(requests).path).toBe(`/api/v10/channels/${CHANNEL}/messages/${MESSAGE}`);
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

describe('guild lifecycle', () => {
  it('leaves a guild on the @me route', async () => {
    const { port, requests } = harness();
    await port.leaveGuild(OTHER_GUILD);
    expect(last(requests).method).toBe('DELETE');
    expect(last(requests).path).toBe(`/api/v10/users/@me/guilds/${OTHER_GUILD}`);
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
