import {
  GatewayIntentBits,
  PermissionsBitField,
  Partials,
  type Client,
  type Guild,
} from 'discord.js';
import { REQUIRED_PARTIALS } from '@bananasaurs/discord';
import type { Config } from '@bananasaurs/core';

/**
 * `doctor` v1 — `docs/21` exercise 1 step 3.
 *
 * "It must report: partials configured, both privileged intents granted **at
 * runtime**, the bot's own highest role position, and which of the allowlisted
 * guilds it is actually in."
 *
 * *At runtime* is the load-bearing phrase. `docs/STATE.md` records both
 * privileged intents as enabled in the Developer Portal and `docs/19` §62 takes
 * that at its word while insisting the grant be asserted anyway — configuration
 * and grant are different facts, and only one of them stops the bot working.
 *
 * The assertion is the session itself. Discord closes the socket with **4014
 * Disallowed intents** when an IDENTIFY asks for a privileged intent the
 * application has not been granted, so a live session carrying these bits *is*
 * the grant. That is why this report refuses to say anything about intents
 * before the client is ready: a client that has not connected has not been told
 * anything, and reporting "configured" as though it meant "granted" is the exact
 * confusion the exercise exists to catch.
 */

/** `docs/18` layer 1, the whole list. Total 2416004288. */
export const RELEASE_1_PERMISSIONS =
  PermissionsBitField.Flags.ViewChannel |
  PermissionsBitField.Flags.ReadMessageHistory |
  PermissionsBitField.Flags.AddReactions |
  PermissionsBitField.Flags.ManageRoles |
  PermissionsBitField.Flags.SendMessages |
  PermissionsBitField.Flags.EmbedLinks |
  PermissionsBitField.Flags.UseApplicationCommands |
  PermissionsBitField.Flags.ViewAuditLog;

/**
 * Extra permissions that are a finding rather than a note.
 *
 * Administrator implies every permission, which dissolves layer 1 entirely: a
 * runaway Bananasaurs would no longer be *incapable* of deleting a message or
 * banning a member, only unwilling. `docs/18` says never to grant it, so holding
 * it fails the check rather than being listed alongside the others.
 */
const FORBIDDEN_PERMISSIONS = PermissionsBitField.Flags.Administrator;

const PRIVILEGED = [
  { name: 'GuildMembers', bit: GatewayIntentBits.GuildMembers },
  { name: 'MessageContent', bit: GatewayIntentBits.MessageContent },
] as const;

export interface DoctorGuild {
  readonly guildId: string;
  readonly present: boolean;
  readonly name: string | undefined;
  /** From GUILD_CREATE, so it is the guild's real size rather than the cache's. */
  readonly memberCount: number | undefined;
  /**
   * Members actually cached.
   *
   * Corroboration for `GuildMembers`, not proof: `GUILD_CREATE` delivers the
   * member list only when that intent is granted, so more than the bot alone
   * means it arrived. Fewer can mean a large guild or our own cache limit, which
   * is why the intent check does not rest on it.
   */
  readonly cachedMembers: number | undefined;
  readonly botHighestRolePosition: number | undefined;
  readonly missingPermissions: readonly string[];
  readonly extraPermissions: readonly string[];
  /** The subset of `extraPermissions` that dissolves layer 1 rather than widening it. */
  readonly forbiddenPermissions: readonly string[];
}

export interface DoctorReport {
  /** False if anything here would stop the bot working, or widen layer 1. */
  readonly ok: boolean;
  readonly partials: {
    readonly configured: readonly string[];
    readonly missing: readonly string[];
  };
  readonly intents: {
    readonly privileged: readonly { readonly name: string; readonly requested: boolean }[];
    /** A live gateway session, which is what makes a grant observable. */
    readonly sessionEstablished: boolean;
  };
  readonly guilds: readonly DoctorGuild[];
}

export function buildDoctorReport(client: Client, config: Config): DoctorReport {
  const configured = (client.options.partials ?? []).map(partialName);
  const missing = REQUIRED_PARTIALS.map(partialName).filter((p) => !configured.includes(p));

  const requested = client.options.intents;
  const privileged = PRIVILEGED.map((intent) => ({
    name: intent.name,
    requested: requested.has(intent.bit),
  }));
  const sessionEstablished = client.isReady();

  const guilds = config.BANANASAURS_GUILD_ALLOWLIST.map((guildId) =>
    inspectGuild(client.guilds.cache.get(guildId), guildId),
  );

  const ok =
    missing.length === 0 &&
    privileged.every((p) => p.requested) &&
    sessionEstablished &&
    guilds.every(
      (g) => g.present && g.missingPermissions.length === 0 && g.forbiddenPermissions.length === 0,
    );

  return {
    ok,
    partials: { configured, missing },
    intents: { privileged, sessionEstablished },
    guilds,
  };
}

