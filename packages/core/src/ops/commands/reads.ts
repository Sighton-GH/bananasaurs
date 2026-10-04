import { z } from 'zod';
import { defineCommand, type OpsCommandResult, type OpsContext } from '../dispatch.js';
import { findSetting, OPS_SETTINGS } from '../settings.js';
import { humaniseDuration } from './status.js';
import { currentValue } from './writes.js';

/**
 * The S13-D5 verdict, mirrored from `dashboardAccessOk` in
 * `apps/daemon/src/runtime/doctor.ts`.
 *
 * Restated here rather than shared because this package may not import from
 * `apps/daemon` (ADR 0014) — the same reason `ELIGIBILITY_REVIEW_WINDOW_MS`
 * in `provider.ts` mirrors a storage constant instead of importing it. The
 * four rows are tested on both sides, so a drift fails loudly in two files
 * rather than silently in one.
 */
const dashboardAccessVerdict = (access: {
  readonly enabledAccounts: number;
  readonly unreachableGuilds: readonly string[];
  readonly liveBootstrapTokens: number;
}): boolean => {
  if (access.enabledAccounts === 0) return access.liveBootstrapTokens > 0;
  return access.unreachableGuilds.length === 0;
};

/**
 * The shape of `DoctorReport.dashboardAccess` as it arrives inside
 * `ctx.instance.doctor().data` — the whole gateway-half report serialised to
 * JSON. Parsed, never cast: the data crossed a serialisation boundary, and a
 * stubbed or older `doctor()` port may carry no such section at all, in
 * which case the finding is skipped rather than failed.
 */
const dashboardAccessSchema = z.object({
  enabledAccounts: z.number().int().nonnegative(),
  unreachableGuilds: z.array(z.string()),
  liveBootstrapTokens: z.number().int().nonnegative(),
});

/**
 * The read half of the Release 1 surface (`docs/17` §1): `doctor`,
 * `audit tail`, `jobs list`, `config get`, `panel list`, `panel show`,
 * `log routing list`.
 *
 * One file, because after `status` and `killswitch` established the shape these
 * are the same shape six more times — a port call, a projection, a rendering.
 * Splitting them across six files would put more effort into the directory than
 * into the commands.
 *
 * None of them is a write, so none takes `--confirm` and none records an audit
 * row. Reading the audit trail is not an auditable event; recording it would
 * make the trail mostly a record of itself being read.
 */

/** `2h`, `45m`, `7d`, `90s`. Absolute in, relative out — see `tailAudit`. */
export const parseDuration = (input: string): number | undefined => {
  const match = /^(\d+)\s*([smhd])$/.exec(input.trim());
  if (!match) return undefined;
  const amount = Number(match[1]);
  const unit = match[2];
  const scale =
    unit === 's' ? 1_000 : unit === 'm' ? 60_000 : unit === 'h' ? 3_600_000 : 86_400_000;
  return amount * scale;
};

const iso = (ms: number): string => new Date(ms).toISOString().replace('T', ' ').slice(0, 19);

/** One doctor finding, led by what an operator must do about it. */
export interface DoctorProblem {
  /** Plain-language statement of what is wrong. */
  readonly title: string;
  /** Why it matters - the silent failure or exposure it causes. */
  readonly impact: string;
  /** The exact fix: the Discord setting, the dashboard route, or the command. */
  readonly fix: string;
  /** Dashboard path with the direct control, when one exists. */
  readonly route?: string;
  /** Raw ids and states, secondary to the plain language above. */
  readonly details?: string;
}

/** The gateway-half fields this command reads as structured findings. */
const doctorGatewayDataSchema = z.object({
  partials: z.object({ missing: z.array(z.string()) }),
  guilds: z.array(
    z.object({
      guildId: z.string(),
      present: z.boolean(),
      name: z.string().optional(),
      missingPermissions: z.array(z.string()),
      extraPermissions: z.array(z.string()),
      forbiddenPermissions: z.array(z.string()),
    }),
  ),
  archiveGuildsNotAllowlisted: z.array(z.string()),
  backup: z.object({
    dirWritable: z.boolean(),
    backupCount: z.number(),
    stale: z.boolean(),
  }),
});

