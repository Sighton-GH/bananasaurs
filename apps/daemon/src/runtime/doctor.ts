import fs from 'node:fs';
import path from 'node:path';
import {
  GatewayIntentBits,
  PermissionsBitField,
  Partials,
  type Client,
  type Guild,
} from 'discord.js';
import { REQUIRED_PARTIALS } from '@bananasaurs/discord';
import {
  humaniseDuration,
  taskPostsOffText,
  type Config,
  type TaskPostsOffReason,
} from '@bananasaurs/core';
import { listBackups } from '@bananasaurs/storage';

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
 * Release 2's moderation surface (ADR 0037 — `/mod ban`, `/mod unban`; the
 * keyword-filter purge path) reaches Discord actions layer 1 never granted:
 * banning a member and deleting other members' messages. Named separately
 * from `RELEASE_1_PERMISSIONS` rather than folded into it so the release that
 * introduced each permission stays visible at the point it is required.
 */
export const RELEASE_2_MODERATION_PERMISSIONS =
  PermissionsBitField.Flags.BanMembers | PermissionsBitField.Flags.ManageMessages;

/**
 * Native AutoMod observability (ADR 0038, Slice 0) requires `ManageGuild` —
 * Discord dispatches `AUTO_MODERATION_ACTION_EXECUTION` only to a bot that
 * holds it. The owner granted it 2026-09-01, having weighed that
 * `ManageGuild` also unlocks Discord's AutoMod REST endpoints, guild
 * settings, integrations, and invites; Bananasaurs uses none of that, and
 * ADR 0038 leaves managing native rules out of scope (see `docs/18`). Named
 * separately from `RELEASE_2_MODERATION_PERMISSIONS` for the same reason
 * that one is named separately: the decision that introduced a permission
 * should stay visible at the point it is required. Now that it is granted
 * and Slice 0 depends on it, its disappearance is a genuine `doctor` failure
 * rather than a note — losing it would silently kill the feature.
 */
export const NATIVE_AUTOMOD_OBSERVABILITY_PERMISSIONS = PermissionsBitField.Flags.ManageGuild;

/**
 * Everything doctor requires the bot's guild role to hold, across both
 * releases plus Slice 0 of Release 2. `RELEASE_1_PERMISSIONS` stays exported
 * and unchanged — this is the union `inspectGuild` actually checks against.
 */
export const REQUIRED_PERMISSIONS =
  RELEASE_1_PERMISSIONS |
  RELEASE_2_MODERATION_PERMISSIONS |
  NATIVE_AUTOMOD_OBSERVABILITY_PERMISSIONS;

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
  /**
   * Whether the bot holds `ManageGuild`, i.e. whether Discord is actually
   * dispatching `AUTO_MODERATION_ACTION_EXECUTION` right now (ADR 0038,
   * Slice 0). `ManageGuild` is inside `REQUIRED_PERMISSIONS`, so its absence
   * already shows up in `missingPermissions` and fails `ok` on its own; this
   * field exists so the report can explain what that specific missing
   * permission breaks, not to carry a second, more lenient verdict.
   */
  readonly nativeAutomodObservabilityActive: boolean;
}

/**
 * The backup timer's health (ADR 0034, WP6 slice 16e), read from the
 * filesystem alone — no database handle, so this does not disturb `doctor`'s
 * existing "does not open the database" property, which is what lets it run
 * safely against a live daemon's files.
 */
export interface DoctorBackupHealth {
  /** False only if the directory could not even be checked (e.g. ENOTDIR on a parent). */
  readonly dirExists: boolean;
  /** False if the directory exists but this process cannot write to it. */
  readonly dirWritable: boolean;
  readonly backupCount: number;
  /** `undefined` when there are no backups yet. */
  readonly newestAgeMs: number | undefined;
  /**
   * The newest backup is older than twice the configured interval — the timer
   * that should be producing one has gone silent. A fresh install with zero
   * backups is not this; a directory that used to fill and stopped is.
   */
  readonly stale: boolean;
}

