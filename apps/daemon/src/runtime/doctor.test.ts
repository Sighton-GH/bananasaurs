import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client, GatewayIntentBits, Partials, Status, type Guild } from 'discord.js';
import { parseConfig, type Config } from '@bananasaurs/core';
import { buildClientOptions } from '@bananasaurs/discord';
import { openTestDatabase, performBackup } from '@bananasaurs/storage';
import {
  buildDoctorReport,
  formatDoctorReport,
  NATIVE_AUTOMOD_OBSERVABILITY_PERMISSIONS,
  RELEASE_1_PERMISSIONS,
  REQUIRED_PERMISSIONS,
} from './doctor.js';

/**
 * `doctor` v1, which `docs/21` exercise 1 step 3 specifies exactly: it must
 * report partials configured, both privileged intents granted **at runtime**,
 * the bot's own highest role position, and which of the allowlisted guilds it is
 * actually in.
 *
 * "At runtime" is the load-bearing phrase. `docs/STATE.md` records both
 * privileged intents as enabled in the Developer Portal, and `docs/19` §62 says
 * to take that at its word but assert it anyway — configuration and grant are
 * different facts, and only one of them stops the bot from working.
 */

const GUILD = '234567890123456789';
const ABSENT_GUILD = '245678901234567890';
const BOT = '123456789012345678';
const OWNER = '345678901234567890';
const BOT_ROLE = '555555555555555555';

const config = (over: Record<string, string> = {}): Config =>
  parseConfig({
    DISCORD_BOT_TOKEN: 'NOT.A.REALTOKEN',
    DISCORD_APPLICATION_ID: BOT,
    BANANASAURS_GUILD_ALLOWLIST: GUILD,
    BANANASAURS_OWNER_USER_ID: OWNER,
    DASHBOARD_SESSION_SECRET: 'b'.repeat(32),
    ...over,
  });

interface Internals {
  guilds: { _add: (data: object) => Guild };
  users: { _add: (data: object) => never };
}
const internals = (c: Client): Internals => c as unknown as Internals;

/**
 * What a successful IDENTIFY leaves behind.
 *
 * `client.isReady()` reads `client.ws.status`, which is the only in-process
 * evidence that Discord accepted the intents we asked for — so a test about
 * runtime grants has to be able to set it.
 */
const establishSession = (c: Client): void => {
  (c.ws as unknown as { status: number }).status = Status.Ready;
};

let client: Client;

const addGuild = (id: string, permissions: string): Guild =>
  internals(client).guilds._add({
    id,
    name: 'test guild',
    owner_id: OWNER,
    member_count: 30,
    channels: [],
    roles: [
      { id, name: '@everyone', position: 0, permissions: '0', managed: false },
      { id: BOT_ROLE, name: 'bananasaurs', position: 7, permissions, managed: true },
    ],
    members: [
      { user: { id: BOT, username: 'bananasaurs', discriminator: '0' }, roles: [BOT_ROLE] },
    ],
    emojis: [],
    unavailable: false,
  });

beforeEach(() => {
  client = new Client(buildClientOptions(() => BOT));
  const mutable = client as unknown as { user: unknown };
  mutable.user = internals(client).users._add({
    id: BOT,
    username: 'bananasaurs',
    discriminator: '0',
  });
  establishSession(client);
});

describe('partials', () => {
  it('reports the ones the client was built with', () => {
    addGuild(GUILD, String(REQUIRED_PERMISSIONS));
    const report = buildDoctorReport(client, config());

    expect(report.partials.configured).toContain('Message');
    expect(report.partials.configured).toContain('Reaction');
    expect(report.partials.missing).toEqual([]);
  });

  /**
   * Without partials a reaction on an uncached message produces **no event at
   * all** — not a partial one. An adopted panel's message is almost always older
   * than the 25-message cache, so this is the difference between a working panel
   * and one that looks dead with nothing in the log.
   */
  it('names a missing partial rather than reporting silence', () => {
    const stripped = new Client({
      intents: [GatewayIntentBits.Guilds],
      partials: [Partials.Message],
    });
    const report = buildDoctorReport(stripped, config());

    expect(report.partials.missing).toContain('Reaction');
    expect(report.ok).toBe(false);
  });
});