// --- doctor ------------------------------------------------------------------

export const doctorCommand = defineCommand<Record<string, never>>({
  name: 'doctor',
  write: false,
  summary: 'intents, permissions, role hierarchy, stale panels',
  args: z.object({}),
  async run(ctx: OpsContext): Promise<OpsCommandResult> {
    const report = ctx.instance.doctor();
    const panels = ctx.ports.listPanels();
    const stale = panels.filter((p) => p.status !== 'enabled');
    const unassignable = ctx.ports.listUnassignableRoles();
    // ADR 0121: the guild-wide switch decides whether enabled rules act. A
    // guild with no `guilds` row has no switch to read; the gateway half
    // reports that, and automod treats it as off.
    const safety = ctx.ports.safetyState();
    const automodState = safety?.automodState ?? 'off';
    // Only On deletes anything, so only On makes Manage Messages load-bearing.
    const missingManageMessages =
      automodState === 'on' ? ctx.ports.listKeywordFilterRulesMissingManageMessages() : [];
    const unusable = ctx.ports.listUnusableAutomodRules();
    const unreadableArchiveChannels = ctx.ports.listUnreadableArchiveChannels();
    const archiveIndex = ctx.ports.archiveIndexHealth();
    // ADR 0044 §7's instance-level check: the odd one out in this command —
    // every other finding is guild-scoped, but a provider is a fact about the
    // daemon, so this reads `ctx.instance` like `mcpClients` does.
    const eligibilityWarnings = ctx.instance.providerEligibilityWarnings(ctx.now());
    // Ruling M6-D1's probe: the bot's own public hostname in both directions.
    // Awaited beside `doctor()` above — an exposed dashboard is a silent
    // breach of the exposure decision, not decoration under a green header.
    const surface = await ctx.instance.probePublicSurface();

    // Structured findings first: every problem leads with what is wrong in
    // plain language, why it matters, and the exact fix - Discord setting,
    // dashboard route, or host command - with raw ids as secondary details
    // (Bryan's doctor lane). The gateway-half text and probe text stay, but
    // demoted to raw diagnostics at the bottom.
    const problems: DoctorProblem[] = [];
    const advisories: string[] = [];
    const clear: string[] = [];

    // The gateway half's structured findings, when the daemon sent them.
    const gateway = doctorGatewayDataSchema.safeParse(report.data);
    if (gateway.success) {
      const g = gateway.data;
      if (g.partials.missing.length > 0) {
        problems.push({
          title: `Gateway partials are missing: ${g.partials.missing.join(', ')}`,
          impact:
            'A reaction on an uncached message produces no event at all, so self-granted roles silently stop working for old messages.',
          fix: 'Add the missing partials to the discord.js client options and restart.',
          details: `missing: ${g.partials.missing.join(', ')}`,
        });
      }
      for (const guild of g.guilds) {
        const label = guild.name === undefined ? guild.guildId : `${guild.name} (${guild.guildId})`;
        if (!guild.present) {
          problems.push({
            title: `The bot is not in guild ${label}`,
            impact: 'Nothing works in that server - no panels, no automod, no archive.',
            fix: 'Invite the bot to the server, or remove the id from BANANASAURS_GUILD_ALLOWLIST.',
          });
          continue;
        }
        if (guild.missingPermissions.length > 0) {
          problems.push({
            title: `The bot is missing required permissions in ${label}`,
            impact: 'Every feature that needs one of these silently fails.',
            fix: `Discord: Server Settings -> Roles -> the bot's role -> enable ${guild.missingPermissions.join(', ')}.`,
          });
        }
        if (guild.forbiddenPermissions.length > 0) {
          problems.push({
            title: `The bot holds forbidden permissions in ${label}`,
            impact:
              "docs/18's permission wall is the only limit a bug cannot defeat; these permissions dissolve it.",
            fix: `Discord: Server Settings -> Roles -> the bot's role -> remove ${guild.forbiddenPermissions.join(', ')}.`,
          });
        }
        // Extra permissions are NOT missing requirements: advisory, never a
        // problem count, so the operator can tell "grants too much" apart
        // from "cannot work".
        if (guild.extraPermissions.length > 0) {
          advisories.push(
            `${label}: the bot holds extra permissions beyond the required set (${guild.extraPermissions.join(', ')}) - safe to remove in Discord (Server Settings -> Roles), not required for anything to work.`,
          );
        }
      }
      for (const guildId of g.archiveGuildsNotAllowlisted) {
        problems.push({
          title: `Archive guild ${guildId} is not in the guild allowlist`,
          impact: 'A guild the bot never joins archives nothing - this is almost certainly a typo.',
          fix: 'Add the id to BANANASAURS_GUILD_ALLOWLIST, or remove it from BANANASAURS_ARCHIVE_GUILDS.',
        });
      }
      if (!g.backup.dirWritable) {
        problems.push({
          title: 'The backup directory is not writable',
          impact: 'No backup can be written; a host failure would mean data loss.',
          fix: 'Fix the directory permissions on the host (see BANANASAURS_BACKUP_DIR).',
        });
      } else if (g.backup.backupCount > 0 && g.backup.stale) {
        advisories.push('Backups look stale - check that the backup timer is still running.');
      }
    }

    if (stale.length === 0) {
      clear.push('panels: every configured panel is enabled');
    }
    for (const panel of stale) {
      problems.push({
        title: `Role panel ${panel.panelId} is ${panel.status}`,
        impact: 'Members cannot get roles from it - the message sits in the channel doing nothing.',
        fix: 'Enable the panel, or delete it if it is no longer needed.',
        route: '/panels',
        details: `panel ${panel.panelId}  status ${panel.status}`,
      });
    }

    if (unassignable.length === 0) {
      clear.push('roles: every managed role is assignable');
    }
    for (const role of unassignable) {
      problems.push({
        title: `Managed role ${role.roleId} cannot be assigned`,
        impact:
          'Members who should get this role never receive it; panels and rules fail for it silently.',
        fix: "Discord: Server Settings -> Roles -> drag the bot's role above this one. If it is an integration-managed role, remove it from the allowlist instead.",
        details: role.reason ?? 'reason not recorded',
      });
    }

    if (automodState === 'on' && safety?.dryRun === true) {
      advisories.push('automod is On but dry run is on: matches are logged, not acted on');
    }
    if (automodState === 'on' && missingManageMessages.length === 0) {
      clear.push('automod: every enabled keyword filter rule has Manage Messages');
    }
    for (const rule of missingManageMessages) {
      problems.push({
        title: `Keyword filter rule ${rule.ruleId} cannot delete matching messages`,
        impact:
          'Automod is On, but without Manage Messages its deletions fail and matching messages stay up.',
        fix: "Grant the bot Manage Messages in Discord (Server Settings -> Roles -> the bot's role), or switch automod to Watch on the Automod page.",
        route: `/automod/${rule.ruleId}`,
        details: `rule ${rule.ruleId}  channel ${rule.channelId}`,
      });
    }

    if (unusable.length === 0) {
      clear.push('automod: every enabled automod rule compiles');
    }
    for (const rule of unusable) {
      problems.push({
        title: `Automod rule ${rule.ruleId} will never match`,
        impact: 'The rule cannot be compiled, so it silently does nothing.',
        fix: 'Open the rule and fix the setting named in the details.',
        route: `/automod/${rule.ruleId}`,
        details: `${rule.kind}  ${rule.reason}: ${rule.detail}`,
      });
    }

    if (unreadableArchiveChannels.length === 0) {
      clear.push('archive: every enabled archive channel is readable');
    }
    for (const channel of unreadableArchiveChannels) {
      problems.push({
        title: `Archive channel ${channel.channelId} is unreadable`,
        impact: 'Nothing in that channel is archived - the archive silently misses it.',
        fix: 'Grant the bot View Channel on the channel in Discord (channel settings -> Permissions), or disable archiving for it.',
        route: '/archive',
        details: channel.reason,
      });
    }

    if (archiveIndex.indexed === archiveIndex.rows) {
      clear.push('archive: every archived message is indexed');
    } else {
      problems.push({
        title: 'The archive search index is behind',
        impact: `Only ${String(archiveIndex.indexed)} of ${String(archiveIndex.rows)} archived messages are searchable; search misses the rest.`,
        fix: "Run 'bananasaurs archive reindex --confirm' on the host.",
      });
    }

    if (eligibilityWarnings.length === 0) {
      clear.push('training eligibility: every provider verified');
    }
    for (const warning of eligibilityWarnings) {
      const reviewed = `last reviewed ${iso(warning.reviewedAt)}`;
      if (warning.reason === 'unverified') {
        problems.push({
          title: `AI provider ${warning.provider} is configured but unverified`,
          impact:
            'Assistant answers are intentionally disabled - no content leaves the server for this provider.',
          fix: "Verify the provider's training-data terms and add the eligibility record by migration, then mark it reviewed. Until then the refusal is the intended state.",
          route: '/providers',
        });
      } else if (warning.reason === 'stale') {
        problems.push({
          title: `The training-eligibility review for ${warning.provider} is stale`,
          impact:
            'The promise PRIVACY.md makes about this provider was last verified over 90 days ago.',
          fix: 'Re-read the terms at the evidence link, then mark the provider reviewed.',
          route: '/providers',
          details: reviewed,
        });
      } else if (warning.reason === 'not-production') {
        problems.push({
          title: `Provider ${warning.provider} is not allowed for production use`,
          impact:
            'Member content must not be sent to it; the assistant refuses until this is resolved.',
          fix: 'Move to a plan or provider whose terms allow production use, or set AI_PROVIDER=off.',
          route: '/providers',
          details: reviewed,
        });
      } else {
        problems.push({
          title: `Provider ${warning.provider} may train on input (or its policy is unknown)`,
          impact:
            'The assistant still uses it by owner decision (ADR 0062): member questions and server excerpts sent to it may be used for training.',
          fix: 'Accept this, or switch to a provider or plan that does not train on input and record its terms as not training.',
          route: '/providers',
          details: `trainsOnInput=${warning.trainsOnInput}  ${reviewed}`,
        });
      }
    }

    // S13-D5: whether anyone can sign in at all. The data rides in the
    // gateway-half report - computed by the daemon over the account tables,
    // which this command cannot read itself. Absent data (an older or
    // stubbed `doctor()` port) skips the finding: unassessed is not failed.
    const dashboardAccess = dashboardAccessSchema.safeParse(
      (report.data as { dashboardAccess?: unknown } | null)?.dashboardAccess,
    );
    if (dashboardAccess.success) {
      const access = dashboardAccess.data;
      if (access.enabledAccounts === 0) {
        if (access.liveBootstrapTokens > 0) {
          advisories.push(
            `Dashboard setup is pending, not broken: no accounts yet, but ${String(access.liveBootstrapTokens)} bootstrap token(s) are still live - complete setup before expiry.`,
          );
        } else {
          problems.push({
            title: 'Nobody can sign in to the dashboard',
            impact: 'The whole operator surface is unreachable.',
            fix: 'Restart the daemon to mint a new bootstrap token, then complete setup.',
          });
        }
      } else if (access.unreachableGuilds.length === 0) {
        clear.push('dashboard access: ok');
      } else {
        for (const guildId of access.unreachableGuilds) {
          problems.push({
            title: `No enabled dashboard account can reach guild ${guildId}`,
            impact: 'Nobody can operate this server from the dashboard.',
            // ADR 0124: a restart grants every enabled owner; other accounts stay explicit.
            fix:
              `Restart the daemon: every enabled owner is given access at startup. ` +
              `For another account, run 'bananasaurs account grant-guild <username> --guild ${guildId} --confirm' on the host.`,
            route: '/accounts',
          });
        }
      }
    }

    // Instance-level beside the dashboard-access finding above: a development
    // env pretty-prints logs instead of emitting JSON, so a production bot
    // running on it is a silent observability gap. Advisory, never a problem
    // count — a dev host running development is the intended state.
    if (ctx.instance.env === 'development') {
      advisories.push(
        'BANANASAURS_ENV is development on this instance - logs are pretty-printed instead of JSON. If this is the production bot, set BANANASAURS_ENV=production in .env and restart.',
      );
    }

    if (surface.ok) {
      clear.push('public surface: the dashboard is not publicly reachable');
    } else {
      problems.push({
        title: 'The dashboard may be publicly reachable',
        impact:
          'An exposed dashboard breaches the exposure decision - anyone on the internet could reach the sign-in page.',
        fix: 'Check the Cloudflare Access policy for the dashboard hostname; the dashboard must sit behind it.',
      });
    }

    // The verdict counts the gateway half and every finding above the same
    // way: a panel, an automod rule, or an archive channel that
    // silently does nothing is a problem even under a green header.
    const ok =
      report.ok &&
      stale.length === 0 &&
      unassignable.length === 0 &&
      missingManageMessages.length === 0 &&
      unusable.length === 0 &&
      unreadableArchiveChannels.length === 0 &&
      archiveIndex.indexed === archiveIndex.rows &&
      eligibilityWarnings.length === 0 &&
      (!dashboardAccess.success || dashboardAccessVerdict(dashboardAccess.data)) &&
      surface.ok;

    const lines: string[] = [
      ok ? 'doctor: ok' : 'doctor: PROBLEMS FOUND',
      `automod           ${automodState}`,
      '',
    ];
    if (problems.length > 0) {
      lines.push(`Problems (${String(problems.length)}):`, '');
      problems.forEach((problem, index) => {
        lines.push(`${String(index + 1)}. ${problem.title}`);
        lines.push(`   Impact: ${problem.impact}`);
        lines.push(`   Fix: ${problem.fix}`);
        if (problem.route !== undefined) lines.push(`   Where: dashboard ${problem.route}`);
        if (problem.details !== undefined) lines.push(`   Details: ${problem.details}`);
        lines.push('');
      });
    }
    if (advisories.length > 0) {
      lines.push('Worth knowing (not counted as problems):');
      for (const advisory of advisories) lines.push(`  - ${advisory}`);
      lines.push('');
    }
    if (clear.length > 0) {
      lines.push('Checks with no problems:');
      for (const line of clear) lines.push(`  ${line}`);
      lines.push('');
    }
    lines.push('Raw diagnostics:', report.text, '', surface.text);

    return {
      text: lines.join('\n'),
      data: {
        ok,
        // Rebuilt as fresh literals: interfaces carry no implicit index
        // signature, so the interface values themselves are not JsonValue.
        problems: problems.map((problem) => ({
          title: problem.title,
          impact: problem.impact,
          fix: problem.fix,
          ...(problem.route !== undefined && { route: problem.route }),
          ...(problem.details !== undefined && { details: problem.details }),
        })),
        advisories: [...advisories],
        automodState,
        gateway: report.data,
        stalePanels: stale.map((p) => ({ panelId: p.panelId, status: p.status })),
        unassignableRoles: unassignable.map((r) => ({
          roleId: r.roleId,
          reason: r.reason ?? null,
        })),
        automodMissingManageMessages: missingManageMessages.map((r) => ({
          ruleId: r.ruleId,
          channelId: r.channelId,
        })),
        unusableAutomodRules: unusable.map((r) => ({
          ruleId: r.ruleId,
          kind: r.kind,
          reason: r.reason,
          detail: r.detail,
        })),
        unreadableArchiveChannels: unreadableArchiveChannels.map((c) => ({
          channelId: c.channelId,
          reason: c.reason,
        })),
        archiveIndexHealth: { indexed: archiveIndex.indexed, rows: archiveIndex.rows },
        providerEligibilityWarnings: eligibilityWarnings.map((w) => ({
          provider: w.provider,
          reason: w.reason,
          trainsOnInput: w.trainsOnInput,
          reviewedAt: w.reviewedAt,
        })),
        dashboardAccess: dashboardAccess.success
          ? {
              enabledAccounts: dashboardAccess.data.enabledAccounts,
              unreachableGuilds: [...dashboardAccess.data.unreachableGuilds],
              liveBootstrapTokens: dashboardAccess.data.liveBootstrapTokens,
            }
          : null,
        publicSurface: surface.data,
      },
    };
  },
});

