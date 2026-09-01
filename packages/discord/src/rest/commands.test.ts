import { describe, expect, it } from 'vitest';
import { REST } from 'discord.js';
import { DiscordApiError } from '@bananasaurs/core';
import { REST_OPTIONS } from '../client.js';
import {
  MOD_COMMAND,
  RELEASE_1_COMMANDS,
  RELEASE_2_COMMANDS,
  STATUS_COMMAND,
  registerGuildCommands,
} from './commands.js';

/**
 * Slash-command registration (ADR 0032), tested against the real
 * `@discordjs/rest` stack with only the socket replaced — the same shape as
 * `port.test.ts`, and for the same reason. Route building and error
 * construction are the library's own, so what is asserted here is *our*
 * decisions: which route, which body, one call per allowlisted guild, and what a
 * refusal does to the guilds after it.
 *
 * The registration call is deliberately not a `DiscordPort` method (ADR 0032),
 * so `FakeDiscord` has nothing to add for it. The port-level fake exists so
 * domain code can run with no network; this is composition-root code that holds
 * a `REST` instance directly, and the injection point that matters is
 * `makeRequest`.
 */

const GUILD = '234567890123456789';
const OTHER_GUILD = '345678901234567890';
const APPLICATION = '555555555555555555';

interface Recorded {
  method: string;
  path: string;
  body: unknown;
}

function harness(replies: { status: number; body?: unknown }[] = [{ status: 200, body: [] }]) {
  const requests: Recorded[] = [];
  let next = 0;

  const rest = new REST({
    ...REST_OPTIONS,
    makeRequest: async (url, init) => {
      requests.push({
        method: init.method ?? 'GET',
        path: new URL(url).pathname,
        body: typeof init.body === 'string' ? JSON.parse(init.body) : undefined,
      });
      const reply = replies[Math.min(next, replies.length - 1)] ?? { status: 200, body: [] };
      next += 1;
      return new Response(JSON.stringify(reply.body ?? []), {
        status: reply.status,
        headers: { 'content-type': 'application/json' },
      });
    },
  });
  rest.setToken('not-a-real-token');

  return { rest, requests };
}

describe('the Release 1 command set', () => {
  it('is exactly /status, open to every member', () => {
    expect(RELEASE_1_COMMANDS).toEqual([STATUS_COMMAND]);
    expect(STATUS_COMMAND.name).toBe('status');
    /**
     * ADR 0033: `/status` carries no Discord-side permission gate. A value here
     * would be a *second* authorisation decision layered under the one the ADR
     * recorded, and one a guild admin could silently change in Server Settings.
     */
    expect(STATUS_COMMAND.default_member_permissions).toBeUndefined();
  });
});

describe('the Release 2 command set', () => {
  it('is Release 1 plus /mod', () => {
    expect(RELEASE_2_COMMANDS).toEqual([STATUS_COMMAND, MOD_COMMAND]);
  });

  it('/mod carries the five Task 6 subcommands, ban and purge (Task 7), and note/evidence (Task 8)', () => {
    expect(MOD_COMMAND.name).toBe('mod');
    const names = MOD_COMMAND.options?.map((o) => o.name);
    expect(names).toEqual([
      'timeout',
      'untimeout',
      'kick',
      'unban',
      'warn',
      'ban',
      'purge',
      'note',
      'evidence',
    ]);
    // Only the six action subcommands take a `reason` — `note`/`evidence`
    // (Task 8) carry their own content option (`text`/`url`) instead; a
    // note's text or an evidence link is not "why", it is the payload.
    const WITH_REASON = new Set(['timeout', 'untimeout', 'kick', 'unban', 'warn', 'ban', 'purge']);
    for (const sub of MOD_COMMAND.options ?? []) {
      expect(sub.type).toBe(1); // SUB_COMMAND
      const optionNames = sub.options?.map((o) => o.name) ?? [];
      if (WITH_REASON.has(sub.name)) {
        expect(optionNames).toContain('reason');
      }
      // Every subcommand targets a member by id, except `purge`, which
      // targets a channel instead — there is no member to name.
      if (sub.name === 'purge') {
        expect(optionNames).toContain('channel');
        expect(optionNames).not.toContain('target');
      } else {
        expect(optionNames).toContain('target');
      }
    }
  });

  it('note takes target+text, capped well under Discord’s STRING ceiling', () => {
    const note = MOD_COMMAND.options?.find((o) => o.name === 'note');
    expect(note?.options?.map((o) => o.name)).toEqual(['target', 'text']);
    const text = note?.options?.find((o) => o.name === 'text');
    expect(text).toMatchObject({ type: 3, required: true, max_length: 1000 }); // STRING
  });

  it('evidence takes target+url, capped shorter than note’s free text', () => {
    const evidence = MOD_COMMAND.options?.find((o) => o.name === 'evidence');
    expect(evidence?.options?.map((o) => o.name)).toEqual(['target', 'url']);
    const url = evidence?.options?.find((o) => o.name === 'url');
    expect(url).toMatchObject({ type: 3, required: true, max_length: 500 }); // STRING
  });

  it('ban is a plain target+reason confirm-then-execute subcommand', () => {
    const ban = MOD_COMMAND.options?.find((o) => o.name === 'ban');
    expect(ban?.options?.map((o) => o.name)).toEqual(['target', 'reason']);
  });

  it('purge targets a channel, not a member', () => {
    const purge = MOD_COMMAND.options?.find((o) => o.name === 'purge');
    const channel = purge?.options?.find((o) => o.name === 'channel');
    expect(channel).toMatchObject({ type: 7, required: true }); // CHANNEL
  });

  it('timeout carries a bounded duration option', () => {
    const timeout = MOD_COMMAND.options?.find((o) => o.name === 'timeout');
    const duration = timeout?.options?.find((o) => o.name === 'duration_minutes');
    expect(duration).toMatchObject({ type: 4, required: true, min_value: 1, max_value: 40_320 });
  });

  it('sets a moderator-appropriate advisory permission bitfield, as a decimal string', () => {
    expect(MOD_COMMAND.default_member_permissions).toMatch(/^[0-9]+$/);
    // BanMembers (1<<2) | KickMembers (1<<1) | ModerateMembers (1<<40).
    expect(MOD_COMMAND.default_member_permissions).toBe(
      ((1n << 2n) | (1n << 1n) | (1n << 40n)).toString(),
    );
  });
});