describe('privileged intents', () => {
  /**
   * Discord closes the socket with **4014 Disallowed intents** when an IDENTIFY
   * asks for a privileged intent the application has not been granted. So a
   * session that exists, carrying these bits, *is* the runtime grant — that is
   * what makes this an assertion about the connection rather than about the
   * portal.
   */
  it('reports both as requested and granted once a session exists', () => {
    addGuild(GUILD, String(REQUIRED_PERMISSIONS));
    const report = buildDoctorReport(client, config());

    expect(report.intents.privileged).toEqual([
      { name: 'GuildMembers', requested: true },
      { name: 'MessageContent', requested: true },
    ]);
    expect(report.intents.sessionEstablished).toBe(true);
  });

  it('is not satisfied by a client that never asked for them', () => {
    const stripped = new Client({ intents: [GatewayIntentBits.Guilds] });
    const report = buildDoctorReport(stripped, config());

    expect(report.intents.privileged).toContainEqual({ name: 'MessageContent', requested: false });
    expect(report.ok).toBe(false);
  });

  /**
   * A client that has not connected cannot say anything about a grant, and must
   * not imply that it can. This is the difference between "configured" and
   * "granted" that the exercise exists to check.
   */
  it('does not claim a grant before there is a session', () => {
    const fresh = new Client(buildClientOptions(() => BOT));
    const report = buildDoctorReport(fresh, config());

    expect(report.intents.sessionEstablished).toBe(false);
    expect(report.ok).toBe(false);
  });
});

describe('the allowlisted guilds', () => {
  /**
   * **Discord's `position`, not discord.js's.** `Role.position` is a getter that
   * returns the role's index in the sorted cache: with roles at raw 0 and raw 7
   * it answers 1. Everything else in this system uses the raw field — the REST
   * port reads it straight off the API — and an operator comparing this number
   * against a hierarchy refusal has to be reading the same scale.
   */
  it('reports the bot own highest role position on Discord scale', () => {
    const guild = addGuild(GUILD, String(REQUIRED_PERMISSIONS));
    const report = buildDoctorReport(client, config());

    expect(guild.members.me?.roles.highest.position).toBe(1); // the index
    expect(report.guilds[0]).toMatchObject({
      guildId: GUILD,
      present: true,
      botHighestRolePosition: 7,
    });
  });

  /**
   * Configured for a guild it is not in is a silent failure otherwise: every
   * panel in that guild simply never fires, and nothing says why.
   */
  it('names an allowlisted guild the bot is not in', () => {
    addGuild(GUILD, String(REQUIRED_PERMISSIONS));
    const report = buildDoctorReport(client, config({ BANANASAURS_GUILD_ALLOWLIST: ABSENT_GUILD }));

    expect(report.guilds[0]).toMatchObject({ guildId: ABSENT_GUILD, present: false });
    expect(report.guilds[0]?.botHighestRolePosition).toBeUndefined();
    expect(report.ok).toBe(false);
  });
});

