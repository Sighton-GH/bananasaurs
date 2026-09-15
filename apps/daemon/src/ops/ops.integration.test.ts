import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { pino } from 'pino';
import { Client } from 'discord.js';
import {
  panelDefinitionSchema,
  parseConfig,
  parseGuildId,
  parseSnowflakeId,
  serialiseTrace,
  unicodeEmojiKey,
  type Config,
} from '@bananasaurs/core';
import { buildClientOptions } from '@bananasaurs/discord';
import {
  accountRepo,
  archiveRepo,
  authzRepo,
  automodFixtureRepo,
  automodRuleRepo,
  effectRepo,
  guildRepo,
  jobRepo,
  loggingRepo,
  modCaseRepo,
  modMatchReviewRepo,
  panelRepo,
  roleRepo,
} from '@bananasaurs/storage';
import { openMigratedTestDatabase } from '@bananasaurs/storage/test-support';
import { BOT_USER_ID, FakeDiscord } from '@bananasaurs/testkit';
import { run } from '@bananasaurs/cli';
import { createServer, hashToken } from '@bananasaurs/http';
import { createDaemon, type Daemon } from '../runtime/daemon.js';
import { bindOpsSocket, type OpsSocketServer } from './socket.js';

/**
 * The operator CLI, end to end: a real command line, a real Unix socket, the
 * real dispatcher, and a real migrated database.
 *
 * The reason this exists rather than only the unit tests either side of it is
 * the class of bug WP4's report named — "no daemon trigger for X". Every piece
 * of slice 13 can be individually correct and the CLI still answer nothing,
 * because `createDaemon` never built a dispatcher or `index.ts` never called
 * `serve`. Nothing but assembling the whole chain catches that.
 *
 * Only `index.ts`'s own three lines are missing, and they are exercised by the
 * ordering test at the bottom.
 */

const GUILD = parseGuildId('234567890123456789');
const OWNER = '345678901234567890';
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

let t: ReturnType<typeof openMigratedTestDatabase>;
let discord: FakeDiscord;
let client: Client;
let daemon: Daemon;
let socket: OpsSocketServer;
let dir: string;
let socketPath: string;

beforeEach(async () => {
  t = openMigratedTestDatabase();
  discord = new FakeDiscord({ guildId: GUILD });
  client = new Client(buildClientOptions(() => BOT_USER_ID));
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bananasaurs-cli-'));
  socketPath = path.join(dir, 'admin.sock');
  socket = await bindOpsSocket({ socketPath, logger });
});

