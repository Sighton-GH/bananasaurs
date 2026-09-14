import { PermissionsBitField, type Client } from 'discord.js';
import {
  archiveBackfillDedupeKey,
  compileRule,
  JOB_KINDS,
  reconcileDedupeKey,
  redactConfig,
  runDryRun,
  undoDedupeKey,
  type Config,
  type OpsInstance,
  type OpsPorts,
  type OpsSettingChange,
} from '@bananasaurs/core';
import {
  accountRepo,
  archiveRepo,
  archiveSearchRepo,
  authzRepo,
  automodAdminRepo,
  automodFixtureRepo,
  automodRuleListsRepo,
  automodRuleRepo,
  effectRepo,
  enforcementGateRepo,
  guildRepo,
  jobRepo,
  listBackups,
  loggingRepo,
  modCaseRepo,
  modMatchReviewRepo,
  oauthRepo,
  panelRepo,
  roleRepo,
  type GuildScope,
  type InstanceScope,
} from '@bananasaurs/storage';
import { generateToken, hashToken, POLICY } from '@bananasaurs/http';
import { toAutomodRule } from '../automod/wiring.js';
import { countUndoable } from '../jobs/undo.js';
import type { BackupTimer } from '../runtime/backup-timer.js';
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
  /** A separate parameter rather than derived from the guild scope: the two scopes are different types on purpose, and a derivation would be the cast this prevents. */
  instanceScope: InstanceScope,
  operations: GuildOperations,
  now: () => number,
  client: Client,
  /**
   * Whether this guild is in `BANANASAURS_ARCHIVE_GUILDS` (ADR 0046 D1).
   *
   * A parameter rather than a config read: this module has no config of its
   * own, and the caller (`daemon.ts`'s `portsFor`) already holds it. Closed
   * over here so `archiveEnableChannel` can refuse before any write.
   */
  archiveGuildEnabled: boolean,
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

  listKeywordFilterRulesMissingManageMessages: () =>
    keywordFilterRulesMissingManageMessages(scope, client),

  // Compiles every enabled rule on every `doctor` call, which is correct
  // rather than a shortcut worth removing: `doctor` is human-invoked, not a
  // hot path, and compiling *is* the check (ADR 0040 §4) — inspecting the
  // config string without compiling it would not catch a `no-predicate` or
  // `compile-failed` rule at all.
  listUnusableAutomodRules: () =>
    automodRuleRepo
      .listEnabledRules(scope)
      .map((rule) => ({ rule, result: compileRule(rule) }))
      .filter(({ result }) => !result.ok)
      .map(({ rule, result }) => ({
        ruleId: rule.ruleId,
        kind: rule.kind,
        // Narrowed by the filter above; TypeScript cannot see that through
        // `.filter`, so this reads the discriminant again rather than casting.
        reason: result.ok ? '' : result.reason,
        detail: result.ok ? '' : result.detail,
      })),

  // ADR 0042 §3's two `doctor` checks (Task 6): the storage layer already
  // does the guild-scoped join work (`enforcementGateRepo`), so this is a
  // plain pass-through, the same shape `listUnassignableRoles` above uses.
  listAutomodRulesEnforcingWithBadCutoverState: () =>
    enforcementGateRepo.listEnforceRulesWithBadCutoverState(scope).map((row) => ({
      ruleId: row.ruleId,
      cutoverState: row.cutoverState,
    })),
  listAutomodRulesObservingPastWindowWithBacklog: (nowMs) =>
    enforcementGateRepo.listObservingRulesPastWindowWithBacklog(scope, nowMs).map((row) => ({
      ruleId: row.ruleId,
      observeStartedAt: row.observeStartedAt,
      unreviewedCount: row.unreviewedCount,
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

  // `listEnabledRules` returns only enabled rules — the honest thing to
  // dry-run, since a disabled rule is not going to match anything in
  // production either. Replaying a disabled rule is a repo function this
  // task does not add.
  //
  // Narrowed through `toAutomodRule`, not passed through: `runDryRun` builds a
  // predicate from this, and `ruleFingerprint` hashes the rule object's own
  // runtime keys. Handing it the repository row hashes ADR 0042's eight
  // gate columns too, which is harmless here only because a dry run uses a
  // fresh cache — the same widening the subscriber's wiring already closed, and
  // not worth leaving open in a second place for a reader to have to re-derive.
  findAutomodRule: (ruleId) =>
    automodRuleRepo
      .listEnabledRules(scope)
      .map(toAutomodRule)
      .find((r) => r.ruleId === ruleId),
  listAutomodFixtures: (filter) => automodFixtureRepo.listFixtures(scope, filter),
  listUnreviewedMatches: (query) => modCaseRepo.listUnreviewedMatches(scope, query),
  listUnreviewedNativeHits: (query) => automodAdminRepo.listUnreviewedNativeHits(scope, query),
  nativeBlockedCount: () => automodAdminRepo.countNativeBlocked(scope),

  // Slice 8's dashboard pages (Task 2). The `/automod` rules list and the
  // `/cutover` board read summaries; `/automod/:ruleId` reads the detail and
  // dry-runs it; `/cases`, `/cases/:caseId` and `/members/:memberId` read
  // cases. The two tallies come from `automodAdminRepo`'s grouped counts, so
  // a list is three reads, not one per rule.
  listAutomodRules: () => {
    const matchCounts = automodAdminRepo.countMatchesByRule(scope);
    const reviewedCounts = automodAdminRepo.countReviewedByRule(scope);
    const verdicts = automodAdminRepo.countVerdictsByRule(scope);
    return automodAdminRepo
      .listRules(scope)
      .map((rule) => automodRuleSummary(rule, matchCounts, reviewedCounts, verdicts));
  },
  findAutomodRuleDetail: (ruleId) => {
    const rule = automodAdminRepo.findRule(scope, ruleId);
    if (rule === undefined) return undefined;
    // The relational lists live on the hydrated rule, which `findRule` does
    // not carry — read them through the one function that assembles them for
    // a rule regardless of `enabled`.
    const stored = automodRuleRepo.findRuleIncludingDisabled(scope, ruleId);
    return {
      ...automodRuleSummary(
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
  // A disabled rule **may** be dry-run from the dashboard (Slice 8, PR-47):
  // an operator edits a disabled rule, dry-runs it, then enables it. The
  // CLI's enabled-only `findAutomodRule` above is unchanged.
  runAutomodDryRun: (ruleId) => {
    const stored = automodRuleRepo.findRuleIncludingDisabled(scope, ruleId);
    if (stored === undefined) return 'no-such-rule';
    return runDryRun({
      guildId: scope.guildId,
      rule: toAutomodRule(stored),
      fixtures: automodFixtureRepo.listFixtures(scope, {}),
    });
  },
  listRecentCases: (query) =>
    automodAdminRepo.listRecentCases(scope, { limit: query.limit }).map(opsCaseRow),
  findCaseDetail: (caseId) => {
    const found = automodAdminRepo.findCase(scope, caseId);
    if (found === undefined) return undefined;
    return {
      case: opsCaseRow(found),
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
  listCasesForMember: (memberId) => modCaseRepo.listCasesForMember(scope, memberId).map(opsCaseRow),

  // --- write commands (13d) --------------------------------------------------
  applySetting: (change) => applySetting(scope, change, now()),
  recordMatchVerdict: (input) =>
    // `reviewedAt` comes from this composition root's clock, not from the
    // command: a command does not get to choose when it happened, the same
    // way it does not get to choose its own audit attribution.
    modMatchReviewRepo.recordVerdict(scope, { ...input, reviewedAt: now() }),

  // `automod ready` / `automod signoff` (ADR 0042 §3/§4, Task 6). The clock is
  // this composition root's, not the command's, the same reasoning
  // `recordMatchVerdict` above gives.
  setAutomodRuleReady: (ruleId) => automodRuleRepo.setRuleReady(scope, { ruleId, now: now() }),
  recordAutomodSignOff: (input) =>
    automodRuleRepo.setEnforceSignOff(scope, { ...input, now: now() }),

  // Plan ruling PR-19 (Task 9): a CLI write path for the two relational
  // lists Task 6 built with no caller. `findRuleKindAndConfig` replaces a
  // bare `ruleExists` check (IMPORTANT-7, review of Slices 3+5):
  // `ruleExists` answers only "does this id name a rule", so a rule id that
  // exists but is the wrong kind — a `keyword_filter` rule handed to
  // `invite-allow` — used to write a row nothing will ever read.
  // `'no-such-rule'` and `'wrong-kind'` are both usage answers, not faults —
  // the composite foreign key would otherwise surface an opaque `FOREIGN KEY
  // constraint failed` for the first, and the second is caught here because
  // nothing else in the write path knows to.
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
  // `addLinkDomain`/`removeLinkDomain` return the repository's own
  // `inserted`/`changes` result rather than a before/after count
  // (IMPORTANT-1): re-adding a domain under the *other* `listType` is also a
  // no-op on the same primary key, and only the repository — which just
  // canonicalised the domain to do the write — can say which `listType` is
  // actually stored without duplicating that canonicalisation here (the same
  // drift that let `removeLinkDomain` compare verbatim while `addLinkDomain`
  // canonicalised, IMPORTANT-2, is what this avoids re-introducing).
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
    // `stored` is always found in practice — the row that blocked the insert
    // is the row `listLinkDomains` just re-read — but a fallback to the
    // operator's requested `listType` keeps this total rather than throwing
    // on a data race this port cannot otherwise observe.
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

  // Slice 8's dashboard writes (Task 2): the `/automod` new-rule form, the
  // `/automod/:ruleId` config editor, mode dialog and exemptions section.
  // `ruleExists` guards first in every member that names a rule id, so a
  // mistyped id is a usage answer, never a thrown constraint error — the
  // same treatment `addInviteAllowlistEntry` above gives `'no-such-rule'`.
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
    // Conditional spreads, not `mode: input.mode` directly:
    // `exactOptionalPropertyTypes` treats an explicit `undefined` as distinct
    // from the property being absent.
    return automodRuleRepo.setRuleMode(scope, {
      ruleId: input.ruleId,
      ...(input.mode !== undefined && { mode: input.mode }),
      ...(input.enabled !== undefined && { enabled: input.enabled }),
      now: now(),
    });
  },
  // A pre-check rather than the before/after count `addInviteAllowlistEntry`
  // above uses: the pair either exists or it does not, and checking first
  // never lets the `INSERT` throw.
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
  // One-click suppression from the review queue (Slice 9): the repo's
  // `addAllowlistPhrase` is a bare `INSERT` that throws on a duplicate, so
  // the pre-check against the hydrated rule's allowlist is load-bearing.
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

  // --- archive (ADR 0046, Slice M1 Task 6) ------------------------------------
  // `archiveEnableChannel` refuses before any write when the guild is not in
  // `BANANASAURS_ARCHIVE_GUILDS` — the subscriber enforces the same veto on
  // the read path, so a row written by hand still archives nothing.
  archiveEnableChannel: (input) => {
    if (!archiveGuildEnabled) return 'guild-not-archive-enabled';
    return archiveRepo.enableChannel(scope, {
      channelId: input.channelId,
      attachmentPolicy: input.attachmentPolicy,
      now: now(),
    });
  },
  archiveDisableChannel: (channelId) => {
    // Counted before the delete: the cascade below removes the rows, and the
    // audit trail should say how many went with the channel.
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
  // `preserve` outranks any case link, and the port names it as its own
  // `'preserved'` arm rather than folding it into `'already-linked'` — a
  // preserved message is linked to no case, and the audit row must say so.
  archiveLinkCase: (input) => archiveRepo.linkToCase(scope, input),
  enqueueArchiveBackfill: (channelId) => {
    jobRepo.enqueue(scope, {
      kind: JOB_KINDS.archiveBackfill,
      payload: JSON.stringify({ channelId }),
      dedupeKey: archiveBackfillDedupeKey(scope.guildId, channelId),
      now: now(),
    });
  },
  listUnreadableArchiveChannels: () => unreadableArchiveChannels(scope, client),
  archiveIndexHealth: () => archiveSearchRepo.indexHealth(scope),
  // The operator sees what the archive holds, nothing wider: the visibility
  // set is every archive-enabled channel in this guild, built here from
  // `listChannels` — never from the caller's input. A `channelId` narrows
  // within that set (the repository returns empty for one outside it); `rank`
  // is dropped at this boundary but the best-first order is kept.
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

  // ADR 0028 / ADR 0045 (ruling PR-102): grant a dashboard account a
  // capability in this guild. `findAccountByUsername` is instance-level while
  // this port is guild-scoped, so the account lookup runs through the
  // `instanceScope` parameter above. The grant itself is guild-scoped, and
  // the composite foreign key would refuse an account without guild access —
  // `hasGuildAccess` is checked first so the operator hears why, not a
  // constraint error.
  grantAccountCapability: (input) => {
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
 * A `link_domain` rule's configured `mode`, read from its raw `config` JSON
 * for display only (CRITICAL-2, review of Slices 3+5) — `domain-add` and
 * `domain-rm` need it to say what an empty active list means, and they have
 * only the rule id.
 *
 * Deliberately tolerant rather than a Zod parse: `ports.ts` may not import
 * `@bananasaurs/core`'s predicate registry here just to read one field for a
 * status line (ADR 0014 is about the storage package, not this composition
 * root, but there is still no reason to couple a display string to the full
 * schema), and a rule whose config fails real validation already gets its
 * own report from `compileRule`/`doctor` — this returns `undefined` rather
 * than throwing, so a malformed config degrades the message instead of the
 * command.
 */
const linkDomainModeOf = (configJson: string): 'allow' | 'deny' | undefined => {
  try {
    const parsed = JSON.parse(configJson) as { mode?: unknown };
    return parsed.mode === 'allow' || parsed.mode === 'deny' ? parsed.mode : undefined;
  } catch {
    return undefined;
  }
};

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

/**
 * `doctor`'s automod half: for every enabled, enforce-mode `keyword_filter`
 * rule, every channel it is not exempted from where the bot's cached
 * permissions do not include `Manage Messages`.
 *
 * A live check against `client.guilds.cache`, the same "already in memory,
 * nothing to fetch" style `doctor.ts`'s `inspectGuild` uses for its own
 * permission bits — deliberately, since this runs on every `doctor` call and
 * a REST round trip per channel would make the command slow in proportion to
 * how many channels the guild has, for a fact the gateway cache already
 * holds. `permissionsIn` folds channel-specific overwrites on top of the
 * role-derived base, which a guild-level check (`REQUIRED_PERMISSIONS`)
 * cannot see — an overwrite is exactly the kind of drift this check exists
 * to catch (ADR 0035 §6).
 *
 * Threads-and-forums aside, `isTextBased` also covers voice and stage
 * channels' text chat, which `deleteMessage` reaches the same way a normal
 * text channel does — excluding them would silently under-report.
 */
const keywordFilterRulesMissingManageMessages = (
  scope: GuildScope,
  client: Client,
): readonly { ruleId: string; channelId: string }[] => {
  const rules = automodRuleRepo.listEnforceModeKeywordFilterRules(scope);
  if (rules.length === 0) return [];

  const guild = client.guilds.cache.get(scope.guildId);
  // Not present in the cache (not yet READY, or left the guild entirely) is
  // itself a finding elsewhere in `doctor` (the gateway half's `g.present`) —
  // this check stays silent rather than reporting a channel list it cannot
  // actually see.
  if (guild === undefined) return [];
  const me = guild.members.me;
  if (me === null) return [];

  const channels = [...guild.channels.cache.values()].filter(
    (channel) => channel.isTextBased() && !channel.isThread(),
  );

  const missing: { ruleId: string; channelId: string }[] = [];
  for (const rule of rules) {
    for (const channel of channels) {
      if (rule.exemptChannelIds.includes(channel.id)) continue;
      if (!me.permissionsIn(channel).has(PermissionsBitField.Flags.ManageMessages)) {
        missing.push({ ruleId: rule.ruleId, channelId: channel.id });
      }
    }
  }
  return missing;
};

/**
 * `doctor`'s archive check (ADR 0046 D1, Slice M1 Task 6): every enabled
 * archive channel the bot cannot read, and why.
 *
 * The same "already in memory, nothing to fetch" style as
 * `keywordFilterRulesMissingManageMessages` above — this runs on every
 * `doctor` call and the gateway cache already holds the answer.
 * `permissionsIn` folds channel-specific overwrites on top of the
 * role-derived base, which a guild-level check cannot see.
 */
const unreadableArchiveChannels = (
  scope: GuildScope,
  client: Client,
): readonly { channelId: string; reason: 'missing' | 'no-view' | 'no-history' }[] => {
  const channels = archiveRepo.listChannels(scope);
  if (channels.length === 0) return [];

  const guild = client.guilds.cache.get(scope.guildId);
  // Same treatment as `keywordFilterRulesMissingManageMessages`: not present
  // in the cache is itself a finding elsewhere in `doctor`, so this check
  // stays silent rather than reporting a channel list it cannot see.
  if (guild === undefined) return [];
  const me = guild.members.me;
  if (me === null) return [];

  const unreadable: { channelId: string; reason: 'missing' | 'no-view' | 'no-history' }[] = [];
  for (const { channelId } of channels) {
    const channel = guild.channels.cache.get(channelId);
    if (channel === undefined) {
      unreadable.push({ channelId, reason: 'missing' });
      continue;
    }
    const permissions = me.permissionsIn(channel);
    if (!permissions.has(PermissionsBitField.Flags.ViewChannel)) {
      unreadable.push({ channelId, reason: 'no-view' });
    } else if (!permissions.has(PermissionsBitField.Flags.ReadMessageHistory)) {
      unreadable.push({ channelId, reason: 'no-history' });
    }
  }
  return unreadable;
};

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

/**
 * One dashboard rule summary: the admin row plus this guild's match and
 * reviewed tallies. Shared by `listAutomodRules` and `findAutomodRuleDetail`.
 * The return type is inferred — `OpsPorts` checks it at each use.
 */
const automodRuleSummary = (
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
const opsCaseRow = (found: ReturnType<typeof automodAdminRepo.listRecentCases>[number]) => ({
  caseId: found.caseId,
  memberId: found.memberId,
  openedAt: found.openedAt,
  violationCount: found.violationCount,
  escalationTier: found.escalationTier,
  status: found.status,
});

export interface OpsInstanceDeps {
  readonly config: Config;
  readonly client: Client;
  readonly startedAtMs: number;
  /**
   * Instance-level storage, for `bootstrap reissue` (ADR 0027).
   *
   * Separate from the guild scopes every other port closes over, because
   * `dashboard_accounts` and `bootstrap_tokens` carry no guild id — and the
   * type says so, so this cannot be quietly used for a guild-scoped query.
   */
  readonly instanceScope: InstanceScope;
  /** Injected, like every clock in this tree. Slice 13e found the bug. */
  readonly now: () => number;
  /** `backup now` and `backup list` (ADR 0034, slice 16). */
  readonly backupTimer: BackupTimer;
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
      const report = buildDoctorReport(deps.client, deps.config, deps.now());
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

  /**
   * ADR 0012's recovery path, wired (slice 14).
   *
   * The refusals are decided here rather than in the command because both are
   * facts about *this process and this database* — how many accounts exist, and
   * whether the process can write at all. The command turns them into an
   * operator-readable message; it does not get to decide them.
   *
   * The readonly check is explicit rather than left to `writeInstance` throwing.
   * A caught `ReadonlyError` would work, but "the recovery command refuses in
   * read-only mode" is a rule worth stating where someone reading this can see
   * it, rather than an exception path they have to infer.
   */
  reissueBootstrapToken: () => {
    const accountCount = accountRepo.countAccounts(deps.instanceScope);
    if (accountCount > 0) return { ok: false, reason: 'accounts-exist', accountCount };
    if (deps.config.BANANASAURS_READONLY) return { ok: false, reason: 'readonly' };

    const token = generateToken();
    const row = accountRepo.issueBootstrapToken(deps.instanceScope, {
      // sha256, not Argon2id: the input is 256 bits of uniform randomness, so a
      // work factor would slow down nobody but us. `hashToken` is the same
      // function the API verifies with — imported rather than reimplemented,
      // because a token issued here and checked there must agree, and two
      // one-line hashes that drift produce a setup link that is simply
      // rejected with nothing saying why.
      tokenHash: hashToken(token),
      now: deps.now(),
      ttlMs: POLICY.bootstrapTtlMs,
    });
    return { ok: true, token, expiresAt: row.expiresAt, port: deps.config.DASHBOARD_PORT };
  },

  backupNow: () => {
    const result = deps.backupTimer.runOnce();
    if (!result.ok) return { ok: false, error: result.error };
    return {
      ok: true,
      fileName: result.backup.fileName,
      sizeBytes: result.backup.sizeBytes,
      sha256: result.backup.sha256,
      prunedCount: result.pruned.length,
    };
  },

  backupList: () =>
    listBackups(deps.config.BANANASAURS_BACKUP_DIR).map((backup) => ({
      fileName: backup.fileName,
      sizeBytes: backup.sizeBytes,
      createdAtMs: backup.createdAt.getTime(),
      hasChecksum: backup.hasChecksum,
    })),

  // ADR 0045: the operator's view of the OAuth tables. Instance-level, the
  // same reason `reissueBootstrapToken` is — a client is registered against
  // the daemon and a token carries no guild — so these read `deps.instanceScope`
  // directly. Projections are field by field: `ports.ts` may not import
  // `@bananasaurs/storage` (ADR 0014), and a token value never crosses this
  // boundary at all (there is no value to project; only the hash is stored).
  mcpClients: () =>
    oauthRepo.listClients(deps.instanceScope).map((row) => ({
      clientId: row.clientId,
      clientName: row.clientName,
      registrationSource: row.registrationSource,
      createdAt: row.createdAt,
      redirectUriCount: row.redirectUris.length,
    })),
  mcpTokens: () =>
    oauthRepo.listTokens(deps.instanceScope).map((row) => ({
      tokenId: row.tokenId,
      kind: row.kind,
      clientId: row.clientId,
      accountId: row.accountId,
      createdAt: row.createdAt,
      expiresAt: row.expiresAt,
      revokedAt: row.revokedAt,
      lastUsedAt: row.lastUsedAt,
    })),
  mcpRevokeToken: (tokenId) => oauthRepo.revokeToken(deps.instanceScope, tokenId, deps.now()) === 1,
  // `deleteClient` returns 0 for an unknown client and a count otherwise, so
  // existence is checked first: the port must answer `undefined` for "no such
  // client" rather than "0 tokens revoked", which would read as a success that
  // removed nothing.
  mcpRevokeClient: (clientId) => {
    if (oauthRepo.findClient(deps.instanceScope, clientId) === undefined) return undefined;
    return oauthRepo.deleteClient(deps.instanceScope, clientId, deps.now());
  },
});
