import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { pino } from 'pino';
import { Client } from 'discord.js';
import { parseConfig, parseGuildId, type Config } from '@bananasaurs/core';
import { buildClientOptions } from '@bananasaurs/discord';
import { effectRepo, guildRepo, jobRepo } from '@bananasaurs/storage';
import { openMigratedTestDatabase } from '@bananasaurs/storage/test-support';
import { BOT_USER_ID, FakeDiscord } from '@bananasaurs/testkit';
import { run } from '@bananasaurs/cli';
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
});
