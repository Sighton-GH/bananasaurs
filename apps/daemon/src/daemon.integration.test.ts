import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { pino } from 'pino';
import { ChannelType, Client, Events, type Guild } from 'discord.js';
import {
  panelDefinitionSchema,
  parseConfig,
  parseGuildId,
  unicodeEmojiKey,
  type Config,
} from '@bananasaurs/core';
import { buildClientOptions } from '@bananasaurs/discord';
import { guildRepo, jobRepo, panelRepo, pipelineRepo, roleRepo } from '@bananasaurs/storage';
import { openMigratedTestDatabase } from '@bananasaurs/storage/test-support';
import { BOT_USER_ID, FakeDiscord } from '@bananasaurs/testkit';
import { createDaemon, type Daemon } from './runtime/daemon.js';

/**
 * The composition root, assembled and driven by **raw gateway packets**.
 *
 * `createDaemon` takes an opened database, a `DiscordPort` and a `Client` that
 * has never logged in, which is what makes this possible: the test hands it
 * `FakeDiscord`, an in-memory migrated database and a real discord.js client,
 * then pushes packets through `client.actions.*` exactly as the websocket layer
 * does. Everything between the wire and the audit row runs — discord.js's
 * partial handling, translation, the allowlist gate, the dedupe table, the
 * subscribers, the effect gateway. Only the socket is missing.
 *
 * `docs/21` exercise 1 step 2 is the reason. "It must log the guild id and
 * leave, within seconds, without touching anything" is called the single most
 * important behaviour in that document, and it should not first be attempted
 * against a live guild.
 */

const GUILD = parseGuildId('234567890123456789');
const SECOND_GUILD = parseGuildId('245678901234567890');
const UNLISTED = '999888777666555444';
const CHANNEL = '333333333333333333';
const MESSAGE = '444444444444444444';
const ROLE = '222222222222222222';
const ALICE = '111111111111111111';
const OWNER = '345678901234567890';

const BRAIN = unicodeEmojiKey('🧠');

const logger = pino({ level: process.env['DAEMON_TEST_LOG'] ?? 'silent' });

const config = (over: Record<string, string> = {}): Config =>
  parseConfig({
    DISCORD_BOT_TOKEN: 'not.a.real.token',
    DISCORD_APPLICATION_ID: BOT_USER_ID,
    BANANASAURS_GUILD_ALLOWLIST: GUILD,
    BANANASAURS_OWNER_USER_ID: OWNER,
    DASHBOARD_SESSION_SECRET: 'a'.repeat(32),
    BANANASAURS_DRY_RUN: '0',
    ...over,
  });

/**
 * discord.js's own gateway entry points, private to the library — which is the
 * point. `client.actions.X.handle(packet)` and `manager._add(payload)` are what
 * the websocket layer calls, so standing in for the socket here is the only way
 * to assemble the daemon against real structures.
 */
interface Internals {
  actions: Record<string, { handle: (data: object, shard?: unknown) => unknown }>;
  guilds: { _add: (data: object) => Guild };
  users: { _add: (data: object) => never };
}
const internals = (client: Client): Internals => client as unknown as Internals;

let t: ReturnType<typeof openMigratedTestDatabase>;
let discord: FakeDiscord;
let client: Client;
let daemon: Daemon;

const guildPayload = (id: string, name: string): object => ({
  id,
  name,
  owner_id: OWNER,
  channels: [{ id: CHANNEL, type: ChannelType.GuildText, name: 'panels', guild_id: id }],
  roles: [
    { id, name: '@everyone', position: 0, managed: false },
    { id: ROLE, name: 'alpha', position: 1, managed: false },
  ],
  members: [],
  emojis: [],
  unavailable: false,
});

/** What READY establishes. discord.js reads `client.user.id` while translating. */
const establishIdentity = (c: Client): void => {
  const mutable = c as unknown as { user: unknown; application: unknown };
  mutable.user = internals(c).users._add({
    id: BOT_USER_ID,
    username: 'bananasaurs',
    discriminator: '0',
  });
  mutable.application = { id: BOT_USER_ID, emojis: { cache: new Map() } };
};

const reactionPacket = (over: Record<string, unknown> = {}): object => ({
  user_id: ALICE,
  channel_id: CHANNEL,
  message_id: MESSAGE,
  guild_id: GUILD,
  emoji: { id: null, name: '🧠' },
  type: 0,
  burst: false,
  ...over,
});

const start = (over: Record<string, string> = {}): Daemon => {
  const built = createDaemon({
    config: config(over),
    scopes: t.scopes,
    discord,
    client,
    logger,
    now: () => discord.now(),
  });
  built.start();
  return built;
};