describe('registerGuildCommands', () => {
  /**
   * Guild-scoped, never global. `CLAUDE.md` rule 2 in the one place where the
   * partition key is a URL rather than a database constraint — and the practical
   * half: a guild command is live immediately, while a global one is cached by
   * Discord for up to an hour, so "registered" and "failed" would be
   * indistinguishable for that hour.
   */
  it('PUTs the command set to the guild-scoped route', async () => {
    const { rest, requests } = harness();
    await registerGuildCommands({ rest, applicationId: APPLICATION, guildIds: [GUILD] });

    expect(requests).toHaveLength(1);
    expect(requests[0]?.method).toBe('PUT');
    expect(requests[0]?.path).toBe(`/api/v10/applications/${APPLICATION}/guilds/${GUILD}/commands`);
    expect(requests[0]?.body).toEqual([
      { name: 'status', description: STATUS_COMMAND.description, type: 1 },
    ]);
  });

  /**
   * Looped over the allowlist rather than indexed, even though Release 1 has one
   * guild. A second guild must be configuration, not a code change.
   */
  it('registers once per allowlisted guild, and in no other guild', async () => {
    const { rest, requests } = harness();
    const results = await registerGuildCommands({
      rest,
      applicationId: APPLICATION,
      guildIds: [GUILD, OTHER_GUILD],
    });

    expect(requests.map((r) => r.path)).toEqual([
      `/api/v10/applications/${APPLICATION}/guilds/${GUILD}/commands`,
      `/api/v10/applications/${APPLICATION}/guilds/${OTHER_GUILD}/commands`,
    ]);
    expect(results).toEqual([
      { guildId: GUILD, ok: true, count: 1 },
      { guildId: OTHER_GUILD, ok: true, count: 1 },
    ]);
  });

  it('makes no call at all when the allowlist is empty', async () => {
    const { rest, requests } = harness();
    const results = await registerGuildCommands({ rest, applicationId: APPLICATION, guildIds: [] });

    expect(requests).toEqual([]);
    expect(results).toEqual([]);
  });

  /**
   * A guild that refuses must not stop the ones after it. One guild removing the
   * bot's `applications.commands` scope is a per-guild fact, and a process that
   * otherwise connects, moderates and logs should not lose `/status` everywhere
   * because of it (ADR 0032).
   */
  it('reports a refusal per guild and keeps going', async () => {
    const { rest, requests } = harness([
      { status: 403, body: { code: 50001, message: 'Missing Access' } },
      { status: 200, body: [] },
    ]);
    const results = await registerGuildCommands({
      rest,
      applicationId: APPLICATION,
      guildIds: [GUILD, OTHER_GUILD],
    });

    expect(requests).toHaveLength(2);
    expect(results[0]).toMatchObject({ guildId: GUILD, ok: false });
    expect(results[1]).toEqual({ guildId: OTHER_GUILD, ok: true, count: 1 });
  });

  /**
   * Mapped into this project's error vocabulary rather than discord.js's, like
   * every other call in this directory: the caller must never have to know which
   * library produced the failure.
   */
  it('maps a refusal into a DiscordApiError', async () => {
    const { rest } = harness([{ status: 403, body: { code: 50001, message: 'Missing Access' } }]);
    const [result] = await registerGuildCommands({
      rest,
      applicationId: APPLICATION,
      guildIds: [GUILD],
    });

    expect(result?.ok).toBe(false);
    const error = result?.ok === false ? result.error : undefined;
    expect(error).toBeInstanceOf(DiscordApiError);
    expect((error as DiscordApiError).code).toBe(50001);
  });

  /**
   * ADR 0032: the endpoint *replaces* the guild's command set rather than
   * merging into it, which is what makes the call idempotent without a
   * `trigger_ref` and a unique constraint. Registering twice must produce the
   * same declared set, not two of everything.
   */
  it('replaces rather than accumulates, so a second run is a no-op', async () => {
    const { rest, requests } = harness();
    await registerGuildCommands({ rest, applicationId: APPLICATION, guildIds: [GUILD] });
    await registerGuildCommands({ rest, applicationId: APPLICATION, guildIds: [GUILD] });

    expect(requests).toHaveLength(2);
    expect(requests[0]?.body).toEqual(requests[1]?.body);
    expect(requests.every((r) => r.method === 'PUT')).toBe(true);
  });

  /** Removing an entry from the set is how a command is deregistered. */
  it('sends exactly the command set it was given', async () => {
    const { rest, requests } = harness();
    const results = await registerGuildCommands({
      rest,
      applicationId: APPLICATION,
      guildIds: [GUILD],
      commands: [],
    });

    expect(requests[0]?.body).toEqual([]);
    expect(results).toEqual([{ guildId: GUILD, ok: true, count: 0 }]);
  });
});
