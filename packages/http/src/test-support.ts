import {
  accountRepo,
  archiveRepo,
  archiveSearchRepo,
  authzRepo,
  automodAdminRepo,
  automodRuleListsRepo,
  automodRuleRepo,
  effectRepo,
  eligibilityRepo,
  enforcementGateRepo,
  guildRepo,
  jobRepo,
  loggingRepo,
  mcpSendRepo,
  modCaseRepo,
  modMatchReviewRepo,
  oauthRepo,
  panelRepo,
  type GuildScope,
  type InstanceScope,
} from '@bananasaurs/storage';
import {
  archiveBackfillDedupeKey,
  JOB_KINDS,
  type OpsInstance,
  type OpsPorts,
} from '@bananasaurs/core';

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
export const testPortsFor = (
  scope: GuildScope,
  now: () => number,
  /**
   * Whether this guild is in `BANANASAURS_ARCHIVE_GUILDS` (ADR 0046 D1).
   * Off by default — the same empty-by-default the config parses to — so a
   * route test that wants the archive has to say so.
   *
   * The instance-level handle, beside the guild scope rather than derived
   * from it: the two scopes are different types on purpose, and a derivation
   * would be the cast this prevents. Optional so the existing two-argument
   * call sites keep compiling; a test that reaches `grantAccountCapability`
   * must pass `t.scopes.instance()`, the same handle it builds for
   * `testInstanceFor`.
   */
  opts: { readonly archiveGuildEnabled?: boolean; readonly instanceScope?: InstanceScope } = {},
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
  listUnreviewedMatches: (query) =>
    modCaseRepo.listUnreviewedMatches(scope, query).map((match) => ({
      eventId: match.eventId,
      ruleId: match.ruleId,
      memberId: match.memberId,
      at: match.at,
      matchedCategory: match.matchedCategory,
      matchedSnippet: match.matchedSnippet,
      actionTaken: match.actionTaken,
      trace: match.trace,
      fixtureContent: match.fixtureContent,
    })),
  listUnreviewedNativeHits: (query) => automodAdminRepo.listUnreviewedNativeHits(scope, query),
  nativeBlockedCount: () => automodAdminRepo.countNativeBlocked(scope),

  // Slice 8's dashboard pages (Task 2): the same real-repo behaviour
  // `apps/daemon/src/ops/wiring.ts` wires, so route tests exercise real
  // reads and writes. Only `runAutomodDryRun` differs — a canned report
  // rather than a real replay (`toAutomodRule` lives in `apps/daemon` and
  // this package may not import it); the route test asserts pass-through.
  listAutomodRules: () => {
    const matchCounts = automodAdminRepo.countMatchesByRule(scope);
    const reviewedCounts = automodAdminRepo.countReviewedByRule(scope);
    const verdicts = automodAdminRepo.countVerdictsByRule(scope);
    return automodAdminRepo
      .listRules(scope)
      .map((rule) => testAutomodRuleSummary(rule, matchCounts, reviewedCounts, verdicts));
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
        automodAdminRepo.countVerdictsByRule(scope),
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
  recordMatchVerdict: (input) =>
    modMatchReviewRepo.recordVerdict(scope, { ...input, reviewedAt: now() }),
  setAutomodRuleReady: () => {
    throw new Error('not used by the dashboard routes under test');
  },
  recordAutomodSignOff: () => {
    throw new Error('not used by the dashboard routes under test');
  },
  addInviteAllowlistEntry: (input) => {
    const rule = automodRuleRepo.findRuleKindAndConfig(scope, input.ruleId);
    if (rule === undefined) return 'no-such-rule';
    if (rule.kind !== 'invite') return 'wrong-kind';
    const before = automodRuleListsRepo.listInviteAllowlist(scope, input.ruleId).length;
    automodRuleListsRepo.addInviteAllowlistEntry(scope, { ...input, now: now() });
    const after = automodRuleListsRepo.listInviteAllowlist(scope, input.ruleId).length;
    return after > before ? 'added' : 'already-present';
  },
  listInviteAllowlist: (ruleId) => automodRuleListsRepo.listInviteAllowlist(scope, ruleId),
  removeInviteAllowlistEntry: (input) => {
    const rule = automodRuleRepo.findRuleKindAndConfig(scope, input.ruleId);
    if (rule === undefined) return 'no-such-rule';
    if (rule.kind !== 'invite') return 'wrong-kind';
    const removed = automodRuleListsRepo.removeInviteAllowlistEntry(
      scope,
      input.ruleId,
      input.code,
    );
    return removed ? 'removed' : 'not-present';
  },
  addLinkDomain: (input) => {
    const rule = automodRuleRepo.findRuleKindAndConfig(scope, input.ruleId);
    if (rule === undefined) return { outcome: 'no-such-rule' };
    if (rule.kind !== 'link_domain') return { outcome: 'wrong-kind' };
    const mode = linkDomainModeOf(rule.config);
    const result = automodRuleListsRepo.addLinkDomain(scope, { ...input, now: now() });
    if (result.inserted) return { outcome: 'added', mode };
    const stored = automodRuleListsRepo
      .listLinkDomains(scope, input.ruleId)
      .find((entry) => entry.domain === result.domain);
    return { outcome: 'already-present', listType: stored?.listType ?? input.listType, mode };
  },
  listLinkDomains: (ruleId) => automodRuleListsRepo.listLinkDomains(scope, ruleId),
  removeLinkDomain: (input) => {
    const rule = automodRuleRepo.findRuleKindAndConfig(scope, input.ruleId);
    if (rule === undefined) return { outcome: 'no-such-rule' };
    if (rule.kind !== 'link_domain') return { outcome: 'wrong-kind' };
    const mode = linkDomainModeOf(rule.config);
    const removed = automodRuleListsRepo.removeLinkDomain(scope, input.ruleId, input.domain);
    return { outcome: removed ? 'removed' : 'not-present', mode };
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
  addAutomodAllowlistPhrase: (input) => {
    if (!automodRuleRepo.ruleExists(scope, input.ruleId)) return 'no-such-rule';
    if (automodRuleRepo.findRuleKindAndConfig(scope, input.ruleId)?.kind !== 'keyword_filter') {
      return 'wrong-kind';
    }
    // Canonicalised before comparing and storing: obscenity lower-cases the
    // input and searches it for the raw whitelisted term, so a stored phrase
    // with any uppercase letter (or stray spacing) could never match.
    const phrase = input.phrase.toLowerCase().trim().replace(/\s+/g, ' ');
    const stored = automodRuleRepo.findRuleIncludingDisabled(scope, input.ruleId);
    if (stored?.allowlist.includes(phrase)) return 'already-present';
    automodRuleRepo.addAllowlistPhrase(scope, { ruleId: input.ruleId, phrase });
    return 'added';
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

  // Archive (ADR 0046, Slice M1 Task 6): the same real-repo behaviour
  // `apps/daemon/src/ops/wiring.ts` wires, including the guild veto before
  // any write. `listUnreadableArchiveChannels` throws like the other members
  // that need a real Discord client, which this package may not import.
  archiveEnableChannel: (input) => {
    if (!(opts.archiveGuildEnabled ?? false)) return 'guild-not-archive-enabled';
    return archiveRepo.enableChannel(scope, {
      channelId: input.channelId,
      attachmentPolicy: input.attachmentPolicy,
      now: now(),
    });
  },
  archiveCategoryCoverage: () => ({ channels: 0, messages: 0 }),
  archiveEnableCategory: (input) => {
    if (!opts.archiveGuildEnabled === true) return 'guild-not-archive-enabled';
    return archiveRepo.enableChannel(scope, { ...input, scopeKind: 'category', now: now() });
  },
  archiveDisableCategory: (channelId) => {
    const messageCount = archiveRepo.countMessages(scope, channelId);
    const outcome = archiveRepo.disableChannel(scope, channelId);
    return outcome === 'disabled' ? { outcome, messageCount } : { outcome };
  },
  archiveSetThreads: (channelId, include) =>
    archiveRepo.setIncludeThreads(scope, channelId, include) ? 'updated' : 'not-enabled',
  archiveThreads: (channelId) => {
    const row = archiveRepo.findChannel(scope, channelId);
    return row === undefined ? undefined : { found: row.threadsFound, done: row.threadsDone };
  },
  archiveDisableChannel: (channelId) => {
    const messageCount = archiveRepo.countMessages(scope, channelId);
    const outcome = archiveRepo.disableChannel(scope, channelId);
    return outcome === 'disabled' ? { outcome, messageCount } : { outcome };
  },
  archiveStatus: () =>
    archiveRepo.listChannels(scope).map((channel) => ({
      ...channel,
      messageCount: archiveRepo.countMessages(scope, channel.channelId),
    })),
  archivePreserve: (messageId) => archiveRepo.markPreserve(scope, messageId),
  // `preserved` passes through as its own arm, the same as
  // `apps/daemon/src/ops/wiring.ts` — a preserved message is linked to no
  // case, and the audit row must say so.
  archiveLinkCase: (input) => archiveRepo.linkToCase(scope, input),
  enqueueArchiveBackfill: (channelId) => {
    jobRepo.enqueue(scope, {
      kind: JOB_KINDS.archiveBackfill,
      payload: JSON.stringify({ channelId }),
      dedupeKey: archiveBackfillDedupeKey(scope.guildId, channelId),
      now: now(),
    });
  },
  listUnreadableArchiveChannels: () => {
    throw new Error('not used by the dashboard routes under test — needs a real Discord client');
  },
  archiveIndexHealth: () => archiveSearchRepo.indexHealth(scope),
  // Same real-repo behaviour `apps/daemon/src/ops/wiring.ts` wires: the
  // visibility set is every archive-enabled channel in this guild, never the
  // caller's input.
  archiveSearch: (input) => {
    const visibleChannelIds = archiveRepo.listChannels(scope).map((channel) => channel.channelId);
    const result = archiveSearchRepo.searchMessages(scope, {
      query: input.query,
      visibility: { channelIds: visibleChannelIds },
      ...(input.channelId !== undefined && { channelIds: [input.channelId] }),
      ...(input.authorId !== undefined && { authorId: input.authorId }),
      ...(input.limit !== undefined && { limit: input.limit }),
    });
    return {
      total: result.total,
      hits: result.hits.map((hit) => ({
        messageId: hit.messageId,
        channelId: hit.channelId,
        authorId: hit.authorId,
        createdAt: hit.createdAt,
        excerpt: hit.excerpt,
      })),
    };
  },
  archiveReindex: () => archiveSearchRepo.rebuildSearchIndex(scope),
  // Slice M5 (ADR 0044 §4): the MCP send allowlist and send ledger, the same
  // real-repo behaviour `apps/daemon/src/ops/wiring.ts` wires. `now()` is this
  // composition root's clock, the same reasoning `recordMatchVerdict` gives.
  // No guild-membership check here: this package may not import a Discord
  // client (ADR 0014), and no dashboard route under test reaches this member —
  // the check lives in the daemon's `opsPortsFor`, which owns the client.
  allowSendChannel: (input) => {
    const added = mcpSendRepo.allowChannel(scope, {
      channelId: input.channelId,
      addedByAccountId: input.accountId,
      now: now(),
    });
    return added ? 'allowed' : 'already-allowed';
  },
  allowSendCategory: (input) => {
    const added = mcpSendRepo.allowChannel(scope, {
      channelId: input.channelId,
      addedByAccountId: input.accountId,
      scopeKind: 'category',
      now: now(),
    });
    return added ? 'allowed' : 'already-allowed';
  },
  disallowSendCategory: (channelId) => mcpSendRepo.disallowChannel(scope, channelId),
  sendScopeCoverage: () => 0,
  disallowSendChannel: (channelId) => mcpSendRepo.disallowChannel(scope, channelId),
  listSendAllowlist: () => mcpSendRepo.listAllowedChannels(scope),
  listSends: (input) =>
    mcpSendRepo.listSends(scope, { sinceMs: input.sinceMs, limit: input.limit }),
  // ADR 0028 / ADR 0045 (ruling PR-102): the same real-repo behaviour
  // `apps/daemon/src/ops/wiring.ts` wires, with the account lookup running
  // through `opts.instanceScope`.
  grantAccountCapability: (input) => {
    const instanceScope = opts.instanceScope;
    if (instanceScope === undefined) {
      throw new Error('grantAccountCapability needs opts.instanceScope: pass t.scopes.instance()');
    }
    const account = accountRepo.findAccountByUsername(instanceScope, input.username);
    if (account === undefined) return 'no-such-account';
    if (!accountRepo.hasGuildAccess(scope, account.accountId)) return 'no-guild-access';
    if (authzRepo.listAccountCapabilities(scope, account.accountId).includes(input.capability)) {
      return 'already-held';
    }
    authzRepo.grantAccountCapability(scope, {
      accountId: account.accountId,
      capability: input.capability,
      grantedBy: input.grantedBy,
      now: now(),
    });
    return 'granted';
  },
  // Slice 13 (S13-D1/D2): the same real-repo behaviour
  // `apps/daemon/src/ops/wiring.ts` wires — `findAccountByUsername` through
  // `opts.instanceScope`, then the guild-scoped access write. The pre-check
  // before each write is what turns "already had it" and "did not have it"
  // into answers rather than silent no-ops.
  accountGrantGuild: (username) => {
    const instanceScope = opts.instanceScope;
    if (instanceScope === undefined) {
      throw new Error('accountGrantGuild needs opts.instanceScope: pass t.scopes.instance()');
    }
    const account = accountRepo.findAccountByUsername(instanceScope, username);
    if (account === undefined) return 'no-such-account';
    if (accountRepo.hasGuildAccess(scope, account.accountId)) return 'already-had-it';
    accountRepo.grantGuildAccess(scope, account.accountId);
    return 'granted';
  },
  accountRevokeGuild: (username) => {
    const instanceScope = opts.instanceScope;
    if (instanceScope === undefined) {
      throw new Error('accountRevokeGuild needs opts.instanceScope: pass t.scopes.instance()');
    }
    const account = accountRepo.findAccountByUsername(instanceScope, username);
    if (account === undefined) return 'no-such-account';
    if (!accountRepo.hasGuildAccess(scope, account.accountId)) return 'did-not-have-it';
    accountRepo.revokeGuildAccess(scope, account.accountId);
    return 'revoked';
  },
});

/** One dashboard rule summary: the admin row plus this guild's match tallies. */
const testAutomodRuleSummary = (
  rule: ReturnType<typeof automodAdminRepo.listRules>[number],
  matchCounts: Readonly<Record<string, number>>,
  reviewedCounts: Readonly<Record<string, number>>,
  verdicts: Readonly<
    Record<string, { falsePositive: number; truePositive: number; unclear: number }>
  >,
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
  verdicts: verdicts[rule.ruleId] ?? { falsePositive: 0, truePositive: 0, unclear: 0 },
});

/** The case projection, shared by the three case reads. */
const linkDomainModeOf = (configJson: string): 'allow' | 'deny' | undefined => {
  try {
    const parsed = JSON.parse(configJson) as { mode?: unknown };
    return parsed.mode === 'allow' || parsed.mode === 'deny' ? parsed.mode : undefined;
  } catch {
    return undefined;
  }
};

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
  probePublicSurface: () =>
    Promise.resolve({
      probed: false,
      ok: true,
      text: 'public surface    not probed (MCP_PUBLIC_URL unset)',
      data: null,
    }),
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
  // ADR 0045: real implementations over the test database, the same way the
  // neighbouring `reissueBootstrapToken` reads `accountRepo` — so a route test
  // exercising the operator surface sees real OAuth rows, not stubs.
  mcpClients: () =>
    oauthRepo.listClients(instanceScope).map((row) => ({
      clientId: row.clientId,
      clientName: row.clientName,
      registrationSource: row.registrationSource,
      createdAt: row.createdAt,
      redirectUriCount: row.redirectUris.length,
    })),
  mcpTokens: () =>
    oauthRepo.listTokens(instanceScope).map((row) => ({
      tokenId: row.tokenId,
      kind: row.kind,
      clientId: row.clientId,
      accountId: row.accountId,
      createdAt: row.createdAt,
      expiresAt: row.expiresAt,
      revokedAt: row.revokedAt,
      lastUsedAt: row.lastUsedAt,
    })),
  mcpRevokeToken: (tokenId) => {
    const row = oauthRepo.findTokenById(instanceScope, tokenId);
    if (row === undefined) return undefined;
    return oauthRepo.revokeTokensFromCode(instanceScope, row.issuedFromCodeHash, now());
  },
  mcpRevokeClient: (clientId) => {
    if (oauthRepo.findClient(instanceScope, clientId) === undefined) return undefined;
    return oauthRepo.deleteClient(instanceScope, clientId, now());
  },
  // Canonical implementation: `providerEligibilityWarnings` in
  // `apps/daemon/src/ops/wiring.ts`; this is the same mapping against the
  // test database, field by field so no `evidenceUrl` crosses. One warning
  // per row, most serious first: `not-no` before `not-production` before
  // `stale` — a row that both trains on input and disallows production use
  // warns once, as `not-no`.
  providerEligibilityWarnings: (nowMs) => {
    const warnings: ReturnType<OpsInstance['providerEligibilityWarnings']>[number][] = [];
    for (const row of eligibilityRepo.listEligibility(instanceScope)) {
      if (!eligibilityRepo.isEligible(row)) {
        warnings.push({
          provider: row.provider,
          reason: 'not-no',
          trainsOnInput: row.trainsOnInput,
          reviewedAt: row.reviewedAt,
        });
      } else if (!row.productionUseAllowed) {
        warnings.push({
          provider: row.provider,
          reason: 'not-production',
          trainsOnInput: row.trainsOnInput,
          reviewedAt: row.reviewedAt,
        });
      } else if (nowMs - row.reviewedAt > eligibilityRepo.ELIGIBILITY_REVIEW_MAX_AGE_MS) {
        warnings.push({
          provider: row.provider,
          reason: 'stale',
          trainsOnInput: row.trainsOnInput,
          reviewedAt: row.reviewedAt,
        });
      }
    }
    return warnings;
  },
  // Ruling M4-D20: read first so the result carries the confirmed claims and
  // the previous review date, then write `reviewed_at` and nothing else.
  providerReview: (provider) => {
    const row = eligibilityRepo.findEligibility(instanceScope, provider);
    if (row === undefined) return 'no-such-provider';
    const at = now();
    eligibilityRepo.recordEligibilityReview(instanceScope, { provider, now: at });
    return {
      provider: row.provider,
      trainsOnInput: row.trainsOnInput,
      evidenceUrl: row.evidenceUrl,
      productionUseAllowed: row.productionUseAllowed,
      reviewedAt: at,
      previouslyReviewedAt: row.reviewedAt,
    };
  },
  // Canonical implementation: `accountOpsFor` in `apps/daemon/src/ops/wiring.ts`; this is the same mapping against the test database, field by field so no `passwordHash` crosses.
  accountList: () =>
    accountRepo.listAccounts(instanceScope).map((row) => ({
      accountId: row.accountId,
      username: row.username,
      isOwner: row.isOwner,
      disabled: row.disabled,
      lockedUntil: row.lockedUntil,
      createdAt: row.createdAt,
    })),
  accountSetDisabled: (username, disabled) => {
    const row = accountRepo.findAccountByUsername(instanceScope, username);
    if (row === undefined) return 'no-such-account';
    // Same race answer as the canonical implementation: a lookup followed by
    // no matched row is not a usage mistake.
    if (!accountRepo.setAccountDisabled(instanceScope, { accountId: row.accountId, disabled })) {
      return 'no-such-account';
    }
    return {
      changed: row.disabled !== disabled,
      username: row.username,
      isOwner: row.isOwner,
      disabled,
      lockedUntil: row.lockedUntil,
      enabledOwnersRemaining: accountRepo.countEnabledOwners(instanceScope),
    };
  },
  accountDelete: (username) => {
    const row = accountRepo.findAccountByUsername(instanceScope, username);
    if (row === undefined) return 'no-such-account';
    const result = accountRepo.deleteAccount(instanceScope, {
      accountId: row.accountId,
      now: now(),
    });
    // Same race answer as the canonical implementation (see above).
    if (!result.deleted) return 'no-such-account';
    return {
      username: row.username,
      accountId: row.accountId,
      wasOwner: row.isOwner,
      tokensRevoked: result.tokensRevoked,
      codesDeleted: result.codesDeleted,
      enabledOwnersRemaining: accountRepo.countEnabledOwners(instanceScope),
      accountsRemaining: accountRepo.countAccounts(instanceScope),
    };
  },
  accountRevokeCredentials: () => {
    throw new Error('not used by the dashboard routes under test');
  },
  // Slice 13 (S13-D3/D4): the operator CLI's password reset. Not a dashboard
  // route — and `testInstanceFor` has no `guildScopes` to sweep sessions
  // across, where the canonical `accountOpsFor` does — so this throws like
  // `accountRevokeCredentials` above rather than half-implementing the sweep.
  accountSetPassword: () => {
    throw new Error('not used by the dashboard routes under test');
  },
});