/** An adopted panel offering one role for 🧠, in the guild `scope` names. */
const seedPanel = (guildId: ReturnType<typeof parseGuildId>): void => {
  const scope = t.scopes.forGuild(guildId);
  // Guild scope is a composite foreign key, so the guild row comes first. The
  // daemon creates one for every allowlisted guild at startup; a panel seeded
  // before it starts has to do the same.
  guildRepo.upsertGuild(scope, { name: 'test guild', now: 0 });
  roleRepo.allowlistRole(scope, ROLE);
  panelRepo.createPanel(
    scope,
    panelDefinitionSchema.parse({
      panelId: 'roles',
      kind: 'adopted',
      channelId: CHANNEL,
      messageId: MESSAGE,
      behaviour: 'toggle',
      component: 'reaction',
      options: [{ optionId: 'a', roleId: ROLE, emojiKey: BRAIN, position: 0 }],
    }),
    discord.now(),
  );
};

beforeEach(() => {
  t = openMigratedTestDatabase();

  discord = new FakeDiscord({ guildId: GUILD, botHighestRolePosition: 100 });
  discord.defineRole({ id: ROLE, name: 'alpha', position: 1 });
  discord.defineMember(BOT_USER_ID, []);
  discord.defineMember(ALICE, []);
  discord.defineMessage({ channelId: CHANNEL, messageId: MESSAGE });

  client = new Client(buildClientOptions(() => BOT_USER_ID));
  establishIdentity(client);
  // What GUILD_CREATE would have delivered. Without it discord.js cannot resolve
  // the channel a reaction arrived on, and the dispatch produces no event at
  // all — which is the same silence a missing partial produces, and just as
  // confusing.
  internals(client).guilds._add(guildPayload(GUILD, 'test guild'));
});

afterEach(async () => {
  await daemon?.stop();
  t.close();
});

describe('the guild allowlist — docs/21 exercise 1', () => {
  it('leaves a guild it is invited to but not configured for', async () => {
    daemon = start();
    const uninvited = internals(client).guilds._add(guildPayload(UNLISTED, 'uninvited'));

    client.emit(Events.GuildCreate, uninvited);
    await daemon.settle();

    expect(discord.restCalls('leaveGuild').map((c) => c.args[0])).toEqual([UNLISTED]);
  });

  it('stays in a guild it is configured for', async () => {
    daemon = start();
    const listed = internals(client).guilds._add(guildPayload(GUILD, 'test guild'));

    client.emit(Events.GuildCreate, listed);
    await daemon.settle();

    expect(discord.restCalls('leaveGuild')).toEqual([]);
    expect(guildRepo.findGuild(t.scopes.forGuild(GUILD))?.name).toBe('test guild');
  });

  /**
   * A guild that will not let the bot leave — or a burst of events arriving
   * before the leave lands — must not turn into one REST call per event. The
   * pipeline's departed set is process-local, so a restart tries again.
   */
  it('asks to leave once, however many events arrive', async () => {
    daemon = start();
    const uninvited = internals(client).guilds._add(guildPayload(UNLISTED, 'uninvited'));

    client.emit(Events.GuildCreate, uninvited);
    client.emit(Events.GuildCreate, uninvited);
    internals(client).actions['MessageReactionAdd']?.handle(
      reactionPacket({ guild_id: UNLISTED, message_id: '454545454545454545' }),
    );
    await daemon.settle();

    expect(discord.restCalls('leaveGuild')).toHaveLength(1);
  });
});

describe('guild scope across the composition root', () => {
  /**
   * The subscribers are bound to a `GuildScope` and none of them compares
   * `event.guildId` against it — correctly, because re-checking the partition
   * key in every handler is the caller discipline CLAUDE.md rule 2 exists to
   * avoid. ADR 0020's guard is what makes that safe once the allowlist holds
   * more than one guild.
   *
   * Here the panel lives in the first guild and the reaction arrives from the
   * second, on the same channel and message ids. Without the guard the first
   * guild's subscriber finds its panel and grants the role.
   */
  it('never delivers one guild event to another guild subscribers', async () => {
    seedPanel(GUILD);
    guildRepo.upsertGuild(t.scopes.forGuild(SECOND_GUILD), { name: 'second', now: 0 });
    daemon = start({ BANANASAURS_GUILD_ALLOWLIST: `${GUILD},${SECOND_GUILD}` });

    internals(client).guilds._add(guildPayload(SECOND_GUILD, 'second'));
    internals(client).actions['MessageReactionAdd']?.handle(
      reactionPacket({ guild_id: SECOND_GUILD }),
    );
    await daemon.settle();

    expect(discord.memberRoles(ALICE)).toEqual([]);
  });
});