afterEach(async () => {
  await socket.close();
  await daemon.stop();
  await client.destroy();
  t.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

const startDaemon = (over: Record<string, string> = {}): void => {
  daemon = createDaemon({
    config: config(over),
    scopes: t.scopes,
    raw: t.raw,
    discord,
    client,
    logger,
    now: () => discord.now(),
  });
  socket.serve((raw) => daemon.ops.dispatch(raw));
};

interface Invocation {
  code: number;
  out: string;
  err: string;
}

/** Drives the real CLI over the real socket, as a shell would. */
const cli = async (line: string): Promise<Invocation> => {
  const out: string[] = [];
  const err: string[] = [];
  const code = await run({
    argv: line.split(' ').filter(Boolean),
    env: { BANANASAURS_SOCKET_PATH: socketPath },
    unixUser: 'bryan',
    writeOut: (text) => out.push(text),
    writeErr: (text) => err.push(text),
  });
  return { code, out: out.join(''), err: err.join('') };
};

describe('the operator CLI, end to end', () => {
  it('answers `bananasaurs status` from the real database', async () => {
    startDaemon();
    guildRepo.upsertGuild(t.scopes.forGuild(GUILD), {
      name: 'Engineering Club',
      enabled: true,
      now: discord.now(),
    });

    const result = await cli('status');
    expect(result.code).toBe(0);
    expect(result.out).toContain('Engineering Club');
    expect(result.out).toContain(GUILD);
    // Not connected: this client has never logged in, and status must say so
    // rather than reporting a cheerful default.
    expect(result.out).toMatch(/DISCONNECTED/);
  });

  it('reports real job counts and real scheduler lag', async () => {
    startDaemon();
    const scope = t.scopes.forGuild(GUILD);
    guildRepo.upsertGuild(scope, { name: 'g', enabled: true, now: discord.now() });
    jobRepo.enqueue(scope, {
      kind: 'reconcile',
      payload: '{}',
      dedupeKey: 'reconcile:x',
      now: discord.now(),
      runAfter: discord.now() - 5_000,
    });

    const result = await cli('status --json');
    expect(result.code).toBe(0);
    const data = JSON.parse(result.out) as { jobs: Record<string, number>; schedulerLagMs: number };
    expect(data.jobs).toEqual({ queued: 1 });
    expect(data.schedulerLagMs).toBe(5_000);
  });

  it('refuses a guild that is not in the allowlist, over the socket', async () => {
    startDaemon();
    const result = await cli('status --guild 111111111111111111');
    expect(result.code).toBe(2);
    expect(result.err).toContain('BANANASAURS_GUILD_ALLOWLIST');
  });

  it('refuses an unknown command before it reaches the socket', async () => {
    startDaemon();
    const result = await cli('destroy everything --confirm');
    expect(result.code).toBe(2);
    expect(result.err).toMatch(/no such command/);
  });

  it('answers --json with parseable output and nothing else on stdout', async () => {
    startDaemon();
    guildRepo.upsertGuild(t.scopes.forGuild(GUILD), {
      name: 'g',
      enabled: true,
      now: discord.now(),
    });
    const result = await cli('status --json');
    expect(() => JSON.parse(result.out) as unknown).not.toThrow();
  });

  it('reports the daemon as read-only when it was started that way', async () => {
    // A separate database, because readonly is a property of the opened handle.
    const readonly = openMigratedTestDatabase();
    guildRepo.upsertGuild(readonly.scopes.forGuild(GUILD), {
      name: 'g',
      enabled: true,
      now: 0,
    });
    daemon = createDaemon({
      config: config({ BANANASAURS_READONLY: '1', BANANASAURS_DRY_RUN: '1' }),
      scopes: readonly.readonlyScopes,
      raw: readonly.raw,
      discord,
      client,
      logger,
      now: () => discord.now(),
    });
    socket.serve((raw) => daemon.ops.dispatch(raw));

    const result = await cli('status');
    expect(result.code).toBe(0);
    expect(result.out).toMatch(/read-only/i);
    readonly.close();
  });

  it('refuses a request that arrives before serve(), which is the startup window', async () => {
    // No `startDaemon()`: the socket is bound but no dispatcher is attached,
    // exactly as it is between `bindSocketOrFail` and the database opening.
    daemon = createDaemon({
      config: config(),
      scopes: t.scopes,
      raw: t.raw,
      discord,
      client,
      logger,
      now: () => discord.now(),
    });
    const result = await cli('status');
    expect(result.code).toBe(1);
    expect(result.err).toMatch(/still starting/);
  });

  describe('`bananasaurs killswitch`, against the real database', () => {
    const seed = (): void => {
      guildRepo.upsertGuild(t.scopes.forGuild(GUILD), {
        name: 'Engineering Club',
        enabled: true,
        now: discord.now(),
      });
    };

    it('refuses without --confirm, and changes nothing', async () => {
      startDaemon();
      seed();
      const result = await cli('killswitch on');
      expect(result.code).toBe(3);
      expect(result.err).toMatch(/--confirm/);
      expect(guildRepo.readSafetyState(t.scopes.forGuild(GUILD))?.killswitch).toBe(false);
      expect(effectRepo.tailAudit(t.scopes.forGuild(GUILD))).toEqual([]);
    });

    it('flips the column the effect gateway actually reads', async () => {
      startDaemon();
      seed();
      const result = await cli('killswitch on --confirm');
      expect(result.code).toBe(0);
      expect(guildRepo.readSafetyState(t.scopes.forGuild(GUILD))?.killswitch).toBe(true);
    });

    it('turns it off again', async () => {
      startDaemon();
      seed();
      await cli('killswitch on --confirm');
      await cli('killswitch off --confirm');
      expect(guildRepo.readSafetyState(t.scopes.forGuild(GUILD))?.killswitch).toBe(false);
    });

    it('writes a real audit row, claimed identity and all', async () => {
      startDaemon();
      seed();
      await cli('killswitch on --confirm');
      const rows = effectRepo.tailAudit(t.scopes.forGuild(GUILD));
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        actorType: 'operator_cli',
        actorUnixUserClaimed: 'bryan',
        action: 'killswitch.enabled',
        subjectType: 'guild',
        subjectId: GUILD,
      });
      // The claim must not have been laundered into the verified-identity column.
      expect(rows[0]?.actorId).toBeNull();
      expect(JSON.parse(rows[0]?.before ?? 'null')).toEqual({ killswitch: false });
      expect(JSON.parse(rows[0]?.after ?? 'null')).toEqual({ killswitch: true });
    });

    it('refuses every write when the daemon is read-only, and records nothing', async () => {
      const readonly = openMigratedTestDatabase();
      guildRepo.upsertGuild(readonly.scopes.forGuild(GUILD), { name: 'g', enabled: true, now: 0 });
      daemon = createDaemon({
        config: config({ BANANASAURS_READONLY: '1', BANANASAURS_DRY_RUN: '1' }),
        scopes: readonly.readonlyScopes,
        raw: readonly.raw,
        discord,
        client,
        logger,
        now: () => discord.now(),
      });
      socket.serve((raw) => daemon.ops.dispatch(raw));

      const result = await cli('killswitch on --confirm');
      // Exit 3: refused by a control, not a command that ran and failed.
      expect(result.code).toBe(3);
      expect(guildRepo.readSafetyState(readonly.scopes.forGuild(GUILD))?.killswitch).toBe(false);
      expect(effectRepo.tailAudit(readonly.scopes.forGuild(GUILD))).toEqual([]);
      readonly.close();
    });

    it('does not touch another guild, even when one is named explicitly', async () => {
      startDaemon();
      seed();
      const other = t.scopes.forGuild(parseGuildId('245678901234567890'));
      guildRepo.upsertGuild(other, { name: 'other', enabled: true, now: discord.now() });

      const result = await cli('killswitch on --guild 245678901234567890 --confirm');
      expect(result.code).toBe(2);
      expect(guildRepo.readSafetyState(other)?.killswitch).toBe(false);
      expect(guildRepo.readSafetyState(t.scopes.forGuild(GUILD))?.killswitch).toBe(false);
    });
  });

  describe('the read commands, against the real database', () => {
    const seed = (): void => {
      guildRepo.upsertGuild(t.scopes.forGuild(GUILD), {
        name: 'Engineering Club',
        enabled: true,
        now: discord.now(),
      });
    };

    it('`config get` returns a real configuration value', async () => {
      startDaemon();
      seed();
      const result = await cli('config get BANANASAURS_DRY_RUN');
      expect(result.code).toBe(0);
      expect(result.out).toContain('BANANASAURS_DRY_RUN=false');
      // Labelled with its namespace (ADR 0025), so an operator cannot read a
      // process value as the guild's own setting.
      expect(result.out).toContain('environment');
    });

    it('`config get` redacts the bot token, which the config really does hold', async () => {
      // The end of the chain that matters: the daemon has a real token in
      // `config`, and the redaction happens in `redactedConfig()` before the
      // command sees anything (ADR 0013 §4).
      startDaemon();
      seed();
      const result = await cli('config get DISCORD_BOT_TOKEN');
      expect(result.code).toBe(0);
      expect(result.out).toContain('DISCORD_BOT_TOKEN=<redacted>');
      expect(result.out).not.toContain('not.a.real.token');
    });

    it('no read command leaks the token, whatever it prints', async () => {
      startDaemon();
      seed();
      for (const line of ['status', 'status --json', 'doctor', 'audit tail', 'jobs list']) {
        const result = await cli(line);
        expect(result.out + result.err, line).not.toContain('not.a.real.token');
      }
    });

    it('`audit tail` reads back a row the CLI itself wrote', async () => {
      startDaemon();
      seed();
      await cli('killswitch on --confirm');
      const result = await cli('audit tail');
      expect(result.code).toBe(0);
      expect(result.out).toContain('killswitch.enabled');
      expect(result.out).toContain('claimed unix user bryan');
      // **Not** labelled dry-run or inferred. Both columns are SQLite integers
      // and the daemon converts them to booleans; a conversion that returned a
      // constant would label every real row a guess, which is the opposite of
      // the honesty convention WP4 established (mutation 152).
      expect(result.out).not.toContain('dry-run');
      expect(result.out).not.toContain('inferred');
      const asJson = await cli('audit tail --json');
      expect(JSON.parse(asJson.out)).toMatchObject([{ dryRun: false, inferred: false }]);
    });

    it('`audit tail --since` excludes anything older than the window', async () => {
      startDaemon();
      seed();
      await cli('killswitch on --confirm');
      // The fake clock is what `now` reads, so moving it forward moves the
      // window past the row the previous command wrote.
      discord.advance(3 * 60 * 60 * 1000);
      const result = await cli('audit tail --since 1h');
      expect(result.code).toBe(0);
      expect(result.out).toMatch(/no audit events/);
    });

    it('`jobs list` shows a real queued job and how overdue it is', async () => {
      startDaemon();
      seed();
      jobRepo.enqueue(t.scopes.forGuild(GUILD), {
        kind: 'reconcile_guild',
        payload: '{}',
        dedupeKey: 'reconcile:x',
        now: discord.now(),
        runAfter: discord.now() - 5_000,
      });
      const result = await cli('jobs list');
      expect(result.code).toBe(0);
      expect(result.out).toContain('reconcile_guild');
      expect(result.out).toContain('due 5s ago');
    });

    it('`log routing list` says outright that WP4 is inert with no routes', async () => {
      startDaemon();
      seed();
      const result = await cli('log routing list');
      expect(result.code).toBe(0);
      expect(result.out).toMatch(/nothing is being logged/i);
    });

    it('`panel list` reports an empty configuration rather than an empty table', async () => {
      startDaemon();
      seed();
      const result = await cli('panel list');
      expect(result.code).toBe(0);
      expect(result.out).toMatch(/no panels/);
    });

    it('`doctor` runs against the real client and reports the disconnected session', async () => {
      startDaemon();
      seed();
      const result = await cli('doctor');
      // Exit 0: `doctor` answering "there are problems" is a successful command.
      expect(result.code).toBe(0);
      expect(result.out).toContain('PROBLEMS FOUND');
    });

    it('every read command answers over the socket, none of them 500s', async () => {
      startDaemon();
      seed();
      for (const line of [
        'status',
        'doctor',
        'audit tail',
        'jobs list',
        'panel list',
        'log routing list',
        'config get BANANASAURS_ENV',
      ]) {
        const result = await cli(line);
        expect(result.code, `${line} exited ${String(result.code)}: ${result.err}`).toBe(0);
      }
    });

    it('answers every read command as JSON too, for an agent', async () => {
      startDaemon();
      seed();
      for (const line of [
        'status --json',
        'doctor --json',
        'audit tail --json',
        'jobs list --json',
        'panel list --json',
        'log routing list --json',
      ]) {
        const result = await cli(line);
        expect(result.code, line).toBe(0);
        expect(() => JSON.parse(result.out) as unknown, line).not.toThrow();
      }
    });
  });
  /**
   * The write commands that stay inside the database (slice 13d).
   *
   * Asserted against the columns the *rest of the product* reads, never against
   * the command's own output: `loggingRepo.findRoute` is what the logging
   * subscriber calls, and `guildRepo.readSafetyState` is what the effect
   * gateway calls. A command that printed a convincing sentence and wrote the
   * wrong column would pass a test of its text and fail these.
   */
  describe('the database write commands', () => {
    const scope = () => t.scopes.forGuild(GUILD);
    const seed = (): void => {
      guildRepo.upsertGuild(scope(), {
        name: 'Engineering Club',
        enabled: true,
        now: discord.now(),
      });
    };
    const CHANNEL = '456789012345678901';

    it('`config set` changes the column the effect gateway reads', async () => {
      startDaemon();
      seed();
      const result = await cli('config set role_rate_per_min 60 --confirm');
      expect(result.code).toBe(0);
      expect(guildRepo.readSafetyState(scope())?.roleRatePerMin).toBe(60);

      const rows = effectRepo.tailAudit(scope());
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        action: 'config.set',
        actorType: 'operator_cli',
        actorId: null,
        actorUnixUserClaimed: 'bryan',
        via: 'ssh',
      });
      expect(JSON.parse(rows[0]?.before ?? 'null')).toEqual({ role_rate_per_min: 20 });
      expect(JSON.parse(rows[0]?.after ?? 'null')).toEqual({ role_rate_per_min: 60 });
    });

    it('`config set` clears a breaker that nothing else in the product could', async () => {
      startDaemon();
      seed();
      guildRepo.tripBreaker(scope(), 'five failures in a row', discord.now());
      expect(guildRepo.readSafetyState(scope())?.breakerOpen).toBe(true);

      const result = await cli('config set breaker closed --confirm');
      expect(result.code).toBe(0);
      expect(guildRepo.readSafetyState(scope())?.breakerOpen).toBe(false);
    });

    it('`config set` refuses a process configuration key, and changes nothing', async () => {
      startDaemon();
      seed();
      const result = await cli('config set BANANASAURS_DRY_RUN off --confirm');
      expect(result.code).toBe(1);
      expect(result.err).toMatch(/process configuration/);
      expect(guildRepo.readSafetyState(scope())?.dryRun).toBe(false);
      expect(effectRepo.tailAudit(scope())).toEqual([]);
    });

    it('`config get` reads a guild setting the same command just wrote', async () => {
      // The pair `docs/17` documents, working as a pair (ADR 0025).
      startDaemon();
      seed();
      await cli('config set reconcile_budget 99 --confirm');
      const result = await cli('config get reconcile_budget');
      expect(result.code).toBe(0);
      expect(result.out).toContain('reconcile_budget=99');
      expect(result.out).toContain(GUILD);
    });

    it('`log routing set` makes WP4 not inert, which is what it was for', async () => {
      startDaemon();
      seed();
      const result = await cli(`log routing set member_join ${CHANNEL} --confirm`);
      expect(result.code).toBe(0);

      // The exact call the logging subscriber makes on a member join.
      expect(loggingRepo.findRoute(scope(), 'member_join')).toMatchObject({
        channelId: CHANNEL,
        enabled: true,
        includeContent: true,
      });
      // And the gap-marker query, which is the other reader of the table.
      expect(loggingRepo.listEnabledLogChannels(scope())).toEqual([CHANNEL]);

      const listed = await cli('log routing list');
      expect(listed.out).toContain(CHANNEL);
      expect(listed.out).not.toMatch(/nothing is being logged/i);
    });

    it('`log routing set --no-content` keeps the message text out of the log', async () => {
      startDaemon();
      seed();
      const result = await cli(`log routing set message_edit ${CHANNEL} --no-content --confirm`);
      expect(result.code).toBe(0);
      expect(loggingRepo.findRoute(scope(), 'message_edit')?.includeContent).toBe(false);
    });

    it('`log routing off` stops the logging and keeps the channel', async () => {
      startDaemon();
      seed();
      await cli(`log routing set member_join ${CHANNEL} --confirm`);
      const result = await cli('log routing off member_join --confirm');
      expect(result.code).toBe(0);

      expect(loggingRepo.findRoute(scope(), 'member_join')?.enabled).toBe(false);
      expect(loggingRepo.listEnabledLogChannels(scope())).toEqual([]);
      // Turning it back on needs no channel id, which is why `off` disables
      // rather than deletes.
      expect(loggingRepo.listRoutes(scope())[0]?.channelId).toBe(CHANNEL);
    });

    it('`log routing exclude` beats a route that is otherwise configured', async () => {
      startDaemon();
      seed();
      await cli(`log routing set member_join ${CHANNEL} --confirm`);
      const result = await cli(`log routing exclude ${CHANNEL} --confirm`);
      expect(result.code).toBe(0);
      // The subscriber checks the exclusion before the route.
      expect(loggingRepo.isChannelExcluded(scope(), CHANNEL)).toBe(true);

      await cli(`log routing unexclude ${CHANNEL} --confirm`);
      expect(loggingRepo.isChannelExcluded(scope(), CHANNEL)).toBe(false);
    });

    it('`jobs retry` returns a real failed job to the real queue', async () => {
      startDaemon();
      seed();
      const enqueued = jobRepo.enqueue(scope(), {
        kind: 'reconcile_guild',
        payload: '{}',
        dedupeKey: 'reconcile:all',
        now: discord.now(),
      });
      const jobId = enqueued.jobId ?? -1;
      jobRepo.claimNext(scope(), discord.now());
      jobRepo.failJob(scope(), jobId, 'Discord said 503', discord.now(), { permanent: true });
      expect(jobRepo.findJob(scope(), jobId)?.state).toBe('failed');

      const result = await cli(`jobs retry ${String(jobId)} --confirm`);
      expect(result.code).toBe(0);
      expect(jobRepo.findJob(scope(), jobId)).toMatchObject({ state: 'queued', attempts: 0 });
      expect(effectRepo.tailAudit(scope())[0]).toMatchObject({ action: 'job.retried' });
    });

    it('`jobs retry` refuses a job that is already queued, and audits nothing', async () => {
      startDaemon();
      seed();
      const enqueued = jobRepo.enqueue(scope(), {
        kind: 'reconcile_guild',
        payload: '{}',
        dedupeKey: 'reconcile:all',
        now: discord.now(),
      });
      const result = await cli(`jobs retry ${String(enqueued.jobId ?? -1)} --confirm`);
      expect(result.code).toBe(1);
      expect(result.err).toMatch(/already going to run/);
      expect(effectRepo.tailAudit(scope())).toEqual([]);
    });

    it('refuses every write command without --confirm, and writes nothing', async () => {
      startDaemon();
      seed();
      for (const line of [
        'config set role_rate_per_min 60',
        `log routing set member_join ${CHANNEL}`,
        'log routing off member_join',
        `log routing exclude ${CHANNEL}`,
        `log routing unexclude ${CHANNEL}`,
        'jobs retry 1',
      ]) {
        const result = await cli(line);
        // Exit 3: refused by a control, not a command that ran and failed.
        expect(result.code, line).toBe(3);
        expect(result.err, line).toMatch(/--confirm/);
      }
      expect(guildRepo.readSafetyState(scope())?.roleRatePerMin).toBe(20);
      expect(loggingRepo.listRoutes(scope())).toEqual([]);
      expect(loggingRepo.listExcludedChannels(scope())).toEqual([]);
      expect(effectRepo.tailAudit(scope())).toEqual([]);
    });

    it('starts read-only against a database it has never written', async () => {
      // `docs/17` §1: "BANANASAURS_READONLY=1 makes every write command refuse.
      // Use this for ordinary inspection." Before this slice it could not be
      // used for that at all: `applyConfiguredDryRun` writes `guilds.dry_run`
      // from the environment at every start, so an observe-only process threw
      // `ReadonlyError` out of `createDaemon` on any database whose row was
      // missing or whose column disagreed — which is every fresh install.
      const readonly = openMigratedTestDatabase();
      expect(() => {
        daemon = createDaemon({
          config: config({ BANANASAURS_READONLY: '1', BANANASAURS_DRY_RUN: '0' }),
          scopes: readonly.readonlyScopes,
          raw: readonly.raw,
          discord,
          client,
          logger,
          now: () => discord.now(),
        });
      }).not.toThrow();
      socket.serve((raw) => daemon.ops.dispatch(raw));

      // And it answers, which is the point of starting it.
      const result = await cli('status');
      expect(result.code).toBe(0);
      readonly.close();
    });

    it('refuses every write command when the daemon is read-only', async () => {
      const readonly = openMigratedTestDatabase();
      guildRepo.upsertGuild(readonly.scopes.forGuild(GUILD), { name: 'g', enabled: true, now: 0 });
      daemon = createDaemon({
        config: config({ BANANASAURS_READONLY: '1' }),
        scopes: readonly.readonlyScopes,
        raw: readonly.raw,
        discord,
        client,
        logger,
        now: () => discord.now(),
      });
      socket.serve((raw) => daemon.ops.dispatch(raw));

      for (const line of [
        'config set role_rate_per_min 60 --confirm',
        `log routing set member_join ${CHANNEL} --confirm`,
        `log routing exclude ${CHANNEL} --confirm`,
      ]) {
        const result = await cli(line);
        expect(result.code, line).toBe(3);
      }
      expect(guildRepo.readSafetyState(readonly.scopes.forGuild(GUILD))?.roleRatePerMin).toBe(20);
      expect(loggingRepo.listRoutes(readonly.scopes.forGuild(GUILD))).toEqual([]);
      expect(effectRepo.tailAudit(readonly.scopes.forGuild(GUILD))).toEqual([]);
      readonly.close();
    });

    it('answers every write command as JSON too, for an agent', async () => {
      startDaemon();
      seed();
      for (const line of [
        'config set role_rate_per_min 60 --confirm --json',
        `log routing set member_join ${CHANNEL} --confirm --json`,
        `log routing exclude ${CHANNEL} --confirm --json`,
        `log routing unexclude ${CHANNEL} --confirm --json`,
        'log routing off member_join --confirm --json',
      ]) {
        const result = await cli(line);
        expect(result.code, `${line}: ${result.err}`).toBe(0);
        expect(() => JSON.parse(result.out) as unknown, line).not.toThrow();
      }
    });
  });
  /**
   * The write commands that reach Discord (slice 13e).
   *
   * Every one of them queues the unbounded half rather than awaiting it
   * (ADR 0026), so these tests run the job too — `daemon.drainJobs()` — and
   * then assert against `FakeDiscord`, which is the only place a role actually
   * changing is observable. Asserting on the command's own output would prove
   * that it printed a sentence.
   */
  describe('the write commands that reach Discord', () => {
    const scope = () => t.scopes.forGuild(GUILD);
    const CHANNEL = parseSnowflakeId('456789012345678901');
    const MESSAGE = parseSnowflakeId('567890123456789012');
    const ROLE = parseSnowflakeId('678901234567890123');
    const MEMBER = parseSnowflakeId('789012345678901234');

    const seed = (): void => {
      guildRepo.upsertGuild(scope(), {
        name: 'Engineering Club',
        enabled: true,
        now: discord.now(),
      });
      roleRepo.allowlistRole(scope(), ROLE);
      discord.defineRole({ id: ROLE, position: 1 });
      discord.setBotHighestRolePosition(10);
      discord.defineMember(MEMBER, [ROLE]);
    };

    const seedPanel = (over: Record<string, unknown> = {}): void => {
      discord.defineMessage({ channelId: CHANNEL, messageId: MESSAGE, authorId: MEMBER });
      panelRepo.createPanel(
        scope(),
        panelDefinitionSchema.parse({
          panelId: 'roles',
          kind: 'adopted',
          channelId: CHANNEL,
          messageId: MESSAGE,
          behaviour: 'toggle',
          component: 'reaction',
          options: [
            { optionId: 'brain', roleId: ROLE, emojiKey: unicodeEmojiKey('🧠'), position: 0 },
          ],
          ...over,
        }),
        discord.now(),
      );
    };

    /** One string field out of a job payload, without an `any` in the assertion. */
    const payloadField = (payload: string, key: string): string => {
      const parsed = JSON.parse(payload) as Record<string, unknown>;
      const value = parsed[key];
      return typeof value === 'string' ? value : `<${key} missing>`;
    };

    /** A batch holding one applied grant, as a member's click would leave it. */
    const seedAppliedGrant = (dedupeKey = 'reaction:brain:once'): string => {
      const batchId = effectRepo.openBatch(scope(), {
        source: 'reaction',
        actorType: 'system',
        actorId: undefined,
        now: discord.now(),
      });
      const claim = effectRepo.claimEffect(scope(), {
        dedupeKey,
        batchId,
        userId: MEMBER,
        roleId: ROLE,
        action: 'grant',
        // The whole basis of the inverse: we added it, they did not have it.
        hadRoleBefore: false,
        panelId: undefined,
        now: discord.now(),
      });
      effectRepo.recordOutcome(scope(), {
        effectId: claim.effectId,
        state: 'applied',
        completedAt: discord.now(),
        errorCode: undefined,
      });
      effectRepo.closeBatch(scope(), batchId, discord.now());
      return batchId;
    };

    it('`undo` queues the reversal and the job actually removes the role', async () => {
      startDaemon();
      seed();
      const batchId = seedAppliedGrant();
      expect(discord.memberRoles(MEMBER)).toContain(ROLE);

      const result = await cli(`undo ${batchId} --confirm`);
      expect(result.code, result.err).toBe(0);
      expect(result.out).toMatch(/1 of 1/);

      // Queued, not done — the command returned before anything reached Discord.
      expect(discord.memberRoles(MEMBER)).toContain(ROLE);

      await daemon.drainJobs();
      expect(discord.memberRoles(MEMBER)).not.toContain(ROLE);
      expect(effectRepo.findBatch(scope(), batchId)?.undoneAt).not.toBeNull();
    });

    it('`undo` refuses the same batch a second time, once the job has run', async () => {
      startDaemon();
      seed();
      const batchId = seedAppliedGrant();
      await cli(`undo ${batchId} --confirm`);
      await daemon.drainJobs();

      const again = await cli(`undo ${batchId} --confirm`);
      expect(again.code).toBe(1);
      expect(again.err).toMatch(/already undone/);
    });

    it('a queued undo still obeys the kill switch, like every other role change', async () => {
      // Undo is a replay of the inverse through `applyRoleEffect`, not a second
      // path with its own permissions. An undo that could bypass the kill switch
      // would be an unaudited way to change roles.
      startDaemon();
      seed();
      const batchId = seedAppliedGrant();
      await cli(`undo ${batchId} --confirm`);
      await cli('killswitch on --confirm');

      await daemon.drainJobs();
      expect(discord.memberRoles(MEMBER)).toContain(ROLE);
    });

    it('`undo` refuses a batch whose effects changed nothing', async () => {
      startDaemon();
      seed();
      const batchId = effectRepo.openBatch(scope(), {
        source: 'reaction',
        actorType: 'system',
        actorId: undefined,
        now: discord.now(),
      });
      const claim = effectRepo.claimEffect(scope(), {
        dedupeKey: 'reaction:brain:noop',
        batchId,
        userId: MEMBER,
        roleId: ROLE,
        action: 'grant',
        // They already had it, so we changed nothing and there is no inverse.
        hadRoleBefore: true,
        panelId: undefined,
        now: discord.now(),
      });
      effectRepo.recordOutcome(scope(), {
        effectId: claim.effectId,
        state: 'applied',
        completedAt: discord.now(),
        errorCode: undefined,
      });

      const result = await cli(`undo ${batchId} --confirm`);
      expect(result.code).toBe(1);
      expect(result.err).toMatch(/nothing to undo/);
      expect(jobRepo.listJobs(scope(), {})).toEqual([]);
    });

    it('`panel sync` seeds the reactions and queues a pass for that panel only', async () => {
      startDaemon();
      seed();
      seedPanel();

      const result = await cli('panel sync roles --confirm');
      expect(result.code, result.err).toBe(0);
      // The bounded half happened synchronously, at Discord.
      expect(discord.restCalls('createReaction')).toHaveLength(1);

      const queued = jobRepo.listJobs(scope(), {});
      expect(queued).toHaveLength(1);
      expect(queued[0]?.kind).toBe('reconcile_guild');
      expect(JSON.parse(queued[0]?.payload ?? '{}')).toMatchObject({
        reason: 'operator',
        panelId: 'roles',
      });
    });

    it('`panel sync` twice queues one pass, not two', async () => {
      // The dedupe key is per panel and partial over queued/running (ADR 0016),
      // so a repeat collapses rather than doubling the work.
      startDaemon();
      seed();
      seedPanel();
      await cli('panel sync roles --confirm');
      await cli('panel sync roles --confirm');
      expect(jobRepo.listJobs(scope(), {})).toHaveLength(1);
    });

    it('`panel sync` on two panels queues two passes, not one', async () => {
      // The dedupe key is per panel. Without that, syncing panel B would be
      // absorbed by panel A's pending pass and silently never happen —
      // indistinguishable, from the terminal, from having worked.
      startDaemon();
      seed();
      seedPanel();
      const SECOND_MESSAGE = parseSnowflakeId('890123456789012345');
      discord.defineMessage({ channelId: CHANNEL, messageId: SECOND_MESSAGE, authorId: MEMBER });
      panelRepo.createPanel(
        scope(),
        panelDefinitionSchema.parse({
          panelId: 'other',
          kind: 'adopted',
          channelId: CHANNEL,
          messageId: SECOND_MESSAGE,
          behaviour: 'toggle',
          component: 'reaction',
          options: [
            { optionId: 'brain', roleId: ROLE, emojiKey: unicodeEmojiKey('🧠'), position: 0 },
          ],
        }),
        discord.now(),
      );

      await cli('panel sync roles --confirm');
      await cli('panel sync other --confirm');

      const queued = jobRepo.listJobs(scope(), {});
      expect(queued).toHaveLength(2);
      expect(queued.map((j) => payloadField(j.payload, 'panelId')).sort()).toEqual([
        'other',
        'roles',
      ]);
    });

    it('`undo` on two batches queues two reversals, not one', async () => {
      // Per batch, for the same reason. A shared key would mean the second
      // batch was never reversed and the command said it would be.
      startDaemon();
      seed();
      const first = seedAppliedGrant();
      const second = seedAppliedGrant('reaction:brain:twice');

      await cli(`undo ${first} --confirm`);
      await cli(`undo ${second} --confirm`);

      const queued = jobRepo.listJobs(scope(), {});
      expect(queued).toHaveLength(2);
      expect(queued.map((j) => payloadField(j.payload, 'batchId')).sort()).toEqual(
        [first, second].sort(),
      );
    });

    it('`panel sync` rewrites an already-posted managed panel to match its options', async () => {
      // The drift a managed panel actually suffers: an option was added in the
      // configuration and the message members can see still shows the old
      // buttons. A sync that only posted would repair the never-posted case and
      // leave this one broken forever.
      startDaemon();
      seed();
      panelRepo.createPanel(
        scope(),
        panelDefinitionSchema.parse({
          panelId: 'buttons',
          kind: 'managed',
          channelId: CHANNEL,
          behaviour: 'toggle',
          component: 'button',
          options: [{ optionId: 'brain', roleId: ROLE, label: 'Brain', position: 0 }],
        }),
        discord.now(),
      );
      await cli('panel sync buttons --confirm');
      expect(discord.restCalls('editMessage')).toEqual([]);

      discord.resetCalls();
      const again = await cli('panel sync buttons --confirm');
      expect(again.code, again.err).toBe(0);
      expect(again.out).toMatch(/Rewrote panel/);
      expect(discord.restCalls('editMessage')).toHaveLength(1);
      // Posted once, not twice: the second sync edits the message it already has.
      expect(discord.restCalls('sendMessage')).toEqual([]);
    });

    it('`panel sync` posts a managed panel that has never been posted', async () => {
      // Nothing else in the shipped product ever calls `postManagedPanel`, so
      // before this command a configured managed panel could not reach Discord.
      startDaemon();
      seed();
      panelRepo.createPanel(
        scope(),
        panelDefinitionSchema.parse({
          panelId: 'buttons',
          kind: 'managed',
          channelId: CHANNEL,
          behaviour: 'toggle',
          component: 'button',
          options: [{ optionId: 'brain', roleId: ROLE, label: 'Brain', position: 0 }],
        }),
        discord.now(),
      );

      const result = await cli('panel sync buttons --confirm');
      expect(result.code, result.err).toBe(0);
      expect(result.out).toMatch(/Posted panel/);
      expect(discord.restCalls('sendMessage')).toHaveLength(1);
      // Recorded, or an interaction on the message could not find the panel.
      expect(panelRepo.findPanel(scope(), 'buttons')?.messageId).toBeDefined();
      // A button panel has no reactions to drift, so no pass is queued.
      expect(jobRepo.listJobs(scope(), {})).toEqual([]);
    });

    it('`panel sync` refuses a panel `doctor` took out of service', async () => {
      startDaemon();
      seed();
      seedPanel();
      panelRepo.setPanelStatus(
        scope(),
        'roles',
        'disabled_by_doctor',
        'role above bot',
        discord.now(),
      );

      const result = await cli('panel sync roles --confirm');
      expect(result.code).toBe(1);
      expect(result.err).toMatch(/Re-enable it first/);
      expect(discord.restCalls('createReaction')).toEqual([]);
      expect(jobRepo.listJobs(scope(), {})).toEqual([]);
    });

    it('`adoption allow` reaches the live process, which a database CLI could not', async () => {
      // The concrete reason ADR 0013 puts the CLI on a socket: the allowance
      // lives in `RateLimiter`, in this process's memory, and nothing that
      // wrote SQLite could touch it.
      startDaemon();
      seed();
      const first = await cli('adoption allow 250 --confirm');
      expect(first.code, first.err).toBe(0);
      expect(first.out).toMatch(/now 250/);

      // Cumulative against the same live bucket, not a fresh one per request.
      const second = await cli('adoption allow 50 --confirm');
      expect(second.out).toMatch(/now 300/);

      const rows = effectRepo.tailAudit(scope());
      expect(rows[0]).toMatchObject({ action: 'adoption.allowance_granted' });
      expect(JSON.parse(rows[0]?.after ?? 'null')).toEqual({ allowance: 300 });
    });

    it('refuses all three without --confirm, and reaches Discord for none of them', async () => {
      startDaemon();
      seed();
      seedPanel();
      const batchId = seedAppliedGrant();
      discord.resetCalls();

      for (const line of ['panel sync roles', `undo ${batchId}`, 'adoption allow 10']) {
        const result = await cli(line);
        expect(result.code, line).toBe(3);
        expect(result.err, line).toMatch(/--confirm/);
      }
      expect(discord.restCalls()).toEqual([]);
      expect(jobRepo.listJobs(scope(), {})).toEqual([]);
      expect(effectRepo.tailAudit(scope())).toEqual([]);
    });
  });
});