describe('permissions — docs/18 layer 1 + Release 2 moderation', () => {
  it('is content with exactly the required set', () => {
    addGuild(GUILD, String(REQUIRED_PERMISSIONS));
    const report = buildDoctorReport(client, config());

    expect(report.guilds[0]?.missingPermissions).toEqual([]);
    expect(report.guilds[0]?.extraPermissions).toEqual([]);
    expect(report.ok).toBe(true);
  });

  it('names a permission the bot needs and does not have', () => {
    // Everything except Manage Roles, which is the one thing it actually does.
    addGuild(GUILD, String(REQUIRED_PERMISSIONS & ~268435456n));
    const report = buildDoctorReport(client, config());

    expect(report.guilds[0]?.missingPermissions).toEqual(['ManageRoles']);
    expect(report.ok).toBe(false);
  });

  /**
   * Extra permissions are the other direction of the same wall. `docs/18`:
   * "never grant Administrator to save time" — and Administrator implies every
   * permission, so a bug in Bananasaurs would no longer be incapable of
   * deleting a message or banning a member.
   */
  it('refuses to call a bot with Administrator healthy', () => {
    addGuild(GUILD, String(REQUIRED_PERMISSIONS | 8n));
    const report = buildDoctorReport(client, config());

    expect(report.guilds[0]?.extraPermissions).toContain('Administrator');
    expect(report.ok).toBe(false);
  });

  /**
   * Release 2's moderation surface (ADR 0037 — /mod ban/unban; the keyword-filter
   * purge path) needs `Ban Members` and `Manage Messages` at the guild level, on
   * top of everything Release 1 already required.
   */
  it('flags a missing Ban Members as a required permission', () => {
    addGuild(GUILD, String(REQUIRED_PERMISSIONS & ~4n)); // ~BanMembers
    const report = buildDoctorReport(client, config());

    expect(report.guilds[0]?.missingPermissions).toEqual(['BanMembers']);
    expect(report.ok).toBe(false);
  });

  it('flags a missing Manage Messages as a required permission', () => {
    addGuild(GUILD, String(REQUIRED_PERMISSIONS & ~8192n)); // ~ManageMessages
    const report = buildDoctorReport(client, config());

    expect(report.guilds[0]?.missingPermissions).toEqual(['ManageMessages']);
    expect(report.ok).toBe(false);
  });

  it('passes with Ban Members and Manage Messages held alongside everything Release 1 needs', () => {
    addGuild(GUILD, String(REQUIRED_PERMISSIONS));
    const report = buildDoctorReport(client, config());

    expect(report.guilds[0]?.missingPermissions).toEqual([]);
    expect(report.ok).toBe(true);
  });

  /**
   * Before this change, `RELEASE_1_PERMISSIONS` was the whole required set, so a
   * guild that had reasonably granted Ban Members/Manage Messages up front (a
   * moderation bot needs them) showed up as over-permissioned. Once they join
   * the required set, that same guild stops being flagged for holding something
   * it should have anyway.
   */
  it('no longer reports Ban Members or Manage Messages as extra now that they are required', () => {
    addGuild(GUILD, String(RELEASE_1_PERMISSIONS | 4n | 8192n)); // + BanMembers + ManageMessages
    const report = buildDoctorReport(client, config());

    expect(report.guilds[0]?.extraPermissions).not.toContain('BanMembers');
    expect(report.guilds[0]?.extraPermissions).not.toContain('ManageMessages');
    expect(report.guilds[0]?.extraPermissions).toEqual([]);
  });

  /**
   * Native AutoMod observability (ADR 0038, Slice 0) requires `ManageGuild`
   * for Discord to dispatch events. The owner granted it 2026-09-01, and it
   * is now inside `REQUIRED_PERMISSIONS`: unlike before, a guild missing it
   * fails `doctor` the same way a guild missing `BanMembers` does, because
   * Slice 0 depends on it and its disappearance would silently kill the
   * feature.
   */
  it('flags a missing Manage Guild as a required permission and fails doctor', () => {
    addGuild(GUILD, String(REQUIRED_PERMISSIONS & ~NATIVE_AUTOMOD_OBSERVABILITY_PERMISSIONS));
    const report = buildDoctorReport(client, config());

    expect(report.guilds[0]?.missingPermissions).toEqual(['ManageGuild']);
    expect(report.guilds[0]?.nativeAutomodObservabilityActive).toBe(false);
    expect(report.ok).toBe(false);
  });

  it('reports native AutoMod observability as active when Manage Guild is held', () => {
    addGuild(GUILD, String(REQUIRED_PERMISSIONS));
    const report = buildDoctorReport(client, config());

    expect(report.guilds[0]?.nativeAutomodObservabilityActive).toBe(true);
    expect(report.guilds[0]?.missingPermissions).toEqual([]);
    expect(report.ok).toBe(true);
  });

  it('does not list ManageGuild as an extra permission now that it is required', () => {
    addGuild(GUILD, String(REQUIRED_PERMISSIONS));
    const report = buildDoctorReport(client, config());

    expect(report.guilds[0]?.extraPermissions).not.toContain('ManageGuild');
    expect(report.guilds[0]?.extraPermissions).toEqual([]);
  });
});

