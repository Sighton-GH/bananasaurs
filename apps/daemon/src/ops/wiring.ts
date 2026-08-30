import type { Client } from 'discord.js';
import {
  JOB_KINDS,
  reconcileDedupeKey,
  redactConfig,
  undoDedupeKey,
  type Config,
  type OpsInstance,
  type OpsPorts,
  type OpsSettingChange,
} from '@bananasaurs/core';
import {
  effectRepo,
  guildRepo,
  jobRepo,
  loggingRepo,
  panelRepo,
  roleRepo,
  type GuildScope,
} from '@bananasaurs/storage';
import { countUndoable } from '../jobs/undo.js';
import { buildDoctorReport, formatDoctorReport } from '../runtime/doctor.js';
import type { GuildOperations } from '../runtime/guild.js';

/**
 * The operator surface's ports, bound to one guild.
 *
 * Every function here is a closure over one `GuildScope`, so a command cannot
 * name a different guild even if it tried — the same shape `buildGuildRuntime`
 * already uses for the logging, reconciliation and adoption ports. This is the
 * only file in the operator path that knows both the domain and the database.
 */
/**
 * The injected clock, not `Date.now()`.
 *
 * Every other wiring function in this tree takes `now` for the reason
 * `panelEffectsFor` states: it is the same clock the gateway and the job worker
 * read. For most of these ports that only affects a timestamp — but an
 * enqueue's `run_after` is *compared* against the worker's clock by
 * `claimNext`, so a port on the wall clock in a process whose clock is anything
 * else enqueues a job dated in the future that is never claimed. It shows up as
 * a row sitting in `jobs list` forever, with nothing anywhere saying why.
 */
export const opsPortsFor = (
  scope: GuildScope,
  operations: GuildOperations,
  now: () => number,
): OpsPorts => ({
  guildName: () => guildRepo.findGuild(scope)?.name,
  safetyState: () => guildRepo.readSafetyState(scope),
  jobCounts: () => jobRepo.countByState(scope),
  oldestDueJobAtMs: (nowMs) => jobRepo.oldestDueAt(scope, nowMs),
  recordAudit: (input) =>
    effectRepo.recordAudit(scope, {
      at: input.at,
      actorType: input.actorType,
      actorId: input.actorId,
      actorUnixUserClaimed: input.actorUnixUserClaimed,
      via: input.via,
      action: input.action,
      subjectType: input.subjectType,
      subjectId: input.subjectId,
      before: input.before,
      after: input.after,
      dryRun: input.dryRun,
    }),
  setKillswitch: (on) => guildRepo.setKillswitch(scope, on, now()),

  tailAudit: (query) =>
    effectRepo.tailAudit(scope, { limit: query.limit, sinceMs: query.sinceMs }).map((row) => ({
      auditId: row.auditId,
      at: row.at,
      actorType: row.actorType,
      actorId: row.actorId,
      actorUnixUserClaimed: row.actorUnixUserClaimed,
      via: row.via,
      action: row.action,
      subjectType: row.subjectType,
      subjectId: row.subjectId,
      batchId: row.batchId,
      // The columns are SQLite integers; the port speaks booleans, so the
      // conversion happens once here rather than in every renderer.
      dryRun: row.dryRun === 1,
      inferred: row.inferred === 1,
    })),

  listJobs: (query) =>
    jobRepo.listJobs(scope, { failedOnly: query.failedOnly, limit: query.limit }).map(jobRow),

  listPanels: () => panelRepo.listPanels(scope).map(panelSummary),

  findPanel: (panelId) => {
    const panel = panelRepo.findPanel(scope, panelId);
    if (panel === undefined) return undefined;
    return {
      ...panelSummary(panel),
      channelId: panel.channelId,
      maxRoles: panel.maxRoles,
      requiredRoleId: panel.requiredRoleId,
      blockedRoleIds: panel.blockedRoleIds,
      adoptionPassState: panel.adoptionPassState,
      adoptionBlockedCount: panel.adoptionBlockedCount,
      options: panel.options.map((option) => ({
        optionId: option.optionId,
        roleId: option.roleId,
        emojiKey: option.emojiKey,
        label: option.label,
      })),
    };
  },

  listUnassignableRoles: () =>
    roleRepo.listUnassignableRoles(scope).map((row) => ({
      roleId: row.roleId,
      reason: row.unassignableReason,
    })),

  listRoutes: () =>
    loggingRepo.listRoutes(scope).map((route) => ({
      eventKind: route.eventKind,
      channelId: route.channelId,
      enabled: route.enabled,
      includeContent: route.includeContent,
    })),

  listExcludedChannels: () => loggingRepo.listExcludedChannels(scope),

  findJob: (jobId) => {
    const job = jobRepo.findJob(scope, jobId);
    return job === undefined ? undefined : jobRow(job);
  },

  // --- write commands (13d) --------------------------------------------------
  applySetting: (change) => applySetting(scope, change, now()),

  setRoute: (input) =>
    loggingRepo.setRoute(scope, {
      eventKind: input.eventKind,
      channelId: input.channelId,
      includeContent: input.includeContent,
    }),
  setRouteEnabled: (eventKind, enabled) => loggingRepo.setRouteEnabled(scope, eventKind, enabled),
  excludeChannel: (channelId) => loggingRepo.excludeChannel(scope, channelId),
  unexcludeChannel: (channelId) => loggingRepo.unexcludeChannel(scope, channelId),

  retryJob: (jobId) => {
    const outcome = jobRepo.retryJob(scope, jobId, now());
    // Projected field by field rather than passed through: the repository's
    // success case carries the whole job row, and the port's does not need it.
    return outcome.ok ? { ok: true } : outcome;
  },

  // --- write commands that reach Discord (13e, ADR 0026) ---------------------
  publishPanel: (panelId) => operations.publishPanel(panelId),
  grantAdoptionAllowance: (count) => {
    operations.grantAdoptionAllowance(count);
  },
  adoptionAllowance: () => operations.adoptionAllowance(),

  enqueueReconcile: (panelId) =>
    enqueued(
      jobRepo.enqueue(scope, {
        kind: JOB_KINDS.reconcileGuild,
        payload: JSON.stringify({ reason: 'operator', panelId }),
        // Per panel, so syncing panel A is not absorbed by a pending sync of
        // panel B — and so a second sync of the *same* panel is.
        dedupeKey: reconcileDedupeKey('operator', panelId),
        now: now(),
      }),
    ),

  findBatch: (batchId) => {
    const row = effectRepo.findBatch(scope, batchId);
    if (row === undefined) return undefined;
    return {
      batchId: row.batchId,
      source: row.source,
      actorType: row.actorType,
      startedAt: row.startedAt,
      finishedAt: row.finishedAt,
      undoneAt: row.undoneAt,
    };
  },
  countUndoable: (batchId) => countUndoable(scope, batchId),
  enqueueUndo: (input) =>
    enqueued(
      jobRepo.enqueue(scope, {
        kind: JOB_KINDS.undoBatch,
        payload: JSON.stringify({ batchId: input.batchId, reason: input.reason }),
        dedupeKey: undoDedupeKey(input.batchId),
        now: now(),
      }),
    ),
});