const checkBackupHealth = (config: Config, nowMs: number): DoctorBackupHealth => {
  const dir = path.resolve(config.BANANASAURS_BACKUP_DIR);

  let dirExists = false;
  let dirWritable = false;
  try {
    fs.accessSync(dir, fs.constants.F_OK);
    dirExists = true;
    fs.accessSync(dir, fs.constants.W_OK);
    dirWritable = true;
  } catch {
    // Left at whichever of the two checks above actually succeeded.
  }

  const backups = dirExists ? listBackups(dir) : [];
  const newest = backups.at(-1);
  const newestAgeMs = newest === undefined ? undefined : nowMs - newest.createdAt.getTime();
  const staleThresholdMs = config.BANANASAURS_BACKUP_INTERVAL_MIN * 60_000 * 2;

  return {
    dirExists,
    dirWritable,
    backupCount: backups.length,
    newestAgeMs,
    stale: newestAgeMs !== undefined && newestAgeMs > staleThresholdMs,
  };
};

/**
 * Whether anyone can sign in to the dashboard at all (slice 13, S13-D5).
 *
 * Two findings in one struct: an allowlisted guild no enabled account can
 * reach (gap 1's symptom, which nothing reported until this slice), and the
 * no-accounts bootstrap state (a live token means setup is pending, not
 * broken; no live token means nobody can get in without a restart).
 * `liveBootstrapTokens` is only meaningful when there are no accounts at
 * all — once an account exists, sign-in no longer depends on a token.
 */
export interface DoctorDashboardAccess {
  readonly enabledAccounts: number;
  /** Allowlisted guilds no enabled account can reach (gap 1). */
  readonly unreachableGuilds: readonly string[];
  /** Only meaningful when there are no accounts at all. */
  readonly liveBootstrapTokens: number;
}

/**
 * The S13-D5 verdict over one `DoctorDashboardAccess`.
 *
 * Four rows: accounts everywhere means ok; an unreachable guild fails; zero
 * accounts with a live token is setup pending and stays ok (a `doctor` that
 * shouts at a correct fresh instance teaches the operator to ignore it);
 * zero accounts with no live token fails. With zero accounts the guild list
 * is meaningless — every guild is trivially unreachable — so the token count
 * alone decides.
 */
export const dashboardAccessOk = (access: DoctorDashboardAccess): boolean => {
  if (access.enabledAccounts === 0) return access.liveBootstrapTokens > 0;
  return access.unreachableGuilds.length === 0;
};

/**
 * The account password vault's state (ADR 0070), for the one-line doctor
 * finding. `revealableAccounts` needs the account table the same way
 * `dashboardAccess` does, so it is computed by the caller and passed in —
 * never a failure on its own (an unset `ACCOUNT_PASSWORD_SECRET_KEY` is an
 * expected state, not a broken one), just a line an operator can act on.
 */
export interface DoctorPasswordVault {
  readonly available: boolean;
  /**
   * Where the sealing key resolved from (`resolveSecretFile`'s answer, via
   * the vault). Optional: callers that predate the field omit it and the
   * report keeps today's file wording, so existing consumers stay green.
   */
  readonly source?: 'env' | 'file' | 'missing' | undefined;
  /** Non-owner accounts with a sealed copy the owner can reveal. Never the values. */
  readonly revealableAccounts: number;
}

/**
 * Per-allowlisted-guild persistent model failures (ADR 0129 §8), last 24 h.
 *
 * Advisory only (CLAUDE.md rule 1): a persistent entry never disables,
 * reorders or skips a chain entry — it only votes `ok` and prints a line
 * telling the operator where to act. Computed by the caller over the run
 * ledger, like `dashboardAccess`, so this report never opens the database
 * itself.
 */
export interface DoctorModelHealth {
  /** Per allowlisted guild: its persistent failures (ModelHealth with `persistent` set), last 24 h. */
  readonly guilds: readonly {
    readonly guildId: string;
    readonly persistent: readonly {
      readonly model: string;
      readonly keyId: string;
      readonly keyLabel?: string;
      readonly code: string;
      readonly count: number;
      readonly since: number;
    }[];
  }[];
}