// --- audit tail --------------------------------------------------------------

const auditArgs = z.object({
  n: z.number().int().positive().max(500).optional(),
  since: z.string().min(1).optional(),
});

export const auditTailCommand = defineCommand<z.infer<typeof auditArgs>>({
  name: 'audit tail',
  write: false,
  summary: 'the most recent audit events, newest first',
  flags: [
    { name: 'n', kind: 'number', describe: 'how many rows (default 50, max 500)' },
    { name: 'since', kind: 'string', describe: 'only rows newer than e.g. 2h, 45m, 7d' },
  ],
  args: auditArgs,
  run(ctx: OpsContext, args): OpsCommandResult {
    let sinceMs: number | undefined;
    if (args.since !== undefined) {
      const window = parseDuration(args.since);
      if (window === undefined) {
        throw new Error(`--since expects a duration like 2h, 45m or 7d, not "${args.since}"`);
      }
      sinceMs = ctx.now() - window;
    }

    const rows = ctx.ports.tailAudit({ limit: args.n ?? 50, sinceMs });

    const lines = rows.map((row) => {
      // **Rendered as a claim, not as fact** — amendment 2 and `docs/19` §6.9.
      // The `claimed` word is the whole reason the column is named
      // `actor_unix_user_claimed`, and dropping it here would quietly restore
      // the stronger guarantee the design does not have.
      const who =
        row.actorUnixUserClaimed !== null
          ? `${row.actorType} (claimed unix user ${row.actorUnixUserClaimed})`
          : `${row.actorType}${row.actorId === null ? '' : ` ${row.actorId}`}`;
      const flags = [
        row.dryRun ? 'dry-run' : undefined,
        // Same discipline WP4 applied to deletion attribution.
        row.inferred ? 'inferred' : undefined,
        row.via === null ? undefined : `via ${row.via}`,
      ].filter((f): f is string => f !== undefined);
      return (
        `${iso(row.at)}  ${row.action.padEnd(24)} ${row.subjectType}` +
        `${row.subjectId === null ? '' : ` ${row.subjectId}`}` +
        `  ${who}${flags.length > 0 ? `  [${flags.join(', ')}]` : ''}`
      );
    });

    return {
      text: rows.length === 0 ? 'no audit events in that window' : lines.join('\n'),
      data: rows.map((row) => ({
        auditId: row.auditId,
        at: row.at,
        action: row.action,
        actorType: row.actorType,
        actorId: row.actorId,
        // The field name carries the caveat into `--json` as well, so an agent
        // reading this cannot mistake it for a verified identity either.
        actorUnixUserClaimed: row.actorUnixUserClaimed,
        via: row.via,
        subjectType: row.subjectType,
        subjectId: row.subjectId,
        batchId: row.batchId,
        dryRun: row.dryRun,
        inferred: row.inferred,
      })),
    };
  },
});