/**
 * IMPORTANT-4: the four automod port bindings in `opsPortsFor`
 * (`findAutomodRule`, `listAutomodFixtures`, `listUnreviewedMatches`,
 * `recordMatchVerdict`) are the only code that connects `automod dryrun` /
 * `automod review` / `automod verdict` to the real repositories. Every other
 * test exercising those three commands drives them through `fakeOpsPorts`
 * (`packages/core/src/ops/commands/automod.test.ts`), so the bindings had
 * `typecheck` as their entire coverage — the path that runs on flip day had
 * never been executed. One test, over the real socket against a real
 * migrated database, covers all four.
 */
describe('automod dryrun / review / verdict, end to end (IMPORTANT-4)', () => {
  const scope = () => t.scopes.forGuild(GUILD);
  const MEMBER = parseSnowflakeId('456789012345678901');

  it('carries a match from dryrun through review to a recorded verdict and a propagated fixture label', async () => {
    startDaemon();
    guildRepo.upsertGuild(scope(), { name: 'g', enabled: true, now: discord.now() });

    automodRuleRepo.createRule(scope(), {
      ruleId: 'r1',
      kind: 'keyword_filter',
      name: 'word filter',
      config: '{}',
      now: discord.now(),
    });
    automodRuleRepo.addCategory(scope(), {
      categoryId: 'c1',
      ruleId: 'r1',
      name: 'profanity',
      defaultAction: 'log_only',
    });
    automodRuleRepo.addTerm(scope(), { termId: 't1', categoryId: 'c1', text: 'badword' });

    const fixtureId = automodFixtureRepo.captureObservedFixture(scope(), {
      messageId: '900000000000000001',
      content: 'hello badword everyone',
      authorId: MEMBER,
      createdAt: discord.now(),
      attachments: [],
    });

    const { caseId } = modCaseRepo.openOrResolveCase(scope(), {
      memberId: MEMBER,
      now: discord.now(),
    });
    modCaseRepo.recordCaseEvent(scope(), {
      eventId: 'e1',
      caseId,
      ruleId: 'r1',
      memberId: MEMBER,
      at: discord.now(),
      matchedCategory: 'profanity',
      matchedSnippet: 'badword',
      actionTaken: 'would_delete',
      trace: serialiseTrace({
        kind: 'keyword_filter',
        matchedOn: 'badword',
        span: [6, 13],
        normalisations: ['lowercased'],
        detail: {},
      }),
      fixtureId,
    });

    // `automod dryrun r1` — exercises `findAutomodRule` and
    // `listAutomodFixtures`.
    const dryrun = await cli('automod dryrun r1');
    expect(dryrun.code, dryrun.err).toBe(0);
    expect(dryrun.out).toContain('badword');

    // `automod review` — exercises `listUnreviewedMatches`.
    const review = await cli('automod review');
    expect(review.code, review.err).toBe(0);
    expect(review.out).toContain('e1');
    expect(review.out).toContain('hello badword everyone');

    // `automod verdict e1 true_positive --confirm` — exercises
    // `recordMatchVerdict`.
    const verdict = await cli('automod verdict e1 true_positive --confirm');
    expect(verdict.code, verdict.err).toBe(0);
    expect(verdict.out).toContain('true_positive');

    const storedVerdict = modMatchReviewRepo.findVerdict(scope(), 'e1');
    expect(storedVerdict?.verdict).toBe('true_positive');

    const fixture = automodFixtureRepo.listFixtures(scope()).find((f) => f.fixtureId === fixtureId);
    expect(fixture?.label).toBe('should_match');

    // The match is now reviewed, so a second `automod review` must not
    // still list it — proof the write actually reached the same database
    // the read commands query, not just a side channel.
    const reviewAgain = await cli('automod review');
    expect(reviewAgain.out).not.toContain('e1');
  });

  it('replays a disabled rule through the production ports (the edit, dry-run, enable workflow)', async () => {
    // PR-47: an operator edits a disabled rule, dry-runs it, then enables
    // it. `daemon.portsFor` is the production `opsPortsFor` binding — the
    // same ports the dashboard dry-run route reads — so this proves the
    // production path replays the rule rather than answering 'no-such-rule'.
    startDaemon();
    guildRepo.upsertGuild(scope(), { name: 'g', enabled: true, now: discord.now() });

    automodRuleRepo.createRule(scope(), {
      ruleId: 'disabled-one',
      kind: 'keyword_filter',
      name: 'disabled word filter',
      config: '{}',
      now: discord.now(),
    });
    automodRuleRepo.addCategory(scope(), {
      categoryId: 'c1',
      ruleId: 'disabled-one',
      name: 'profanity',
      defaultAction: 'log_only',
    });
    automodRuleRepo.addTerm(scope(), { termId: 't1', categoryId: 'c1', text: 'badword' });
    automodRuleRepo.setRuleMode(scope(), {
      ruleId: 'disabled-one',
      enabled: false,
      now: discord.now(),
    });

    automodFixtureRepo.captureObservedFixture(scope(), {
      messageId: '900000000000000002',
      content: 'hello badword everyone',
      authorId: MEMBER,
      createdAt: discord.now(),
      attachments: [],
    });

    const report = daemon.portsFor(scope()).runAutomodDryRun('disabled-one');
    expect(report).not.toBe('no-such-rule');
    expect(report).toMatchObject({ usable: true, matched: 1 });
  });
});