function inspectGuild(guild: Guild | undefined, guildId: string): DoctorGuild {
  if (guild === undefined) {
    return {
      guildId,
      present: false,
      name: undefined,
      memberCount: undefined,
      cachedMembers: undefined,
      botHighestRolePosition: undefined,
      missingPermissions: [],
      extraPermissions: [],
      forbiddenPermissions: [],
    };
  }

  const me = guild.members.me;
  const held = me?.permissions.bitfield ?? 0n;

  return {
    guildId,
    present: true,
    name: guild.name,
    memberCount: guild.memberCount,
    cachedMembers: guild.members.cache.size,
    // `rawPosition`, deliberately. discord.js's `Role.position` is the role's
    // *index* in the sorted cache, not Discord's `position` field — with two
    // roles at raw 0 and raw 7 it reports 1. Every position elsewhere in this
    // system is the raw one (the REST port reads it straight off the API), and
    // an operator comparing this number against a hierarchy refusal has to see
    // the same scale.
    botHighestRolePosition: me?.roles.highest.rawPosition,
    missingPermissions: namesOf(RELEASE_1_PERMISSIONS & ~held),
    // Everything held that the Release 1 set does not name — the other direction
    // of the same wall, and the one nobody notices without being told.
    extraPermissions: namesOf(held & ~RELEASE_1_PERMISSIONS),
    forbiddenPermissions: namesOf(held & FORBIDDEN_PERMISSIONS),
  };
}

const namesOf = (bits: bigint): string[] =>
  bits === 0n ? [] : new PermissionsBitField(bits).toArray().sort();

const partialName = (partial: Partials): string => Partials[partial] ?? String(partial);

/** The operator-facing rendering. Plain text, and never a secret. */
export function formatDoctorReport(report: DoctorReport): string {
  const lines: string[] = [];
  lines.push(`doctor: ${report.ok ? 'ok' : 'PROBLEMS FOUND'}`, '');

  lines.push(`  partials configured: ${report.partials.configured.join(', ') || '(none)'}`);
  if (report.partials.missing.length > 0) {
    lines.push(`  MISSING PARTIALS: ${report.partials.missing.join(', ')}`);
    lines.push('    Without these, a reaction on an uncached message produces no event at all.');
  }

  lines.push('');
  lines.push(
    report.intents.sessionEstablished
      ? '  gateway session: established — Discord accepted the IDENTIFY'
      : '  gateway session: NOT ESTABLISHED — nothing below is a statement about a grant',
  );
  for (const intent of report.intents.privileged) {
    const state = !intent.requested
      ? 'NOT REQUESTED — enable it in the client options'
      : report.intents.sessionEstablished
        ? 'granted (a disallowed intent closes the socket with 4014)'
        : 'requested, grant unverified';
    lines.push(`  privileged intent ${intent.name}: ${state}`);
  }

  for (const guild of report.guilds) {
    lines.push('');
    if (!guild.present) {
      lines.push(`  guild ${guild.guildId}: NOT PRESENT — allowlisted but the bot is not in it`);
      continue;
    }
    lines.push(`  guild ${guild.guildId} (${guild.name ?? 'unnamed'}):`);
    lines.push(`    members: ${guild.memberCount ?? '?'} (${guild.cachedMembers ?? 0} cached)`);
    lines.push(
      `    bot highest role position: ${guild.botHighestRolePosition ?? '?'}` +
        ' — a role at or above this cannot be assigned',
    );
    if (guild.missingPermissions.length > 0) {
      lines.push(`    MISSING PERMISSIONS: ${guild.missingPermissions.join(', ')}`);
    }
    if (guild.forbiddenPermissions.length > 0) {
      lines.push(`    FORBIDDEN PERMISSIONS: ${guild.forbiddenPermissions.join(', ')}`);
      lines.push('    docs/18 layer 1 is the only limit a bug cannot defeat. Remove these.');
    }
    if (guild.extraPermissions.length > 0) {
      lines.push(
        `    extra permissions beyond the Release 1 set: ${guild.extraPermissions.join(', ')}`,
      );
    }
  }

  return lines.join('\n');
}