// --- jobs list ---------------------------------------------------------------

const jobsArgs = z.object({
  failed: z.boolean().optional(),
  n: z.number().int().positive().max(500).optional(),
});

export const jobsListCommand = defineCommand<z.infer<typeof jobsArgs>>({
  name: 'jobs list',
  write: false,
  summary: 'the job queue, newest first',
  flags: [
    { name: 'failed', kind: 'boolean', describe: 'only jobs that ran out of attempts' },
    { name: 'n', kind: 'number', describe: 'how many rows (default 50, max 500)' },
  ],
  args: jobsArgs,
  run(ctx: OpsContext, args): OpsCommandResult {
    const rows = ctx.ports.listJobs({ failedOnly: args.failed ?? false, limit: args.n ?? 50 });
    const nowMs = ctx.now();

    const lines = rows.map((job) => {
      const due =
        job.state === 'queued'
          ? job.runAfter <= nowMs
            ? `due ${humaniseDuration(nowMs - job.runAfter)} ago`
            : `due in ${humaniseDuration(job.runAfter - nowMs)}`
          : '';
      return (
        `#${String(job.jobId).padEnd(6)} ${job.state.padEnd(10)} ${job.kind.padEnd(22)}` +
        ` ${String(job.attempts)}/${String(job.maxAttempts)}  ${due}` +
        `${job.lastError === null ? '' : `\n         last error: ${job.lastError}`}`
      );
    });

    return {
      text:
        rows.length === 0
          ? (args.failed ?? false)
            ? 'no failed jobs'
            : 'the queue is empty'
          : lines.join('\n'),
      data: rows.map((job) => ({
        jobId: job.jobId,
        kind: job.kind,
        state: job.state,
        attempts: job.attempts,
        maxAttempts: job.maxAttempts,
        runAfter: job.runAfter,
        lastError: job.lastError,
        dedupeKey: job.dedupeKey,
      })),
    };
  },
});