describe('the dashboard recovery path, end to end (ADR 0012)', () => {
  /**
   * ADR 0012: *"the bootstrap path can be re-armed from the host by someone
   * with shell access… Document the recovery procedure and test it once."*
   * This is that test — the real CLI, the real socket, the real dispatcher and
   * a real migrated database, with nothing faked between the command line and
   * `bootstrap_tokens`.
   */

  const bootstrapTokenRows = (): { token_hash: string; consumed_at: number | null }[] =>
    t.raw.prepare(`SELECT token_hash, consumed_at FROM bootstrap_tokens`).all() as {
      token_hash: string;
      consumed_at: number | null;
    }[];

  it('issues a token and prints it once, storing only its hash', async () => {
    startDaemon();
    const result = await cli('bootstrap reissue --confirm');
    expect(result.code).toBe(0);

    const printed = /token=([A-Za-z0-9_-]+)/.exec(result.out)?.[1];
    expect(printed).toBeDefined();

    const rows = bootstrapTokenRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.token_hash).not.toBe(printed);
    expect(rows[0]?.token_hash).toBe(hashToken(printed ?? ''));
    expect(rows[0]?.consumed_at).toBeNull();
  });

  it('arms a server built afterwards, and that server accepts the printed token', async () => {
    // The end of the recovery procedure: reissue, restart, open the link. The
    // restart is what this second `createServer` stands in for — `/bootstrap`
    // is a registration-time decision, which is why the command says to
    // restart.
    startDaemon();
    const result = await cli('bootstrap reissue --confirm');
    const printed = /token=([A-Za-z0-9_-]+)/.exec(result.out)?.[1] ?? '';

    const api = createServer({
      deps: {
        scopes: t.scopes,
        now: () => discord.now(),
        guildIds: [GUILD],
        logger,
        readonly: false,
        portsFor: daemon.portsFor,
        instance: daemon.instance,
      },
    });
    const response = await api.inject({
      method: 'POST',
      url: '/api/bootstrap',
      payload: { token: printed, username: 'owner', password: 'correct horse battery staple' },
    });
    expect(response.statusCode).toBe(200);
    expect(bootstrapTokenRows()[0]?.consumed_at).not.toBeNull();
    await api.close();
  });

  it('refuses once that account exists, which is what stops a second owner', async () => {
    startDaemon();
    const first = await cli('bootstrap reissue --confirm');
    const printed = /token=([A-Za-z0-9_-]+)/.exec(first.out)?.[1] ?? '';

    const api = createServer({
      deps: {
        scopes: t.scopes,
        now: () => discord.now(),
        guildIds: [GUILD],
        logger,
        readonly: false,
        portsFor: daemon.portsFor,
        instance: daemon.instance,
      },
    });
    await api.inject({
      method: 'POST',
      url: '/api/bootstrap',
      payload: { token: printed, username: 'owner', password: 'correct horse battery staple' },
    });
    await api.close();

    const second = await cli('bootstrap reissue --confirm');
    expect(second.code).not.toBe(0);
    expect(second.err).toContain('1 dashboard account(s)');
  });

  it('needs --confirm, like every other write', async () => {
    startDaemon();
    const result = await cli('bootstrap reissue');
    expect(result.code).not.toBe(0);
    expect(bootstrapTokenRows()).toHaveLength(0);
  });

  it('writes an audit row that does not contain the token', async () => {
    startDaemon();
    const result = await cli('bootstrap reissue --confirm');
    const printed = /token=([A-Za-z0-9_-]+)/.exec(result.out)?.[1] ?? '';

    const rows = t.raw
      .prepare(`SELECT action, subject_type, after FROM audit_events WHERE action = ?`)
      .all('dashboard.bootstrap_reissued') as {
      action: string;
      subject_type: string;
      after: string | null;
    }[];
    expect(rows).toHaveLength(1);
    expect(rows[0]?.subject_type).toBe('instance');
    expect(JSON.stringify(rows)).not.toContain(printed);
  });

  it('refuses under BANANASAURS_READONLY without taking the daemon down', async () => {
    // Slice 13d's finding: something that writes at startup must refuse rather
    // than throw. The command is the same shape.
    daemon = createDaemon({
      config: config({ BANANASAURS_READONLY: '1' }),
      scopes: t.readonlyScopes,
      raw: t.raw,
      discord,
      client,
      logger,
      now: () => discord.now(),
    });
    socket.serve((raw) => daemon.ops.dispatch(raw));

    const result = await cli('bootstrap reissue --confirm');
    expect(result.code).not.toBe(0);
    expect(result.err).toContain('BANANASAURS_READONLY');
    expect(bootstrapTokenRows()).toHaveLength(0);
  });
});