describe('backup health (ADR 0034)', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bnn-doctor-backup-'));
  });

  afterEach(() => {
    fs.chmodSync(dir, 0o755); // undo any readonly test's chmod, or rmSync below fails
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const takeBackup = (destDir: string, now: () => Date = () => new Date()) => {
    const db = openTestDatabase();
    try {
      return performBackup(db.raw, { destDir, now });
    } finally {
      db.close();
    }
  };

  it('is not a doctor failure when the directory does not exist yet', () => {
    addGuild(GUILD, String(REQUIRED_PERMISSIONS));
    const missing = path.join(dir, 'never-created');
    const report = buildDoctorReport(client, config({ BANANASAURS_BACKUP_DIR: missing }));

    expect(report.backup.dirExists).toBe(false);
    expect(report.backup.backupCount).toBe(0);
    expect(report.ok).toBe(true);
  });

  it('is not a doctor failure when the directory exists but holds nothing yet', () => {
    addGuild(GUILD, String(REQUIRED_PERMISSIONS));
    const report = buildDoctorReport(client, config({ BANANASAURS_BACKUP_DIR: dir }));

    expect(report.backup.dirExists).toBe(true);
    expect(report.backup.dirWritable).toBe(true);
    expect(report.backup.backupCount).toBe(0);
    expect(report.ok).toBe(true);
  });

  it('reports the count and age of a fresh backup without failing doctor', () => {
    addGuild(GUILD, String(REQUIRED_PERMISSIONS));
    const takenAt = new Date('2026-08-30T00:00:00.000Z');
    takeBackup(dir, () => takenAt);
    const nowMs = takenAt.getTime() + 5 * 60_000; // 5 minutes later

    const report = buildDoctorReport(client, config({ BANANASAURS_BACKUP_DIR: dir }), nowMs);

    expect(report.backup.backupCount).toBe(1);
    expect(report.backup.newestAgeMs).toBe(5 * 60_000);
    expect(report.backup.stale).toBe(false);
    expect(report.ok).toBe(true);
  });

  it('reports the age of the newest backup, not the oldest, when several exist', () => {
    addGuild(GUILD, String(REQUIRED_PERMISSIONS));
    const older = new Date('2026-08-30T00:00:00.000Z');
    const newer = new Date('2026-08-30T01:00:00.000Z');
    takeBackup(dir, () => older);
    takeBackup(dir, () => newer);
    const nowMs = newer.getTime() + 5 * 60_000;

    const report = buildDoctorReport(client, config({ BANANASAURS_BACKUP_DIR: dir }), nowMs);

    expect(report.backup.backupCount).toBe(2);
    // If this read the oldest instead, the age would be 65 minutes, not 5.
    expect(report.backup.newestAgeMs).toBe(5 * 60_000);
  });

  it('fails doctor when the newest backup is older than twice the configured interval', () => {
    addGuild(GUILD, String(REQUIRED_PERMISSIONS));
    const takenAt = new Date('2026-08-30T00:00:00.000Z');
    takeBackup(dir, () => takenAt);
    // Interval 60 min, threshold 120 min; the backup is 121 minutes old.
    const nowMs = takenAt.getTime() + 121 * 60_000;

    const report = buildDoctorReport(
      client,
      config({ BANANASAURS_BACKUP_DIR: dir, BANANASAURS_BACKUP_INTERVAL_MIN: '60' }),
      nowMs,
    );

    expect(report.backup.stale).toBe(true);
    expect(report.ok).toBe(false);
  });

  it('does not call a backup stale at exactly twice the interval', () => {
    addGuild(GUILD, String(REQUIRED_PERMISSIONS));
    const takenAt = new Date('2026-08-30T00:00:00.000Z');
    takeBackup(dir, () => takenAt);
    const nowMs = takenAt.getTime() + 120 * 60_000; // exactly the threshold

    const report = buildDoctorReport(
      client,
      config({ BANANASAURS_BACKUP_DIR: dir, BANANASAURS_BACKUP_INTERVAL_MIN: '60' }),
      nowMs,
    );

    expect(report.backup.stale).toBe(false);
    expect(report.ok).toBe(true);
  });

  it('fails doctor when the directory exists but this process cannot write to it', () => {
    addGuild(GUILD, String(REQUIRED_PERMISSIONS));
    fs.chmodSync(dir, 0o555); // read + execute, no write

    const report = buildDoctorReport(client, config({ BANANASAURS_BACKUP_DIR: dir }));

    expect(report.backup.dirExists).toBe(true);
    expect(report.backup.dirWritable).toBe(false);
    expect(report.ok).toBe(false);
  });

  it('renders a stale backup as a named finding in the printed report', () => {
    addGuild(GUILD, String(REQUIRED_PERMISSIONS));
    const takenAt = new Date('2026-08-30T00:00:00.000Z');
    takeBackup(dir, () => takenAt);
    const nowMs = takenAt.getTime() + 121 * 60_000;

    const text = formatDoctorReport(
      buildDoctorReport(
        client,
        config({ BANANASAURS_BACKUP_DIR: dir, BANANASAURS_BACKUP_INTERVAL_MIN: '60' }),
        nowMs,
      ),
    );

    expect(text).toMatch(/STALE/);
    expect(text).toContain('doctor: PROBLEMS FOUND');
  });
});