// --- config get --------------------------------------------------------------

const configArgs = z.object({ key: z.string().min(1).max(64) });

export const configGetCommand = defineCommand<z.infer<typeof configArgs>>({
  name: 'config get',
  write: false,
  summary: 'one configuration value; secrets always return <redacted>',
  positional: [{ name: 'key', required: true, describe: 'e.g. BANANASAURS_DRY_RUN' }],
  args: configArgs,
  run(ctx: OpsContext, args): OpsCommandResult {
    // Two namespaces, one key space (ADR 0025). The guild settings are tried
    // first because they are the mutable ones, and an operator asking about a
    // value they can change is the common case.
    const spec = findSetting(args.key);
    if (spec !== undefined) {
      const state = ctx.ports.safetyState();
      if (state === undefined) {
        throw new Error(`guild ${ctx.guildId} has no row in \`guilds\`, so it has no settings`);
      }
      const value = currentValue(spec.key, state);
      return {
        // Labelled with its source, always. An unlabelled value would let an
        // operator read `BANANASAURS_DRY_RUN=false` and conclude the guild is
        // live while the guild's own row says otherwise.
        text: `${spec.key}=${String(value)}   (guild ${ctx.guildId})`,
        data: { key: spec.key, value, source: 'guild' },
      };
    }

    // **The redaction happens before this command sees anything.**
    // `ctx.instance.redactedConfig()` is `redactConfig(config)`, so a secret's
    // real value is not reachable from here at all — there is no flag to add
    // and no branch to forget (ADR 0013 §4: "there is no override flag").
    const config = ctx.instance.redactedConfig();
    if (!Object.prototype.hasOwnProperty.call(config, args.key)) {
      throw new Error(
        `no such configuration key: ${args.key}\n\n` +
          `  Guild settings: ${OPS_SETTINGS.map((s) => s.key).join(', ')}\n` +
          `  Process configuration: ${Object.keys(config).sort().join(', ')}`,
      );
    }
    const value = config[args.key] ?? null;
    return {
      text:
        `${args.key}=${typeof value === 'string' ? value : JSON.stringify(value)}` +
        `   (environment; changing it needs an edit to the env file and a restart)`,
      data: { key: args.key, value, source: 'environment' },
    };
  },
});