/**
 * The ADR 0028 grant path through the real ports (ruling PR-102): the
 * capability lives in a guild, so the grant is a guild-scoped port over the
 * real `accountRepo` + `authzRepo`, reached here through `daemon.portsFor`
 * the way the operator dispatcher reaches it — not through a stub.
 */
describe('the account capability grant, end to end (ADR 0028)', () => {
  const scope = () => t.scopes.forGuild(GUILD);
  const OWNER_ID = 'acct_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
  const STRANGER_ID = 'acct_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

  const seed = (): void => {
    guildRepo.upsertGuild(scope(), {
      name: 'Engineering Club',
      enabled: true,
      now: discord.now(),
    });
    accountRepo.createAccount(t.scopes.instance(), {
      accountId: OWNER_ID,
      username: 'owner',
      passwordHash: 'not-a-real-hash',
      isOwner: true,
      now: discord.now(),
    });
    accountRepo.createAccount(t.scopes.instance(), {
      accountId: STRANGER_ID,
      username: 'stranger',
      passwordHash: 'not-a-real-hash',
      isOwner: false,
      now: discord.now(),
    });
    accountRepo.grantGuildAccess(scope(), OWNER_ID);
  };

  it('grants once, remembers the grant, and refuses an account without guild access', () => {
    startDaemon();
    seed();
    const ports = daemon.portsFor(scope());

    expect(
      ports.grantAccountCapability({
        username: 'owner',
        capability: 'mcp.authorize',
        grantedBy: 'operator_cli',
      }),
    ).toBe('granted');
    expect(
      ports.grantAccountCapability({
        username: 'owner',
        capability: 'mcp.authorize',
        grantedBy: 'operator_cli',
      }),
    ).toBe('already-held');
    expect(authzRepo.listAccountCapabilities(scope(), OWNER_ID)).toEqual(['mcp.authorize']);

    // No guild access: the composite foreign key would refuse, so the port
    // says so rather than throwing — and writes no row.
    expect(
      ports.grantAccountCapability({
        username: 'stranger',
        capability: 'mcp.authorize',
        grantedBy: 'operator_cli',
      }),
    ).toBe('no-guild-access');
    expect(authzRepo.listAccountCapabilities(scope(), STRANGER_ID)).toEqual([]);
  });
});