/** The enqueue result, narrowed to what a command reports. */
const enqueued = (result: ReturnType<typeof jobRepo.enqueue>) => ({
  enqueued: result.enqueued,
  jobId: result.jobId,
});

/**
 * One validated setting change, applied to the column that holds it.
 *
 * The `switch` is exhaustive by construction: `OpsSettingChange` is a
 * discriminated union, so `value` narrows without a cast, and a key added to
 * `OPS_SETTINGS` with no branch here fails `tsc` rather than falling through to
 * a silent no-op (ADR 0025).
 */
const applySetting = (scope: GuildScope, change: OpsSettingChange, now: number): void => {
  switch (change.key) {
    case 'dry_run':
      guildRepo.setDryRun(scope, change.value, now);
      return;
    case 'role_rate_per_min':
      guildRepo.setLimits(scope, { roleRatePerMin: change.value }, now);
      return;
    case 'reconcile_budget':
      guildRepo.setLimits(scope, { reconcileBudget: change.value }, now);
      return;
    case 'breaker_threshold':
      guildRepo.setLimits(scope, { breakerThreshold: change.value }, now);
      return;
    case 'breaker':
      guildRepo.resetBreaker(scope, now);
      return;
  }
};

/** The job projection, shared by `jobs list` and `jobs retry`. */
const jobRow = (job: {
  jobId: number;
  kind: string;
  state: string;
  attempts: number;
  maxAttempts: number;
  runAfter: number;
  lastError: string | null;
  dedupeKey: string;
}) => ({
  jobId: job.jobId,
  kind: job.kind,
  state: job.state,
  attempts: job.attempts,
  maxAttempts: job.maxAttempts,
  runAfter: job.runAfter,
  lastError: job.lastError,
  dedupeKey: job.dedupeKey,
});

/** The listing projection, shared by `panel list` and `panel show`. */
const panelSummary = (panel: ReturnType<typeof panelRepo.listPanels>[number]) => ({
  panelId: panel.panelId,
  kind: panel.kind,
  component: panel.component,
  behaviour: panel.behaviour,
  status: panel.status,
  messageId: panel.messageId,
  optionCount: panel.options.length,
});

export interface OpsInstanceDeps {
  readonly config: Config;
  readonly client: Client;
  readonly startedAtMs: number;
}

/**
 * Process-level facts for `status` and `doctor`.
 *
 * `gateway()` is a function rather than a snapshot because it is read at
 * request time, minutes or days after the daemon was assembled — a captured
 * boolean would report the connection as it was at startup, which is the
 * opposite of what an operator asking "is it connected" wants to know.
 */
export const opsInstanceFor = (deps: OpsInstanceDeps): OpsInstance => ({
  startedAtMs: deps.startedAtMs,
  readonly: deps.config.BANANASAURS_READONLY,
  env: deps.config.BANANASAURS_ENV,
  doctor: () => {
    // Wrapped for the same reason `daemon.ts` wraps the startup report:
    // `GuildMember.permissions` builds a bitfield from every cached role and
    // throws on a role delivered without a `permissions` field. A diagnostic
    // that can take down the socket handler is worse than no diagnostic.
    try {
      const report = buildDoctorReport(deps.client, deps.config);
      return {
        ok: report.ok,
        text: formatDoctorReport(report),
        data: JSON.parse(JSON.stringify(report)) as never,
      };
    } catch (err) {
      return {
        ok: false,
        text: `doctor could not read the client: ${err instanceof Error ? err.message : String(err)}`,
        data: null,
      };
    }
  },

  redactedConfig: () => redactConfig(deps.config) as Readonly<Record<string, never>>,

  gateway: () => {
    // discord.js reports -1 before the first heartbeat. Reported as "not yet"
    // rather than as a suspiciously fast round trip.
    const ping = deps.client.ws.ping;
    return {
      connected: deps.client.isReady(),
      pingMs: ping >= 0 ? Math.round(ping) : undefined,
      guildCount: deps.client.guilds.cache.size,
    };
  },
});