// --- panel list / panel show -------------------------------------------------

export const panelListCommand = defineCommand<Record<string, never>>({
  name: 'panel list',
  write: false,
  summary: 'every configured role panel',
  args: z.object({}),
  run(ctx: OpsContext): OpsCommandResult {
    const panels = ctx.ports.listPanels();
    const lines = panels.map(
      (p) =>
        `${p.panelId.padEnd(20)} ${p.kind.padEnd(8)} ${p.component.padEnd(9)} ` +
        `${p.behaviour.padEnd(14)} ${p.status.padEnd(19)} ` +
        `${String(p.optionCount)} option(s)` +
        `${p.messageId === undefined ? '  (not posted)' : ''}`,
    );
    return {
      text: panels.length === 0 ? 'no panels are configured' : lines.join('\n'),
      data: panels.map((p) => ({ ...p, messageId: p.messageId ?? null })),
    };
  },
});

const panelShowArgs = z.object({ panelId: z.string().min(1).max(64) });

export const panelShowCommand = defineCommand<z.infer<typeof panelShowArgs>>({
  name: 'panel show',
  write: false,
  summary: 'one panel in full, including its options and limits',
  positional: [{ name: 'panelId', required: true, describe: 'the panel id from `panel list`' }],
  args: panelShowArgs,
  run(ctx: OpsContext, args): OpsCommandResult {
    const panel = ctx.ports.findPanel(args.panelId);
    if (panel === undefined) throw new Error(`no panel ${args.panelId} in guild ${ctx.guildId}`);

    const lines = [
      `panel     ${panel.panelId}`,
      `kind      ${panel.kind} (${panel.component})`,
      `behaviour ${panel.behaviour}${panel.maxRoles === undefined ? '' : `, at most ${String(panel.maxRoles)} role(s)`}`,
      `status    ${panel.status}`,
      `channel   ${panel.channelId}`,
      `message   ${panel.messageId ?? '(not posted)'}`,
      `content   ${panel.content === undefined ? '(default copy)' : `${String(panel.content.length)} chars`}`,
      `adoption  ${panel.adoptionPassState}${panel.adoptionBlockedCount > 0 ? ` — ${String(panel.adoptionBlockedCount)} change(s) waiting on an allowance` : ''}`,
      `required  ${panel.requiredRoleId ?? '(none)'}`,
      `blocked   ${panel.blockedRoleIds.length === 0 ? '(none)' : panel.blockedRoleIds.join(', ')}`,
      'options',
      // Reaction panels carry an emoji, component panels a label; every panel
      // has an option id, so there is always something to print.
      ...panel.options.map((o) => `  ${o.emojiKey ?? o.label ?? o.optionId} -> role ${o.roleId}`),
    ];
    return {
      text: lines.join('\n'),
      // Projected field by field rather than cast: `undefined` is not JSON, and
      // a cast would have shipped `maxRoles: undefined` as a missing key while
      // the type claimed it was there.
      data: {
        ...panel,
        messageId: panel.messageId ?? null,
        content: panel.content ?? null,
        maxRoles: panel.maxRoles ?? null,
        requiredRoleId: panel.requiredRoleId ?? null,
        blockedRoleIds: [...panel.blockedRoleIds],
        options: panel.options.map((o) => ({
          optionId: o.optionId,
          roleId: o.roleId,
          emojiKey: o.emojiKey ?? null,
          label: o.label ?? null,
        })),
      },
    };
  },
});

