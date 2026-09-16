import { z } from 'zod';
import { defineCommand, type OpsCommandResult, type OpsContext } from '../dispatch.js';
import { findSetting, OPS_SETTINGS } from '../settings.js';
import { humaniseDuration } from './status.js';
import { currentValue } from './writes.js';

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

// --- doctor ------------------------------------------------------------------

export const doctorCommand = defineCommand<Record<string, never>>({
  name: 'doctor',
  write: false,
  summary: 'intents, permissions, role hierarchy, stale panels',
  args: z.object({}),
  run(ctx: OpsContext): OpsCommandResult {
    const report = ctx.instance.doctor();
    const panels = ctx.ports.listPanels();
    const stale = panels.filter((p) => p.status !== 'enabled');
    const unassignable = ctx.ports.listUnassignableRoles();
    const missingManageMessages = ctx.ports.listKeywordFilterRulesMissingManageMessages();
    const unusable = ctx.ports.listUnusableAutomodRules();
    const badCutoverState = ctx.ports.listAutomodRulesEnforcingWithBadCutoverState();
    const observePastWindow = ctx.ports.listAutomodRulesObservingPastWindowWithBacklog(ctx.now());
    const unreadableArchiveChannels = ctx.ports.listUnreadableArchiveChannels();
    const archiveIndex = ctx.ports.archiveIndexHealth();
    // ADR 0044 §7's instance-level check: the odd one out in this command —
    // every other finding is guild-scoped, but a provider is a fact about the
    // daemon, so this reads `ctx.instance` like `mcpClients` does.
    const eligibilityWarnings = ctx.instance.providerEligibilityWarnings(ctx.now());

    const lines = [report.text, ''];
    lines.push(
      stale.length === 0
        ? 'panels    every configured panel is enabled'
        : `panels    ${String(stale.length)} disabled:\n` +
            stale.map((p) => `            ${p.panelId}  ${p.status}`).join('\n'),
    );
    lines.push(
      unassignable.length === 0
        ? 'roles     every managed role is assignable'
        : `roles     ${String(unassignable.length)} unassignable:\n` +
            unassignable
              .map((r) => `            ${r.roleId}  ${r.reason ?? 'reason not recorded'}`)
              .join('\n'),
    );
    lines.push(
      missingManageMessages.length === 0
        ? 'automod    every enforce-mode keyword filter rule has Manage Messages'
        : `automod    ${String(missingManageMessages.length)} rule(s) missing Manage Messages:\n` +
            missingManageMessages
              .map((r) => `            ${r.ruleId}  channel ${r.channelId}`)
              .join('\n'),
    );
    lines.push(
      unusable.length === 0
        ? 'automod    every enabled automod rule compiles'
        : `automod    ${String(unusable.length)} rule(s) cannot be compiled and will never match:\n` +
            unusable
              .map((r) => `            ${r.ruleId}  (${r.kind})  ${r.reason}: ${r.detail}`)
              .join('\n'),
    );
    lines.push(
      // ADR 0042 §3's first check: rows `setRuleMode` can no longer create —
      // it refuses `mode: 'enforce'` outside `ready`/`cutover` — so a hit here
      // predates this slice or was hand-edited straight into the database.
      badCutoverState.length === 0
        ? 'automod    every enforcing rule is in a cutover_state that permits it'
        : `automod    ${String(badCutoverState.length)} rule(s) enforcing with a cutover_state that ` +
            `does not permit it:\n` +
            badCutoverState
              .map((r) => `            ${r.ruleId}  cutover_state=${r.cutoverState}`)
              .join('\n'),
    );
    lines.push(
      // ADR 0042 §3's second check: an observe window that ran past docs/08's
      // floor with matches nobody has reviewed. `doctor` reports it; nothing
      // at the write path refuses on its account (there is nothing to write).
      observePastWindow.length === 0
        ? 'automod    no observing rule is both past its window and carrying an unreviewed backlog'
        : `automod    ${String(observePastWindow.length)} rule(s) observing past their window with ` +
            `an unreviewed backlog:\n` +
            observePastWindow
              .map(
                (r) =>
                  `            ${r.ruleId}  observing since ${iso(r.observeStartedAt)}, ` +
                  `${String(r.unreviewedCount)} unreviewed match(es)`,
              )
              .join('\n'),
    );

    lines.push(
      // ADR 0046 D1's per-guild check: an enabled archive channel the bot
      // cannot read archives nothing, silently. Same problem flag as the
      // automod lines above — a silent no-op under a green header is the
      // exact confusion `doctor` exists to prevent.
      unreadableArchiveChannels.length === 0
        ? 'archive    every enabled archive channel is readable'
        : `archive    ${String(unreadableArchiveChannels.length)} channel(s) unreadable:\n` +
            unreadableArchiveChannels
              .map((c) => `    ARCHIVE CHANNEL UNREADABLE: ${c.channelId} (${c.reason})`)
              .join('\n'),
    );

    lines.push(
      // The FTS row count beside the `archive_messages` row count, both for
      // this guild: a restored database disagrees until `archive reindex`
      // runs. Same problem flag as the archive line above.
      archiveIndex.indexed === archiveIndex.rows
        ? 'archive    every archived message is indexed'
        : `    ARCHIVE INDEX STALE: ${String(archiveIndex.indexed)} indexed, ` +
            `${String(archiveIndex.rows)} archived — run 'archive reindex --confirm'`,
    );

    lines.push(
      // ADR 0044 §7: a stale or not-`'no'` eligibility row is a promise
      // `PRIVACY.md` makes that nobody recently verified. `doctor` is where
      // an operator finds that out — the review date rides along as ISO so
      // the warning says when the promise was last checked.
      eligibilityWarnings.length === 0
        ? 'training eligibility    every provider verified'
        : `training eligibility    ${String(eligibilityWarnings.length)} provider(s) need review:\n` +
            eligibilityWarnings
              .map((w) => `            ${w.provider}  ${w.reason}  reviewed ${iso(w.reviewedAt)}`)
              .join('\n'),
    );

    // The gateway half already decides `ok`; the eight guild-scoped findings
    // here are just as capable of making a panel, an enforce-mode rule, or an
    // automod rule that never gets as far as matching — silently do nothing,
    // so they count the same way rather than being printed as decoration
    // under a green header. The eligibility finding above it counts too: a
    // stale promise about training is a silent breach of `PRIVACY.md`, not a
    // footnote.
    const ok =
      report.ok &&
      stale.length === 0 &&
      unassignable.length === 0 &&
      missingManageMessages.length === 0 &&
      unusable.length === 0 &&
      badCutoverState.length === 0 &&
      observePastWindow.length === 0 &&
      unreadableArchiveChannels.length === 0 &&
      archiveIndex.indexed === archiveIndex.rows &&
      eligibilityWarnings.length === 0;
    lines.push('', ok ? 'doctor: ok' : 'doctor: PROBLEMS FOUND');

    return {
      text: lines.join('\n'),
      data: {
        ok,
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
        automodEnforceModeBadCutoverState: badCutoverState.map((r) => ({
          ruleId: r.ruleId,
          cutoverState: r.cutoverState,
        })),
        automodObservePastWindowWithBacklog: observePastWindow.map((r) => ({
          ruleId: r.ruleId,
          observeStartedAt: r.observeStartedAt,
          unreviewedCount: r.unreviewedCount,
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
  summary: 'where each logged event kind goes, and which channels are excluded',
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
      lines.push('  Set one with: bananasaurs log routing set <event-kind> <channel-id> --confirm');
    } else {
      for (const route of routes) {
        lines.push(
          `${route.eventKind.padEnd(18)} -> ${route.channelId}` +
            `${route.enabled ? '' : '   (DISABLED)'}` +
            `${route.includeContent ? '' : '   (metadata only)'}`,
        );
      }
    }
    lines.push('');
    lines.push(
      excluded.length === 0
        ? 'excluded  (no channels are excluded from logging)'
        : `excluded  ${excluded.join(', ')}`,
    );

    return {
      text: lines.join('\n'),
      data: {
        routes: routes.map((r) => ({
          eventKind: r.eventKind,
          channelId: r.channelId,
          enabled: r.enabled,
          includeContent: r.includeContent,
        })),
        excludedChannels: excluded,
      },
    };
  },
});