describe('a reaction, end to end', () => {
  it('grants the role a seeded panel offers', async () => {
    seedPanel(GUILD);
    daemon = start();

    internals(client).actions['MessageReactionAdd']?.handle(reactionPacket());
    await daemon.settle();

    expect(discord.memberRoles(ALICE)).toEqual([ROLE]);
  });

  /**
   * Gateway events replay on reconnect, so the same reaction arriving twice is
   * the ordinary case rather than an anomaly. One effect, not two.
   */
  it('acts once when the same dispatch arrives twice', async () => {
    seedPanel(GUILD);
    daemon = start();

    internals(client).actions['MessageReactionAdd']?.handle(reactionPacket());
    internals(client).actions['MessageReactionAdd']?.handle(reactionPacket());
    await daemon.settle();

    expect(discord.restCalls('addRole')).toHaveLength(1);
  });

  /** Dry run is layer 4, and `docs/21` exercise 2 turns it on before anything else. */
  it('makes no Discord call at all when dry run is on', async () => {
    seedPanel(GUILD);
    daemon = start({ BANANASAURS_DRY_RUN: '1' });

    internals(client).actions['MessageReactionAdd']?.handle(reactionPacket());
    await daemon.settle();

    expect(discord.restCalls('addRole')).toEqual([]);
    expect(discord.memberRoles(ALICE)).toEqual([]);
  });
});

describe('dry run comes from the environment', () => {
  /**
   * `guilds.dry_run` defaults to 1 and the effect gateway reads it from there,
   * but `docs/21` exercise 3 tells the operator to change the behaviour by
   * setting `BANANASAURS_DRY_RUN=0` and restarting. Without this sync that
   * instruction does nothing at all, and a correctly-working bot looks broken.
   */
  it('writes the configured value into the guild row on start', () => {
    guildRepo.upsertGuild(t.scopes.forGuild(GUILD), { name: 'test guild', now: 0 });
    expect(guildRepo.readSafetyState(t.scopes.forGuild(GUILD))?.dryRun).toBe(true);

    daemon = start({ BANANASAURS_DRY_RUN: '0' });

    expect(guildRepo.readSafetyState(t.scopes.forGuild(GUILD))?.dryRun).toBe(false);
  });

  it('turns dry run back on when the environment says so', async () => {
    daemon = start({ BANANASAURS_DRY_RUN: '0' });
    await daemon.stop();
    daemon = start({ BANANASAURS_DRY_RUN: '1' });

    expect(guildRepo.readSafetyState(t.scopes.forGuild(GUILD))?.dryRun).toBe(true);
  });
});

describe('reconnecting', () => {
  /**
   * `docs/21` exercise 4: Ctrl-C, react while it is down, restart. A cold start
   * is a fresh IDENTIFY by definition, so it records a gap and enqueues the
   * reconciliation that recovers whatever happened in the window.
   */
  it('records a gap and enqueues reconciliation on a fresh connection', async () => {
    seedPanel(GUILD);
    daemon = start();

    client.emit(Events.ClientReady, client as Client<true>);
    await daemon.settle();

    const scope = t.scopes.forGuild(GUILD);
    expect(pipelineRepo.unreconciledGaps(scope)).toHaveLength(1);
    expect(jobRepo.countByState(scope)['queued']).toBe(1);
  });

  it('records a resumed session as a gap that needs no repair', async () => {
    seedPanel(GUILD);
    daemon = start();

    client.emit(Events.ShardResume, 0, 3);
    await daemon.settle();

    const scope = t.scopes.forGuild(GUILD);
    expect(pipelineRepo.unreconciledGaps(scope)).toHaveLength(1);
    expect(jobRepo.countByState(scope)['queued']).toBeUndefined();
  });
});

describe('the bot user id', () => {
  /**
   * `botUserId` is what makes the reaction subscriber ignore the bot's own
   * seeded reactions. Discord mints a bot user with its application's snowflake,
   * so the configured application id is it — but they are separate fields, and a
   * mismatch would turn every seeded panel reaction into a member request. The
   * assumption is checked against the connection rather than trusted.
   */
  it('refuses to keep running when it is not who the configuration says', () => {
    const fatal: string[] = [];
    const built = createDaemon({
      config: config(),
      scopes: t.scopes,
      discord,
      client,
      logger,
      now: () => discord.now(),
      onFatal: (reason) => fatal.push(reason),
    });
    built.start();

    (client as unknown as { user: unknown }).user = internals(client).users._add({
      id: '191919191919191919',
      username: 'someone-else',
      discriminator: '0',
    });
    client.emit(Events.ClientReady, client as Client<true>);

    expect(fatal).toEqual(['bot-user-id-mismatch']);
    daemon = built;
  });
});

describe('the job worker', () => {
  it('runs a queued job without anything else asking it to', async () => {
    seedPanel(GUILD);
    discord.offlineReactionAdd({
      channelId: CHANNEL,
      messageId: MESSAGE,
      userId: ALICE,
      emoji: BRAIN,
    });
    daemon = start();

    client.emit(Events.ClientReady, client as Client<true>);
    await daemon.settle();
    await daemon.drainJobs();

    // The reaction was added while nothing was listening; the gap's
    // reconciliation pass is what finds it.
    expect(discord.memberRoles(ALICE)).toEqual([ROLE]);
  });
});