// --- log routing list --------------------------------------------------------

export const logRoutingListCommand = defineCommand<Record<string, never>>({
  name: 'log routing list',
  write: false,
  summary: 'the named log routes, and which channels are excluded everywhere',
  args: z.object({}),
  run(ctx: OpsContext): OpsCommandResult {
    const routes = ctx.ports.listRoutes();
    const excluded = ctx.ports.listExcludedChannels();

    const lines: string[] = [];
    if (routes.length === 0) {
      // Worth saying outright rather than printing an empty table: WP4's logging
      // module is fully built and does nothing at all until a route exists, and
      // "no output" looks identical to "working but quiet".
      lines.push('No log routes are configured, so nothing is being logged to Discord.');
      lines.push(
        '  Create one with: bananasaurs log routing create <channel-id> --events <kinds|all> --confirm',
      );
    } else {
      for (const route of routes) {
        lines.push(
          `${route.routeId.slice(0, 8)}  ${route.name}  -> <#${route.channelId}>` +
            `${route.enabled ? '' : '   (DISABLED)'}` +
            `${route.includeContent ? '' : '   (metadata only)'}`,
        );
        lines.push(`    events:   ${route.eventKinds.join(', ')}`);
        lines.push(
          route.excludedChannelIds.length === 0
            ? '    excludes: none'
            : `    excludes: ${route.excludedChannelIds.map((id) => `<#${id}>`).join(', ')}`,
        );
      }
    }
    lines.push('');
    lines.push(
      excluded.length === 0
        ? 'excluded everywhere (No access)  none'
        : `excluded everywhere (No access)  ${excluded.map((id) => `<#${id}>`).join(', ')}`,
    );

    return {
      text: lines.join('\n'),
      data: {
        routes: routes.map((r) => ({
          routeId: r.routeId,
          name: r.name,
          channelId: r.channelId,
          enabled: r.enabled,
          includeContent: r.includeContent,
          createdAtMs: r.createdAtMs,
          eventKinds: [...r.eventKinds],
          excludedChannelIds: [...r.excludedChannelIds],
        })),
        excludedChannels: [...excluded],
      },
    };
  },
});