/** True when no guild carries a persistent entry; absent input means not assessed, never a failure. */
export const modelHealthOk = (modelHealth: DoctorModelHealth | undefined): boolean =>
  modelHealth === undefined || modelHealth.guilds.every((g) => g.persistent.length === 0);

/** Task posts are off while guilds hold open tasks: a finding, not a failure. */
export interface DoctorTaskPostsOff {
  readonly offReason: TaskPostsOffReason;
  readonly guildsWithOpenTasks: number;
}

/** ADR 0143: caller-supplied, secret-free diagnostics; no database is opened here. */
export interface DoctorProviderAdvisories {
  readonly keys: readonly {
    readonly keyId: string;
    readonly provider: string;
    readonly label: string;
    readonly costClass: 'free' | 'paid' | 'unknown';
    readonly enabled: boolean;
  }[];
  readonly chain: readonly {
    readonly keyId: string;
    readonly providerId: string;
    readonly model: string;
    readonly pool?: 'key' | 'provider';
  }[];
  readonly getCooldown: (
    keyId: string,
    model: string,
    now: number,
  ) => { readonly until: number } | undefined;
}

const providerWarnings = (input: DoctorProviderAdvisories | undefined, now: number): string[] => {
  if (input === undefined) return [];
  const warnings = input.keys
    .filter((key) => key.provider === 'gemini' && key.costClass === 'free')
    .map(
      (key) => `AI key ${key.label} may train on submitted input - recorded terms, still usable`,
    );
  for (const entry of input.chain) {
    const keys = input.keys.filter(
      (key) =>
        key.enabled &&
        (entry.pool === 'provider' ? key.provider === entry.providerId : key.keyId === entry.keyId),
    );
    const cooldowns = keys.map((key) => input.getCooldown(key.keyId, entry.model, now));
    if (
      keys.length === 0 ||
      !cooldowns.every((cooldown) => cooldown !== undefined && cooldown.until > now)
    )
      continue;
    // A pool becomes usable as soon as its first key recovers. Daily Gemini
    // cooldowns all point to Pacific midnight; minute cooldowns can recover sooner.
    const until = Math.min(...cooldowns.map((cooldown) => cooldown?.until ?? Infinity));
    const pacific = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'America/Los_Angeles',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    }).format(until);
    warnings.push(`AI model ${entry.model} pool cooling until ${pacific} Pacific`);
  }
  return warnings;
};

export interface DoctorReport {
  /** False if anything here would stop the bot working, or widen layer 1. */
  readonly ok: boolean;
  /** Advisory only: training terms and cooling pools never vote on ok. */
  readonly warnings: readonly string[];
  /**
   * The dashboard-access finding (S13-D5), when the caller assessed it.
   *
   * Optional, deliberately: the account reads need a database this report
   * must never open — `index.ts` runs it against a live daemon — so the
   * caller computes the struct over the account tables and passes it in, and
   * call sites that cannot (startup, doctor mode) omit it. Absent means not
   * assessed, never a failure: it contributes no line and no `ok` vote.
   */
  readonly dashboardAccess?: DoctorDashboardAccess | undefined;
  /** The password vault finding (ADR 0070), when the caller assessed it. Same omission rule as `dashboardAccess`. */
  readonly passwordVault?: DoctorPasswordVault | undefined;
  /** Present only when posts are off and some guild has an open task. Does not vote on `ok`. */
  readonly taskPostsOff?: DoctorTaskPostsOff | undefined;
  /**
   * The model-health finding (ADR 0129 §8), when the caller assessed it.
   * Same omission rule as `dashboardAccess`: absent means not assessed.
   */
  readonly modelHealth?: DoctorModelHealth | undefined;
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
  readonly backup: DoctorBackupHealth;
  /**
   * Guilds in `BANANASAURS_ARCHIVE_GUILDS` that are not in
   * `BANANASAURS_GUILD_ALLOWLIST` (ADR 0046 D1) — almost certainly a typo,
   * since an archive guild the bot never joins archives nothing.
   */
  readonly archiveGuildsNotAllowlisted: readonly string[];
}

