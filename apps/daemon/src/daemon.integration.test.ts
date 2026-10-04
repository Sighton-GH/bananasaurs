import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pino } from 'pino';
import { ChannelType, Client, Events, type Guild } from 'discord.js';
import {
  JOB_KINDS,
  panelDefinitionSchema,
  parseConfig,
  parseGuildId,
  unicodeEmojiKey,
  type Config,
} from '@bananasaurs/core';
import { buildClientOptions } from '@bananasaurs/discord';
import {
  assistantRepo,
  automodRuleRepo,
  guildRepo,
  jobRepo,
  listBackups,
  loggingRepo,
  panelRepo,
  pipelineRepo,
  roleRepo,
} from '@bananasaurs/storage';
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
const LOG_CHANNEL = '555555555555555555';
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
    { id, name: '@everyone', position: 0, permissions: '0', managed: false },
    { id: ROLE, name: 'alpha', position: 1, permissions: '0', managed: false },
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
    raw: t.raw,
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

/** A `message_delete`/`message_edit`/`role_create`/... route to `LOG_CHANNEL`. WP4. */
const seedLogRoute = (guildId: ReturnType<typeof parseGuildId>, eventKind: string): void => {
  const scope = t.scopes.forGuild(guildId);
  guildRepo.upsertGuild(scope, { name: 'test guild', now: 0 });
  loggingRepo.createRoute(scope, {
    name: `route-${eventKind}`,
    channelId: LOG_CHANNEL,
    includeContent: true,
    enabled: true,
    eventKinds: [eventKind],
    excludedChannelIds: [],
    nowMs: 0,
  });
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

  /**
   * `daemon.portsFor` is the seam a dashboard session's `GuildScope` crosses
   * to reach `OpsPorts` (`packages/http`'s `HttpDeps.portsFor`, slice 14). A
   * session's scope names the guild it was authenticated against — never a
   * request parameter — so this is the one place left that could still answer
   * with the wrong guild's data if the lookup inside it ever stopped keying
   * on `scope.guildId` and answered from whichever guild happened to be built
   * first instead.
   */
  it('portsFor answers the guild named by the scope it is given, not any other', async () => {
    guildRepo.upsertGuild(t.scopes.forGuild(GUILD), { name: 'first guild', now: 0 });
    guildRepo.upsertGuild(t.scopes.forGuild(SECOND_GUILD), { name: 'second guild', now: 0 });
    daemon = start({ BANANASAURS_GUILD_ALLOWLIST: `${GUILD},${SECOND_GUILD}` });

    expect(daemon.portsFor(t.scopes.forGuild(GUILD)).guildName()).toBe('first guild');
    expect(daemon.portsFor(t.scopes.forGuild(SECOND_GUILD)).guildName()).toBe('second guild');
  });

  /**
   * Should-fix, review round 2: `listGuildRoles` must report Discord's raw
   * position, because `/api/guild/roles` compares it against the bot's
   * rawPosition. discord.js's `Role#position` getter is the role's RANK in
   * the sorted cache — roles at raw 3 and 7 read back as 1 and 2 — so the
   * raw field is the only scale the comparison may use.
   */
  it('listGuildRoles reports raw Discord positions, not sorted-cache ranks', async () => {
    daemon = start();
    internals(client).guilds._add({
      ...guildPayload(SECOND_GUILD, 'sparse roles'),
      roles: [
        { id: SECOND_GUILD, name: '@everyone', position: 0, permissions: '0', managed: false },
        { id: '111111111111111111', name: 'low', position: 3, permissions: '0', managed: false },
        { id: '222222222222222222', name: 'high', position: 7, permissions: '0', managed: false },
      ],
    });
    void daemon.stop();
    daemon = start({ BANANASAURS_GUILD_ALLOWLIST: `${GUILD},${SECOND_GUILD}` });

    const roles = daemon.portsFor(t.scopes.forGuild(SECOND_GUILD)).listGuildRoles();
    expect(roles.map((r) => [r.name, r.position])).toEqual([
      ['high', 7],
      ['low', 3],
    ]);
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

/**
 * WP4: proves `createLoggingSubscriber` and `logMessageDeleteHandler` are
 * actually wired into `buildGuildRuntime`, not merely built and left unused.
 * The logic itself is `logging.integration.test.ts` and
 * `logging-deletion.integration.test.ts`'s job; this is the composition
 * root's.
 */
describe('the logging module, end to end', () => {
  it('posts a role-create log line through the real gateway path', async () => {
    seedLogRoute(GUILD, 'role_create');
    daemon = start();

    const freshRole = '666666666666666666';
    internals(client).actions['GuildRoleCreate']?.handle({
      guild_id: GUILD,
      role: { id: freshRole, name: 'beta', position: 2, permissions: '0', managed: false },
    });
    await daemon.settle();

    const calls = discord.restCalls('sendMessage');
    expect(calls).toHaveLength(1);
    expect(calls[0]?.args[1]).toBe(LOG_CHANNEL);
    expect((calls[0]?.args[2] as { content: string }).content).toContain('beta');
  });

  it('enqueues and runs the deletion-attribution job through the real job worker', async () => {
    seedLogRoute(GUILD, 'message_delete');
    daemon = start();

    internals(client).actions['MessageDelete']?.handle({
      id: MESSAGE,
      channel_id: CHANNEL,
      guild_id: GUILD,
    });
    await daemon.settle();
    discord.advance(5_000);
    await daemon.drainJobs();

    const calls = discord.restCalls('sendMessage');
    expect(calls).toHaveLength(1);
    expect(calls[0]?.args[1]).toBe(LOG_CHANNEL);
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

describe('automod default word list seeding', () => {
  const DEFAULT_AUTOMOD_RULE_ID = 'default-word-filter';

  it('seeds exactly one rule, in test mode, on first start', () => {
    daemon = start();

    const scope = t.scopes.forGuild(GUILD);
    expect(automodRuleRepo.ruleExists(scope, DEFAULT_AUTOMOD_RULE_ID)).toBe(true);
    expect(automodRuleRepo.listEnabledRules(scope)).toEqual([
      expect.objectContaining({ ruleId: DEFAULT_AUTOMOD_RULE_ID, mode: 'test' }),
    ]);
  });

  /**
   * The seeded rule really carries obscenity's anchors and exceptions all the
   * way into `word_terms`/`word_allowlist`, not just into the seeding
   * function's own unit test. Without both, the shipped default rule matched
   * `class`, `assignment` and `Massachusetts` as profanity on first start.
   */
  it('seeds anchored terms and obscenity’s own allowlist exceptions', () => {
    daemon = start();

    const scope = t.scopes.forGuild(GUILD);
    const rule = automodRuleRepo.listEnabledRules(scope)[0];
    // `|` is obscenity's word-boundary assertion (its `Pattern` grammar), and
    // `parseRawPattern` — what the live matcher runs on `word_terms.text` —
    // is the parser that reads it.
    expect(rule?.terms.map((term) => term.text)).toContain('|ass');
    expect(rule?.allowlist).toContain('assi');
    expect(rule?.allowlist).toContain('analy');
  });

  /**
   * The crash this reproduces: `setRuleMode({ enabled: false })` is a real,
   * already-shipped capability, and spec §8 explicitly expects an operator to
   * "review and tune categories" — which includes disabling the seeded
   * default — before anything enforces for real. The old guard
   * (`listEnabledKeywordFilterRules(scope).length > 0`) went back to seeing
   * zero enabled rules once the seeded one was disabled, so a restart
   * attempted the same `INSERT` a second time and `createRule` threw on
   * `mod_rules`' `(guild_id, rule_id)` primary key — taking the whole daemon
   * process down at startup, not just this one guild.
   */
  it('does not crash on a second start and leaves a disabled rule disabled', async () => {
    daemon = start();
    const scope = t.scopes.forGuild(GUILD);
    automodRuleRepo.setRuleMode(scope, {
      ruleId: DEFAULT_AUTOMOD_RULE_ID,
      enabled: false,
      now: discord.now(),
    });
    await daemon.stop();

    expect(() => {
      daemon = start();
    }).not.toThrow();

    expect(automodRuleRepo.listEnabledRules(scope)).toEqual([]);
    // Re-seeding must not have run at all, not merely "ran harmlessly" — a
    // second seeding pass would also re-attempt `addCategory`/`addTerm`,
    // which have the same duplicate-key exposure `createRule` did.
    expect(automodRuleRepo.ruleExists(scope, DEFAULT_AUTOMOD_RULE_ID)).toBe(true);
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
    // The startup enqueues no archive_expiry job here (no archive channel is
    // enabled, so the timer skips the guild) — what this proves is the one
    // reconciliation.
    const queuedKinds = jobRepo.listJobs(scope, {}).map((job) => job.kind);
    expect(queuedKinds.filter((kind) => kind === JOB_KINDS.reconcileGuild)).toHaveLength(1);
  });

  it('records a resumed session as a gap that needs no repair', async () => {
    seedPanel(GUILD);
    daemon = start();

    client.emit(Events.ShardResume, 0, 3);
    await daemon.settle();

    const scope = t.scopes.forGuild(GUILD);
    expect(pipelineRepo.unreconciledGaps(scope)).toHaveLength(1);
    // No reconciliation is enqueued for a resumed session — and no
    // archive_expiry job either (no archive channel is enabled, so the
    // timer skips the guild). This names the kind rather than counting the
    // queue.
    const queuedKinds = jobRepo.listJobs(scope, {}).map((job) => job.kind);
    expect(queuedKinds.filter((kind) => kind === JOB_KINDS.reconcileGuild)).toHaveLength(0);
  });
});

describe('startup diagnostics', () => {
  /**
   * `doctor` runs on every READY, because everything it looks for — a missing
   * partial, an ungranted intent, a bot below the roles it manages — presents
   * identically from the outside: nothing happens and nothing says why.
   *
   * It reads lazily-computed discord.js structures to do it, and those throw:
   * `GuildMember.permissions` builds a bitfield from every cached role, and a
   * role delivered without a `permissions` field makes that throw. A diagnostic
   * that can take the process down on startup is worse than no diagnostic.
   */
  it('does not take the daemon down when the report cannot be built', async () => {
    internals(client).guilds._add({
      ...guildPayload(GUILD, 'test guild'),
      roles: [{ id: GUILD, name: '@everyone', position: 0, managed: false }],
    });
    daemon = start();

    expect(() => client.emit(Events.ClientReady, client as Client<true>)).not.toThrow();
    await daemon.settle();

    // And the rest of READY still happened: the gap is what recovers an outage.
    expect(pipelineRepo.unreconciledGaps(t.scopes.forGuild(GUILD))).toHaveLength(1);
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
      raw: t.raw,
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

describe('the backup timer (ADR 0034)', () => {
  let backupDir: string;

  beforeEach(() => {
    backupDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bnn-daemon-backup-'));
  });

  afterEach(() => {
    fs.rmSync(backupDir, { recursive: true, force: true });
  });

  it('takes a backup as soon as the daemon starts, not on the first interval', () => {
    daemon = start({ BANANASAURS_BACKUP_DIR: backupDir, BANANASAURS_BACKUP_INTERVAL_MIN: '1440' });
    expect(listBackups(backupDir)).toHaveLength(1);
  });

  it('stops taking backups once the daemon is stopped', async () => {
    vi.useFakeTimers();
    try {
      daemon = start({ BANANASAURS_BACKUP_DIR: backupDir, BANANASAURS_BACKUP_INTERVAL_MIN: '60' });
      expect(listBackups(backupDir)).toHaveLength(1);

      await daemon.stop();
      daemon = undefined as unknown as Daemon; // afterEach's daemon?.stop() must not double-stop

      vi.advanceTimersByTime(24 * 60 * 60_000);
      expect(listBackups(backupDir)).toHaveLength(1); // still just the one from start()
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('the seeded default assistant', () => {
  it('answers the bot tag on a fresh guild, exactly once', () => {
    daemon = start();
    const behaviours = assistantRepo.listBehaviours(t.scopes.forGuild(GUILD));
    expect(behaviours).toHaveLength(1);
    expect(behaviours[0]).toMatchObject({ id: 'default', answersBotTag: true });
  });

  it('never flags two behaviours: a restart keeps exactly one', async () => {
    daemon = start();
    await daemon.stop();
    daemon = undefined as unknown as Daemon;
    daemon = start();
    const flagged = assistantRepo
      .listBehaviours(t.scopes.forGuild(GUILD))
      .filter((b) => b.answersBotTag === true);
    expect(flagged.map((b) => b.id)).toEqual(['default']);
  });
});
