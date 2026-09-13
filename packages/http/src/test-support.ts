import {
  accountRepo,
  automodAdminRepo,
  automodRuleRepo,
  effectRepo,
  enforcementGateRepo,
  guildRepo,
  jobRepo,
  loggingRepo,
  modCaseRepo,
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

  listUnusableAutomodRules: () => {
    throw new Error('not used by the dashboard routes under test');
  },

  listAutomodRulesEnforcingWithBadCutoverState: () => {
    throw new Error('not used by the dashboard routes under test');
  },

  listAutomodRulesObservingPastWindowWithBacklog: () => {
    throw new Error('not used by the dashboard routes under test');
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

  findAutomodRule: () => {
    throw new Error('not used by the dashboard routes under test');
  },
  listAutomodFixtures: () => {
    throw new Error('not used by the dashboard routes under test');
  },
  listUnreviewedMatches: () => {
    throw new Error('not used by the dashboard routes under test');
  },

  // Slice 8's dashboard pages (Task 2): the same real-repo behaviour
  // `apps/daemon/src/ops/wiring.ts` wires, so route tests exercise real
  // reads and writes. Only `runAutomodDryRun` differs — a canned report
  // rather than a real replay (`toAutomodRule` lives in `apps/daemon` and
  // this package may not import it); the route test asserts pass-through.
  listAutomodRules: () => {
    const matchCounts = automodAdminRepo.countMatchesByRule(scope);
    const reviewedCounts = automodAdminRepo.countReviewedByRule(scope);
    return automodAdminRepo
      .listRules(scope)
      .map((rule) => testAutomodRuleSummary(rule, matchCounts, reviewedCounts));
  },
  findAutomodRuleDetail: (ruleId) => {
    const rule = automodAdminRepo.findRule(scope, ruleId);
    if (rule === undefined) return undefined;
    const stored = automodRuleRepo.findRuleIncludingDisabled(scope, ruleId);
    return {
      ...testAutomodRuleSummary(
        rule,
        automodAdminRepo.countMatchesByRule(scope),
        automodAdminRepo.countReviewedByRule(scope),
      ),
      exemptions: automodAdminRepo.listExemptions(scope, ruleId),
      terms: stored?.terms ?? [],
      allowlist: stored?.allowlist ?? [],
      inviteAllowlist: stored?.inviteAllowlist ?? [],
      linkDomains: stored?.linkDomains ?? [],
      eligibility: enforcementGateRepo.enforcementEligibility(scope, ruleId),
    };
  },
  runAutomodDryRun: (ruleId) => {
    if (!automodRuleRepo.ruleExists(scope, ruleId)) return 'no-such-rule';
    const rule = automodRuleRepo.findRuleKindAndConfig(scope, ruleId);
    if (rule === undefined) return 'no-such-rule';
    return {
      ruleId,
      kind: rule.kind,
      usable: true,
      failure: undefined,
      threw: 0,
      corpusSize: 0,
      total: 0,
      matched: 0,
      falsePositives: 0,
      falseNegatives: 0,
      results: [],
    };
  },
  listRecentCases: (query) =>
    automodAdminRepo.listRecentCases(scope, { limit: query.limit }).map(testCaseRow),
  findCaseDetail: (caseId) => {
    const found = automodAdminRepo.findCase(scope, caseId);
    if (found === undefined) return undefined;
    return {
      case: testCaseRow(found),
      events: modCaseRepo.listCaseEvents(scope, caseId).map((event) => ({
        eventId: event.eventId,
        caseId: event.caseId,
        ruleId: event.ruleId,
        memberId: event.memberId,
        at: event.at,
        matchedCategory: event.matchedCategory,
        matchedSnippet: event.matchedSnippet,
        actionTaken: event.actionTaken,
        escalationAction: event.escalationAction,
        refusalReason: event.refusalReason,
        actorId: event.actorId,
        trace: event.trace,
        fixtureId: event.fixtureId,
      })),
    };
  },
  listCasesForMember: (memberId) =>
    modCaseRepo.listCasesForMember(scope, memberId).map(testCaseRow),

  applySetting: () => {
    throw new Error('not used by the dashboard routes under test');
  },
  recordMatchVerdict: () => {
    throw new Error('not used by the dashboard routes under test');
  },
  setAutomodRuleReady: () => {
    throw new Error('not used by the dashboard routes under test');
  },
  recordAutomodSignOff: () => {
    throw new Error('not used by the dashboard routes under test');
  },
  addInviteAllowlistEntry: () => {
    throw new Error('not used by the dashboard routes under test');
  },
  listInviteAllowlist: () => {
    throw new Error('not used by the dashboard routes under test');
  },
  removeInviteAllowlistEntry: () => {
    throw new Error('not used by the dashboard routes under test');
  },
  addLinkDomain: () => {
    throw new Error('not used by the dashboard routes under test');
  },
  listLinkDomains: () => {
    throw new Error('not used by the dashboard routes under test');
  },
  removeLinkDomain: () => {
    throw new Error('not used by the dashboard routes under test');
  },
  createAutomodRule: (input) => {
    if (automodRuleRepo.ruleExists(scope, input.ruleId)) return 'exists';
    automodRuleRepo.createRule(scope, { ...input, now: now() });
    return 'created';
  },
  setAutomodRuleConfig: (input) => {
    if (!automodRuleRepo.ruleExists(scope, input.ruleId)) return 'no-such-rule';
    automodRuleRepo.setRuleConfig(scope, { ...input, now: now() });
    return 'ok';
  },
  setAutomodRuleMode: (input) => {
    if (!automodRuleRepo.ruleExists(scope, input.ruleId)) return 'no-such-rule';
    return automodRuleRepo.setRuleMode(scope, {
      ruleId: input.ruleId,
      ...(input.mode !== undefined && { mode: input.mode }),
      ...(input.enabled !== undefined && { enabled: input.enabled }),
      now: now(),
    });
  },
  addAutomodExemption: (input) => {
    if (!automodRuleRepo.ruleExists(scope, input.ruleId)) return 'no-such-rule';
    const existing = automodAdminRepo.listExemptions(scope, input.ruleId);
    if (
      existing.some(
        (exemption) =>
          exemption.exemptType === input.exemptType && exemption.exemptId === input.exemptId,
      )
    ) {
      return 'already-present';
    }
    if (input.exemptType === 'role') {
      automodRuleRepo.addRoleExemption(scope, { ruleId: input.ruleId, roleId: input.exemptId });
    } else {
      automodRuleRepo.addChannelExemption(scope, {
        ruleId: input.ruleId,
        channelId: input.exemptId,
      });
    }
    return 'added';
  },
  removeAutomodExemption: (input) => {
    const removed = automodAdminRepo.removeExemption(scope, input);
    return removed ? 'removed' : 'not-present';
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

/** One dashboard rule summary: the admin row plus this guild's match tallies. */
const testAutomodRuleSummary = (
  rule: ReturnType<typeof automodAdminRepo.listRules>[number],
  matchCounts: Readonly<Record<string, number>>,
  reviewedCounts: Readonly<Record<string, number>>,
) => ({
  ruleId: rule.ruleId,
  kind: rule.kind,
  name: rule.name,
  mode: rule.mode,
  enabled: rule.enabled,
  config: rule.config,
  cutoverState: rule.cutoverState,
  observeStartedAt: rule.observeStartedAt,
  legacyRuleRef: rule.legacyRuleRef,
  countsAsViolation: rule.countsAsViolation,
  maxFalsePositiveRate: rule.maxFalsePositiveRate,
  minReviewedMatches: rule.minReviewedMatches,
  enforceSignedOffBy: rule.enforceSignedOffBy,
  enforceSignedOffAt: rule.enforceSignedOffAt,
  createdAt: rule.createdAt,
  updatedAt: rule.updatedAt,
  matchCount: matchCounts[rule.ruleId] ?? 0,
  reviewedCount: reviewedCounts[rule.ruleId] ?? 0,
});

/** The case projection, shared by the three case reads. */
const testCaseRow = (found: ReturnType<typeof automodAdminRepo.listRecentCases>[number]) => ({
  caseId: found.caseId,
  memberId: found.memberId,
  openedAt: found.openedAt,
  violationCount: found.violationCount,
  escalationTier: found.escalationTier,
  status: found.status,
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