describe('archive guilds (ADR 0046 D1)', () => {
  it('fails doctor when an archive guild is not in the allowlist', () => {
    addGuild(GUILD, String(REQUIRED_PERMISSIONS));
    const report = buildDoctorReport(client, config({ BANANASAURS_ARCHIVE_GUILDS: ABSENT_GUILD }));

    expect(report.archiveGuildsNotAllowlisted).toEqual([ABSENT_GUILD]);
    expect(report.ok).toBe(false);
    expect(formatDoctorReport(report)).toContain(
      `  ARCHIVE GUILD NOT ALLOWLISTED: ${ABSENT_GUILD}`,
    );
  });

  it('stays clean when every archive guild is allowlisted', () => {
    addGuild(GUILD, String(REQUIRED_PERMISSIONS));
    const report = buildDoctorReport(client, config({ BANANASAURS_ARCHIVE_GUILDS: GUILD }));

    expect(report.archiveGuildsNotAllowlisted).toEqual([]);
    expect(report.ok).toBe(true);
    expect(formatDoctorReport(report)).not.toContain('ARCHIVE GUILD NOT ALLOWLISTED');
  });
});

describe('the printed report', () => {
  it('is legible and carries no secret', () => {
    addGuild(GUILD, String(REQUIRED_PERMISSIONS));
    const text = formatDoctorReport(buildDoctorReport(client, config()));

    expect(text).toContain('partials');
    expect(text).toContain('MessageContent');
    expect(text).toContain(GUILD);
    // Rule 4. The token is in the config this report was built from.
    expect(text).not.toContain('NOT.A.REALTOKEN');
    expect(text).not.toContain('REALTOKEN');
  });

  it('reports native AutoMod observability as inactive with a clear message, and fails doctor', () => {
    addGuild(GUILD, String(REQUIRED_PERMISSIONS & ~NATIVE_AUTOMOD_OBSERVABILITY_PERMISSIONS));
    const text = formatDoctorReport(buildDoctorReport(client, config()));

    expect(text).toContain('native AutoMod observability inactive');
    expect(text).toContain('Manage Server not held');
    expect(text).toContain('ADR 0038');
    expect(text).toContain('MISSING PERMISSIONS: ManageGuild');
    expect(text).toContain('doctor: PROBLEMS FOUND');
  });

  it('does not mention native AutoMod observability when it is active', () => {
    addGuild(GUILD, String(REQUIRED_PERMISSIONS));
    const text = formatDoctorReport(buildDoctorReport(client, config()));

    expect(text).not.toContain('native AutoMod observability');
  });
});