/**
 * The account commands through the real socket (M3b fix wave, finding 1):
 * `account list` is instance-level but still resolves a guild before it runs,
 * like every other operator command — this is the seam the five task reviews
 * missed, because nothing but the real dispatcher plus the real wiring joins
 * them. One dispatch proves the join; the second proves what the flag means.
 */
describe('the account commands, end to end', () => {
  const scope = () => t.scopes.forGuild(GUILD);
  const OWNER_ID = 'acct_cccccccccccccccccccccccccccccccc';

  it('`account list` answers over the real socket against the real database', async () => {
    startDaemon();
    guildRepo.upsertGuild(scope(), { name: 'g', enabled: true, now: discord.now() });
    accountRepo.createAccount(t.scopes.instance(), {
      accountId: OWNER_ID,
      username: 'owner',
      passwordHash: 'not-a-real-hash',
      isOwner: true,
      now: discord.now(),
    });

    const result = await cli('account list');
    expect(result.code, result.err).toBe(0);
    expect(result.out).toContain('owner');
    // Usernames and ids only — never a hash.
    expect(result.out).not.toContain('not-a-real-hash');
  });

  it('an account command without --guild is refused on a two-guild instance', async () => {
    startDaemon({ BANANASAURS_GUILD_ALLOWLIST: `${GUILD},245678901234567890` });
    guildRepo.upsertGuild(scope(), { name: 'g', enabled: true, now: discord.now() });

    const result = await cli('account list');
    expect(result.code).not.toBe(0);
    expect(result.err).toContain('must say which');
  });
});

