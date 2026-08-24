import { beforeEach, describe, expect, it } from 'vitest';
import { Client, GatewayIntentBits, Partials, Status, type Guild } from 'discord.js';
import { parseConfig, type Config } from '@bananasaurs/core';
import { buildClientOptions } from '@bananasaurs/discord';
import { buildDoctorReport, formatDoctorReport, RELEASE_1_PERMISSIONS } from './doctor.js';

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
    addGuild(GUILD, String(RELEASE_1_PERMISSIONS));
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
    addGuild(GUILD, String(RELEASE_1_PERMISSIONS));
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
    const guild = addGuild(GUILD, String(RELEASE_1_PERMISSIONS));
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
    addGuild(GUILD, String(RELEASE_1_PERMISSIONS));
    const report = buildDoctorReport(client, config({ BANANASAURS_GUILD_ALLOWLIST: ABSENT_GUILD }));

    expect(report.guilds[0]).toMatchObject({ guildId: ABSENT_GUILD, present: false });
    expect(report.guilds[0]?.botHighestRolePosition).toBeUndefined();
    expect(report.ok).toBe(false);
  });
});

describe('permissions — docs/18 layer 1', () => {
  it('is content with exactly the Release 1 set', () => {
    addGuild(GUILD, String(RELEASE_1_PERMISSIONS));
    const report = buildDoctorReport(client, config());

    expect(report.guilds[0]?.missingPermissions).toEqual([]);
    expect(report.guilds[0]?.extraPermissions).toEqual([]);
    expect(report.ok).toBe(true);
  });

  it('names a permission the bot needs and does not have', () => {
    // Everything except Manage Roles, which is the one thing it actually does.
    addGuild(GUILD, String(RELEASE_1_PERMISSIONS & ~268435456n));
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
    addGuild(GUILD, String(RELEASE_1_PERMISSIONS | 8n));
    const report = buildDoctorReport(client, config());

    expect(report.guilds[0]?.extraPermissions).toContain('Administrator');
    expect(report.ok).toBe(false);
  });

  /**
   * Manage Messages is deliberately absent (`docs/18`, amendment 2026-08-22:
   * `single_choice` was restricted to managed panels rather than granting it).
   * Holding it is not fatal, but it is a change to the wall and it gets said.
   */
  it('reports Manage Messages as extra without failing the check', () => {
    addGuild(GUILD, String(RELEASE_1_PERMISSIONS | 8192n));
    const report = buildDoctorReport(client, config());

    expect(report.guilds[0]?.extraPermissions).toEqual(['ManageMessages']);
    expect(report.ok).toBe(true);
  });
});

describe('the printed report', () => {
  it('is legible and carries no secret', () => {
    addGuild(GUILD, String(RELEASE_1_PERMISSIONS));
    const text = formatDoctorReport(buildDoctorReport(client, config()));

    expect(text).toContain('partials');
    expect(text).toContain('MessageContent');
    expect(text).toContain(GUILD);
    // Rule 4. The token is in the config this report was built from.
    expect(text).not.toContain('NOT.A.REALTOKEN');
    expect(text).not.toContain('REALTOKEN');
  });
});
