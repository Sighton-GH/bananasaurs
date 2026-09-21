import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ChannelType, Client } from 'discord.js';
import { pino } from 'pino';
import { JOB_KINDS, parseConfig, parseGuildId, type Snowflake } from '@bananasaurs/core';
import { buildClientOptions } from '@bananasaurs/discord';
import { archiveRepo, guildRepo, jobRepo, type GuildScope } from '@bananasaurs/storage';
import { openMigratedTestDatabase } from '@bananasaurs/storage/test-support';
import { FakeDiscord } from '@bananasaurs/testkit';
import { buildGuildRuntime } from './guild.js';

/**
 * Forum backfill through the live wiring (review B3).
 *
 * The old wiring hardwired `isForum: () => false`, so an enabled forum's
 * backfill paged the forum id as if it were a text channel — Discord returns
 * no messages there, and every post was silently skipped. The fix resolves
 * the type from the real client cache. These tests build the real
 * `buildGuildRuntime` against a real (never logged in) discord.js `Client`
 * whose guild carries a forum and a text channel; only the gateway is
 * faked, and the database runs real migrations.
 */

const GUILD = parseGuildId('711111111111111111');
const FORUM = '722222222222222222';
const TEXT = '733333333333333333';
const THREAD = '744444444444444444';
const BOT = '123456789012345678';
const OWNER = '345678901234567890';
const NOW = 1_700_000_000_000;

const logger = pino({ level: 'silent' });

interface Internals {
  guilds: { _add: (data: object) => unknown };
}

class ForumFakeDiscord extends FakeDiscord {
  override async listPublicThreads(
    _guildId: Snowflake,
    channelId: Snowflake,
  ): Promise<readonly { id: Snowflake; name: string; isPrivate: boolean; archived: boolean }[]> {
    return channelId === FORUM
      ? [{ id: THREAD, name: 'forum post', isPrivate: false, archived: false }]
      : [];
  }
}

let t: ReturnType<typeof openMigratedTestDatabase>;
let scope: GuildScope;
let client: Client;
let discord: ForumFakeDiscord;

beforeEach(() => {
  t = openMigratedTestDatabase();
  scope = t.scopes.forGuild(GUILD);
  guildRepo.upsertGuild(scope, { name: 'test guild', now: 0 });

  client = new Client(buildClientOptions(() => BOT));
  (client as unknown as Internals).guilds._add({
    id: GUILD,
    name: 'test guild',
    owner_id: OWNER,
    member_count: 30,
    channels: [
      {
        id: FORUM,
        guild_id: GUILD,
        type: ChannelType.GuildForum,
        name: 'forum',
        position: 0,
        permission_overwrites: [],
      },
      {
        id: TEXT,
        guild_id: GUILD,
        type: ChannelType.GuildText,
        name: 'text',
        position: 1,
        permission_overwrites: [],
      },
    ],
    roles: [{ id: GUILD, name: '@everyone', position: 0, permissions: '0', managed: false }],
    members: [],
    emojis: [],
    unavailable: false,
  });

  discord = new ForumFakeDiscord({ guildId: GUILD, botHighestRolePosition: 100 });
});

afterEach(() => {
  t.close();
});

const runBackfill = async (channelId: string): Promise<void> => {
  const runtime = buildGuildRuntime({
    scope,
    config: parseConfig({
      DISCORD_BOT_TOKEN: 'NOT.A.REALTOKEN',
      DISCORD_APPLICATION_ID: BOT,
      BANANASAURS_GUILD_ALLOWLIST: GUILD,
      BANANASAURS_OWNER_USER_ID: OWNER,
      DASHBOARD_SESSION_SECRET: 'b'.repeat(32),
      BANANASAURS_ARCHIVE_GUILDS: GUILD,
    }),
    discord,
    client,
    logger,
    now: () => NOW,
  });
  jobRepo.enqueue(scope, {
    kind: JOB_KINDS.archiveBackfill,
    payload: JSON.stringify({ channelId }),
    dedupeKey: `test:${channelId}`,
    now: NOW,
  });
  for (let i = 0; i < 8; i += 1) {
    const tick = await runtime.worker.runOnce();
    if (tick.status === 'idle') break;
    expect(tick.status).toBe('completed');
  }
};

describe('forum backfill wiring (B3)', () => {
  it('an enabled forum backfills its posts and never pages the forum id itself', async () => {
    archiveRepo.enableChannel(scope, { channelId: FORUM, attachmentPolicy: 'none', now: NOW });
    for (let i = 1; i <= 5; i += 1) {
      discord.defineMessage({
        channelId: THREAD,
        messageId: String(7_000_000_000_000_000_000n + BigInt(i)),
        content: `post message ${String(i)}`,
      });
    }

    await runBackfill(FORUM);

    const paged = discord
      .restCalls('fetchRecentMessages')
      .map((call) => (call.args as readonly [Snowflake, Snowflake, unknown])[1]);
    expect(paged).not.toContain(FORUM);
    expect(paged).toContain(THREAD);
    // Thread posts are archived under the forum's own channel id with
    // `thread_id` set (ADR 0047): five posts, none under the thread id.
    expect(archiveRepo.countMessages(scope, FORUM)).toBe(5);
    expect(archiveRepo.countMessages(scope, THREAD)).toBe(0);
    expect(archiveRepo.findChannel(scope, FORUM)?.backfillState).toBe('done');
  });

  it('an enabled text channel still pages its own id', async () => {
    archiveRepo.enableChannel(scope, { channelId: TEXT, attachmentPolicy: 'none', now: NOW });
    for (let i = 1; i <= 3; i += 1) {
      discord.defineMessage({
        channelId: TEXT,
        messageId: String(7_100_000_000_000_000_000n + BigInt(i)),
        content: `text message ${String(i)}`,
      });
    }

    await runBackfill(TEXT);

    const paged = discord
      .restCalls('fetchRecentMessages')
      .map((call) => (call.args as readonly [Snowflake, Snowflake, unknown])[1]);
    expect(paged).toContain(TEXT);
    expect(archiveRepo.countMessages(scope, TEXT)).toBe(3);
    expect(archiveRepo.findChannel(scope, TEXT)?.backfillState).toBe('done');
  });
});