export function buildDoctorReport(
  client: Client,
  config: Config,
  nowMs: number = Date.now(),
  /**
   * The dashboard-access finding's input (S13-D5), computed by the caller
   * over the account tables — this report never opens the database itself.
   * Omitted by call sites with no database handle (startup, doctor mode);
   * see `dashboardAccess` above for what omission means.
   */
  dashboardAccess?: DoctorDashboardAccess,
  /** The password vault finding's input (ADR 0070), same omission rule as `dashboardAccess`. */
  passwordVault?: DoctorPasswordVault,
  /** Guilds with an open task whose posts are off, counted by the caller that has a database handle; omitted means not assessed. */
  openTaskGuildsWithPostsOff?: number,
  /**
   * The model-health finding's input (ADR 0129 §8), computed by the caller
   * over the run ledger — this report never opens the database itself.
   * Omitted by call sites with no database handle (startup, doctor mode);
   * see `modelHealth` above for what omission means.
   */
  modelHealth?: DoctorModelHealth,
  /** ADR 0143: omitted when the caller has no provider diagnostics. */
  providerAdvisories?: DoctorProviderAdvisories,
): DoctorReport {
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

  const allowlisted = new Set(config.BANANASAURS_GUILD_ALLOWLIST);
  const archiveGuildsNotAllowlisted = config.BANANASAURS_ARCHIVE_GUILDS.filter(
    (guildId) => !allowlisted.has(guildId),
  );

  const backup = checkBackupHealth(config, nowMs);
  // A missing directory is not yet a finding — the timer creates it on the
  // daemon's first backup, so a never-started instance legitimately has none.
  // Existing-but-unwritable and stale are both signs something that used to
  // work has stopped.
  const backupOk = !(backup.dirExists && !backup.dirWritable) && !backup.stale;

  // S13-D5: both dashboard-access findings count toward `ok` — but only
  // when assessed. An omitted input is a call site with no database, not a
  // state with no accounts, so it votes nothing rather than failing every
  // startup and every doctor-mode run.
  const dashboardOk = dashboardAccess === undefined || dashboardAccessOk(dashboardAccess);

  // ADR 0129 §8: a persistent model failure fails the report — but only
  // when assessed. An omitted input is a call site with no database, not a
  // healthy fleet, so it votes nothing rather than failing every startup
  // and every doctor-mode run.
  const modelHealthVote = modelHealthOk(modelHealth);

  const ok =
    missing.length === 0 &&
    privileged.every((p) => p.requested) &&
    sessionEstablished &&
    guilds.every(
      (g) => g.present && g.missingPermissions.length === 0 && g.forbiddenPermissions.length === 0,
    ) &&
    backupOk &&
    archiveGuildsNotAllowlisted.length === 0 &&
    dashboardOk &&
    modelHealthVote;

  // ADR 0131: the caller counts guilds that have an open task while posts are
  // off for them (switch off, or dry run); this only picks the wording.
  const taskPostsOff: DoctorTaskPostsOff | undefined =
    openTaskGuildsWithPostsOff !== undefined && openTaskGuildsWithPostsOff > 0
      ? {
          offReason: config.BANANASAURS_DRY_RUN ? 'dry-run' : 'switch',
          guildsWithOpenTasks: openTaskGuildsWithPostsOff,
        }
      : undefined;

  return {
    ok,
    warnings: providerWarnings(providerAdvisories, nowMs),
    partials: { configured, missing },
    intents: { privileged, sessionEstablished },
    guilds,
    backup,
    archiveGuildsNotAllowlisted,
    // Conditional spread, not `dashboardAccess: undefined` directly:
    // `exactOptionalPropertyTypes` treats an explicit `undefined` as distinct
    // from the property being absent, and "not assessed" is absence.
    ...(dashboardAccess !== undefined && { dashboardAccess }),
    ...(passwordVault !== undefined && { passwordVault }),
    ...(taskPostsOff !== undefined && { taskPostsOff }),
    ...(modelHealth !== undefined && { modelHealth }),
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
      nativeAutomodObservabilityActive: false,
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
    missingPermissions: namesOf(REQUIRED_PERMISSIONS & ~held),
    // Everything held that the required set does not name — the other direction
    // of the same wall, and the one nobody notices without being told.
    // (ManageGuild used to need an explicit carve-out here, back when it was
    // tracked but not required; now it lives inside REQUIRED_PERMISSIONS, so
    // ~REQUIRED_PERMISSIONS already excludes it and no extra exclusion is needed.)
    extraPermissions: namesOf(held & ~REQUIRED_PERMISSIONS),
    forbiddenPermissions: namesOf(held & FORBIDDEN_PERMISSIONS),
    nativeAutomodObservabilityActive: (held & NATIVE_AUTOMOD_OBSERVABILITY_PERMISSIONS) !== 0n,
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
        `    extra permissions beyond the required set: ${guild.extraPermissions.join(', ')}`,
      );
    }
    if (!guild.nativeAutomodObservabilityActive) {
      lines.push(
        `    native AutoMod observability inactive: Manage Server not held, so AUTO_MODERATION_ACTION_EXECUTION is never dispatched (ADR 0038) — see MISSING PERMISSIONS above`,
      );
    }
  }

  if (report.archiveGuildsNotAllowlisted.length > 0) {
    lines.push('');
    for (const guildId of report.archiveGuildsNotAllowlisted) {
      lines.push(`  ARCHIVE GUILD NOT ALLOWLISTED: ${guildId}`);
    }
  }

  lines.push('');
  const b = report.backup;
  if (!b.dirExists) {
    lines.push('  backups: none yet (the timer creates the directory on the first run)');
  } else if (!b.dirWritable) {
    lines.push('  BACKUP DIRECTORY NOT WRITABLE — the backup timer cannot write there');
  } else if (b.backupCount === 0) {
    lines.push('  backups: directory exists but is empty — none taken yet');
  } else {
    const age = b.newestAgeMs === undefined ? '?' : humaniseDuration(b.newestAgeMs);
    lines.push(
      `  backups: ${String(b.backupCount)}, newest ${age} old` +
        (b.stale ? '  STALE — the backup timer appears to have stopped' : ''),
    );
  }

  // ADR 0129 §8. Advisory only — never the provider message (hard rule 4
  // keeps it out of operator output), only where to fix the chain entry.
  // Absent input means not assessed and prints nothing.
  if (report.modelHealth !== undefined) {
    lines.push('');
    const entries = report.modelHealth.guilds.flatMap((g) => g.persistent);
    if (entries.length === 0) {
      lines.push('  AI model health: ok (last 24 h)');
    } else {
      for (const guild of report.modelHealth.guilds) {
        for (const entry of guild.persistent) {
          lines.push(
            `  AI model ${entry.model} (key ${entry.keyLabel ?? entry.keyId}) failed ${String(entry.count)} times in a row with ${entry.code} since ${new Date(entry.since).toISOString()}; remove or replace it in Providers → Model order.`,
          );
        }
      }
    }
  }

  for (const warning of report.warnings) lines.push(`  WARNING: ${warning}`);

  // ADR 0070. Never the key itself — only where it resolved from, and a count.
  // The mode is checked at resolution, not re-stat'ed here: `file` means the
  // 0600 key file, `env` means `ACCOUNT_PASSWORD_SECRET_KEY` won, and
  // `missing` (or an unavailable vault that predates the field) is not set up.
  if (report.passwordVault !== undefined) {
    const vault = report.passwordVault;
    const source = vault.source ?? (vault.available ? 'file' : 'missing');
    lines.push('');
    if (!vault.available || source === 'missing') {
      lines.push('  Account password vault: not set up (reveal unavailable)');
    } else if (source === 'env') {
      lines.push(
        `  Account password vault: key from ACCOUNT_PASSWORD_SECRET_KEY, ${String(vault.revealableAccounts)} accounts revealable`,
      );
    } else {
      lines.push(
        `  Account password vault: key file present, mode 0600, ${String(vault.revealableAccounts)} accounts revealable`,
      );
    }
  }

  if (report.taskPostsOff !== undefined) {
    lines.push('');
    lines.push(
      `  TASK POSTS OFF (${String(report.taskPostsOff.guildsWithOpenTasks)} guild(s) have open tasks): ` +
        taskPostsOffText(report.taskPostsOff.offReason),
    );
  }

  return lines.join('\n');
}