/**
 * The visibility set behind `archiveSearch` (review F4): the port builds it
 * from `archiveRepo.listChannels`, never from caller input — the single most
 * security-relevant line in the slice. Nothing but driving the real ports
 * proves the two are joined that way: a regression passing `input.channelId`
 * in as the visibility set would keep every stub-driven command test green.
 */
describe('archive search visibility, end to end', () => {
  const scope = () => t.scopes.forGuild(GUILD);
  const CHANNEL_A = '456789012345678901';
  const CHANNEL_B = '567890123456789012';

  it('returns only the enabled channel’s message, and nothing for the non-enabled one', () => {
    startDaemon({ BANANASAURS_ARCHIVE_GUILDS: GUILD });
    guildRepo.upsertGuild(scope(), { name: 'g', enabled: true, now: discord.now() });
    const ports = daemon.portsFor(scope());
    expect(ports.archiveEnableChannel({ channelId: CHANNEL_A, attachmentPolicy: 'none' })).toBe(
      'enabled',
    );

    archiveRepo.upsertMessage(scope(), {
      messageId: '678901234567890123',
      channelId: CHANNEL_A,
      authorId: '789012345678901234',
      content: 'quince visibility proof alpha',
      createdAt: discord.now(),
      editedAt: undefined,
      attachments: [],
    });
    // A message in a channel that is NOT archive-enabled: no channel row, so
    // the composite foreign key would refuse it — inserted with enforcement
    // off, the shape a hand-written orphan row has. The FTS trigger still
    // fires, so the text IS in the index; only the visibility set keeps it
    // out of results.
    t.raw.pragma('foreign_keys = OFF');
    try {
      archiveRepo.upsertMessage(scope(), {
        messageId: '890123456789012345',
        channelId: CHANNEL_B,
        authorId: '789012345678901234',
        content: 'quince visibility proof alpha',
        createdAt: discord.now(),
        editedAt: undefined,
        attachments: [],
      });
    } finally {
      t.raw.pragma('foreign_keys = ON');
    }

    const result = ports.archiveSearch({ query: 'visibility' });
    expect(result.hits).toHaveLength(1);
    expect(result.hits[0]?.channelId).toBe(CHANNEL_A);
    expect(result.total).toBe(1);

    const narrowed = ports.archiveSearch({ query: 'visibility', channelId: CHANNEL_B });
    expect(narrowed.hits).toHaveLength(0);
    expect(narrowed.total).toBe(0);
  });
});
