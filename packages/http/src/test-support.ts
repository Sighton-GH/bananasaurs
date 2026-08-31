import {
  accountRepo,
  effectRepo,
  guildRepo,
  jobRepo,
  loggingRepo,
  panelRepo,
  type GuildScope,
  type InstanceScope,
} from '@bananasaurs/storage';
import type { OpsInstance, OpsPorts } from '@bananasaurs/core';

/**
 * Test-only `OpsPorts` and `OpsInstance`, built directly against the repos —
 * the same repos `apps/daemon/src/ops/wiring.ts`'s `opsPortsFor` closes over,
 * minus the members that need `GuildOperations` (a real Discord client, which
 * this package may not import, ADR 0014, and which the dashboard's read and
 * write routes never call).
 *
 * This exists so `packages/http`'s own route tests can exercise real read and
 * write behaviour against a real migrated test database, without duplicating
 * `apps/daemon`'s composition here. It is not a stand-in for that module —
 * `apps/daemon` still builds the production `portsFor` the same way it always
 * has; this only proves the routes call the right port with the right scope.
 */
export const testPortsFor = (scope: GuildScope, now: () => number): OpsPorts => ({
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
      dryRun: row.dryRun === 1,
      inferred: row.inferred === 1,
    })),

  listJobs: (query) =>
    jobRepo.listJobs(scope, { failedOnly: query.failedOnly, limit: query.limit }).map((job) => ({
      jobId: job.jobId,
      kind: job.kind,
      state: job.state,
      attempts: job.attempts,
      maxAttempts: job.maxAttempts,
      runAfter: job.runAfter,
      lastError: job.lastError,
      dedupeKey: job.dedupeKey,
    })),

  listPanels: () =>
    panelRepo.listPanels(scope).map((panel) => ({
      panelId: panel.panelId,
      kind: panel.kind,
      component: panel.component,
      behaviour: panel.behaviour,
      status: panel.status,
      messageId: panel.messageId,
      optionCount: panel.options.length,
    })),

  findPanel: (panelId) => {
    const panel = panelRepo.findPanel(scope, panelId);
    if (panel === undefined) return undefined;
    return {
      panelId: panel.panelId,
      kind: panel.kind,
      component: panel.component,
      behaviour: panel.behaviour,
      status: panel.status,
      messageId: panel.messageId,
      optionCount: panel.options.length,
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

  listUnassignableRoles: () => [],

  listKeywordFilterRulesMissingManageMessages: () => {
    throw new Error('not used by the dashboard routes under test — needs a real Discord client');
  },

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
    if (job === undefined) return undefined;
    return {
      jobId: job.jobId,
      kind: job.kind,
      state: job.state,
      attempts: job.attempts,
      maxAttempts: job.maxAttempts,
      runAfter: job.runAfter,
      lastError: job.lastError,
      dedupeKey: job.dedupeKey,
    };
  },

  applySetting: () => {
    throw new Error('not used by the dashboard routes under test');
  },
  setRoute: (input) =>
    loggingRepo.setRoute(scope, {
      eventKind: input.eventKind,
      channelId: input.channelId,
      includeContent: input.includeContent,
    }),
  setRouteEnabled: (eventKind, enabled) => loggingRepo.setRouteEnabled(scope, eventKind, enabled),
  excludeChannel: (channelId) => loggingRepo.excludeChannel(scope, channelId),
  unexcludeChannel: (channelId) => loggingRepo.unexcludeChannel(scope, channelId),
  retryJob: () => {
    throw new Error('not used by the dashboard routes under test');
  },

  publishPanel: () => {
    throw new Error('not used by the dashboard routes under test — needs a real Discord client');
  },
  enqueueReconcile: () => {
    throw new Error('not used by the dashboard routes under test');
  },
  findBatch: () => undefined,
  countUndoable: () => {
    throw new Error('not used by the dashboard routes under test');
  },
  enqueueUndo: () => {
    throw new Error('not used by the dashboard routes under test');
  },
  grantAdoptionAllowance: () => {
    throw new Error('not used by the dashboard routes under test');
  },
  adoptionAllowance: () => 0,
});

export const testInstanceFor = (instanceScope: InstanceScope, now: () => number): OpsInstance => ({
  startedAtMs: now(),
  readonly: false,
  env: 'test',
  doctor: () => ({ ok: true, text: 'not used by the dashboard routes under test', data: null }),
  redactedConfig: () => ({}),
  gateway: () => ({ connected: true, pingMs: undefined, guildCount: 1 }),
  reissueBootstrapToken: () => {
    const accountCount = accountRepo.countAccounts(instanceScope);
    if (accountCount > 0) return { ok: false, reason: 'accounts-exist', accountCount };
    return { ok: false, reason: 'readonly' };
  },
  backupNow: () => {
    throw new Error('not used by the dashboard routes under test');
  },
  backupList: () => [],
});
