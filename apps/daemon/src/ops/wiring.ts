import { randomBytes } from 'node:crypto';
import { ChannelType, PermissionsBitField, type Client, type GuildMember } from 'discord.js';
import {
  archiveBackfillDedupeKey,
  compileRule,
  isDangerousRole,
  JOB_KINDS,
  reconcileDedupeKey,
  redactConfig,
  undoDedupeKey,
  type Config,
  type OpsGuildMemberInfo,
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
  automodRuleListsRepo,
  automodRuleRepo,
  channelReadRepo,
  effectRepo,
  eligibilityRepo,
  guildRepo,
  jobRepo,
  listBackups,
  loggingRepo,
  mcpSendRepo,
  mcpRolePolicyRepo,
  modCaseRepo,
  modMatchReviewRepo,
  oauthRepo,
  panelRepo,
  roleRepo,
  sessionRepo,
  type GuildScope,
  type InstanceScope,
} from '@bananasaurs/storage';
import { generateToken, hashPassword, hashToken, POLICY } from '@bananasaurs/http';
import { excludedThreadIds, noAccessFromCache } from '../channels/access.js';
import { countUndoable } from '../jobs/undo.js';
import type { BackupTimer } from '../runtime/backup-timer.js';
import type { PasswordVault } from './password-vault.js';
import {
  buildDoctorReport,
  formatDoctorReport,
  type DoctorDashboardAccess,
  type DoctorPasswordVault,
} from '../runtime/doctor.js';
import {
  formatPublicSurface,
  probePublicSurface as runPublicSurfaceProbe,
} from '../runtime/public-surface.js';
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
export const fetchInHundredIdChunks = async <T>(
  userIds: readonly string[],
  fetchChunk: (ids: readonly string[]) => Promise<readonly T[]>,
): Promise<T[]> => {
  const results: T[] = [];
  for (let start = 0; start < userIds.length; start += 100) {
    try {
      results.push(...(await fetchChunk(userIds.slice(start, start + 100))));
    } catch {
      // Preserve confirmed members from earlier chunks. A later REST failure
      // must not erase useful names already fetched.
      break;
    }
  }
  return results;
};

/**
 * ADR 0126 Task 9: archived-history visibility for the ops read ports — an
 * archive row exists (any kind, paused or not: pausing keeps history
 * searchable by owner decision) and the channel is not No-access.
 * Synchronous: both halves are sync reads (the repository, the channel
 * cache), so the ports below stay synchronous.
 */
const canSearchArchived = (client: Client, scope: GuildScope, channelId: string): boolean =>
  archiveRepo.hasArchivedChannel(scope, channelId) && !noAccessFromCache(client, scope, channelId);

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
  setAutomodState: (state) => guildRepo.setAutomodState(scope, state, now()),
  listEnabledAutomodRuleNames: () =>
    automodAdminRepo
      .listRules(scope)
      .filter((rule) => rule.enabled)
      .map((rule) => ({ ruleId: rule.ruleId, name: rule.name })),

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
      content: panel.content,
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

  listRoutes: () =>
    loggingRepo.listRoutes(scope).map((route) => ({
      routeId: route.routeId,
      name: route.name,
      channelId: route.channelId,
      enabled: route.enabled,
      includeContent: route.includeContent,
      createdAtMs: route.createdAtMs,
      eventKinds: route.eventKinds,
      excludedChannelIds: route.excludedChannelIds,
    })),

  getRoute: (routeId) => {
    const route = loggingRepo.getRoute(scope, routeId);
    if (route === undefined) return undefined;
    return {
      routeId: route.routeId,
      name: route.name,
      channelId: route.channelId,
      enabled: route.enabled,
      includeContent: route.includeContent,
      createdAtMs: route.createdAtMs,
      eventKinds: route.eventKinds,
      excludedChannelIds: route.excludedChannelIds,
    };
  },

  listExcludedChannels: () => loggingRepo.listExcludedChannels(scope),

  findJob: (jobId) => {
    const job = jobRepo.findJob(scope, jobId);
    return job === undefined ? undefined : jobRow(job);
  },

  listUnreviewedMatches: (query) => modCaseRepo.listUnreviewedMatches(scope, query),
  listUnreviewedNativeHits: (query) => automodAdminRepo.listUnreviewedNativeHits(scope, query),
  nativeBlockedCount: () => automodAdminRepo.countNativeBlocked(scope),

  // Slice 8's dashboard pages (Task 2). The `/automod` rules list reads
  // summaries; `/automod/:ruleId` reads the detail; `/cases`, `/cases/:caseId` and `/members/:memberId` read
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
    };
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
  setAutomodRuleEnabled: (input) =>
    automodRuleRepo.setRuleEnabled(scope, { ...input, now: now() }) ? 'ok' : 'no-such-rule',
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

  createRoute: (input) => {
    const route = loggingRepo.createRoute(scope, { ...input, nowMs: now() });
    return {
      routeId: route.routeId,
      name: route.name,
      channelId: route.channelId,
      enabled: route.enabled,
      includeContent: route.includeContent,
      createdAtMs: route.createdAtMs,
      eventKinds: route.eventKinds,
      excludedChannelIds: route.excludedChannelIds,
    };
  },
  updateRoute: (routeId, input) => {
    const route = loggingRepo.updateRoute(scope, routeId, input);
    if (route === undefined) return undefined;
    return {
      routeId: route.routeId,
      name: route.name,
      channelId: route.channelId,
      enabled: route.enabled,
      includeContent: route.includeContent,
      createdAtMs: route.createdAtMs,
      eventKinds: route.eventKinds,
      excludedChannelIds: route.excludedChannelIds,
    };
  },
  setRouteEnabled: (routeId, enabled) => loggingRepo.setRouteEnabled(scope, routeId, enabled),
  deleteRoute: (routeId) => loggingRepo.deleteRoute(scope, routeId),
  excludeChannel: (channelId) => loggingRepo.excludeChannel(scope, channelId),
  unexcludeChannel: (channelId) => loggingRepo.unexcludeChannel(scope, channelId),

  retryJob: (jobId) => {
    const outcome = jobRepo.retryJob(scope, jobId, now());
    // Projected field by field rather than passed through: the repository's
    // success case carries the whole job row, and the port's does not need it.
    return outcome.ok ? { ok: true } : outcome;
  },

  // Storage-only write: `panel create` and the dashboard builder both land
  // here. Nothing reaches Discord — publishing stays publishPanel's job.
  createPanel: (definition, newlyAllowlistedRoleIds) =>
    operations.createPanel(definition, newlyAllowlistedRoleIds),
  // Storage-only write, like `createPanel` above: `panel edit` replaces the
  // definition, and the change goes live with `panel sync`.
  updatePanel: (definition, newlyAllowlistedRoleIds) =>
    operations.updatePanel(definition, newlyAllowlistedRoleIds),
  isManagedRole: (roleId) => roleRepo.findManagedRole(scope, roleId) !== undefined,
  allowlistRole: (roleId) => roleRepo.allowlistRole(scope, roleId),

  // --- write commands that reach Discord (13e, ADR 0026) ---------------------
  publishPanel: (panelId) => operations.publishPanel(panelId),
  // `panel delete`: the message first, then the rows, so a Discord failure
  // leaves the rows for a retry.
  unpublishPanel: (panelId) => operations.unpublishPanel(panelId),
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
  archiveCategoryCoverage: (channelId) => {
    const guild = client.guilds.cache.get(scope.guildId);
    const covered =
      guild === undefined
        ? []
        : [...guild.channels.cache.values()].filter(
            (channel) => !channel.isThread() && channel.parentId === channelId,
          );
    return {
      channels: covered.length,
      messages: covered.reduce(
        (sum, channel) => sum + archiveRepo.countMessages(scope, channel.id),
        0,
      ),
    };
  },
  archiveEnableCategory: (input) => {
    if (!archiveGuildEnabled) return 'guild-not-archive-enabled';
    // Review S2: the id must name a category of this guild, resolved from
    // the live cache — without this a plain channel id wrote a `category`
    // scope row whose "coverage" was a type error.
    const target = client.guilds.cache.get(scope.guildId)?.channels.cache.get(input.channelId);
    if (target?.type !== ChannelType.GuildCategory) return 'no-such-channel';
    const outcome = archiveRepo.enableChannel(scope, {
      ...input,
      scopeKind: 'category',
      now: now(),
    });
    if (outcome === 'enabled') {
      const guild = client.guilds.cache.get(scope.guildId);
      for (const channel of guild?.channels.cache.values() ?? []) {
        if (!channel.isThread() && channel.parentId === input.channelId) {
          // Review B2: materialize the derived row now so the backfill job
          // below has a row to cursor against; the job still re-checks live
          // category membership when it runs.
          archiveRepo.ensureDerivedChannel(scope, {
            channelId: channel.id,
            categoryId: input.channelId,
            attachmentPolicy: input.attachmentPolicy,
            now: now(),
          });
          jobRepo.enqueue(scope, {
            kind: JOB_KINDS.archiveBackfill,
            payload: JSON.stringify({ channelId: channel.id }),
            dedupeKey: archiveBackfillDedupeKey(scope.guildId, channel.id),
            runAfter: now(),
            now: now(),
          });
        }
      }
    }
    return outcome;
  },
  archiveDisableCategory: (channelId) => archiveRepo.disableCategory(scope, channelId),
  archivePauseChannel: (channelId) => {
    const row = archiveRepo.findChannel(scope, channelId);
    if (row === undefined) return 'not-enabled';
    if (row.scopeKind === 'category') return 'wrong-kind';
    if (row.scopeKind === 'derived') return 'derived';
    return archiveRepo.pauseChannel(scope, channelId);
  },
  archiveResumeChannel: (channelId) => {
    const row = archiveRepo.findChannel(scope, channelId);
    if (row === undefined) return 'not-enabled';
    if (row.scopeKind === 'category') return 'wrong-kind';
    if (row.scopeKind === 'derived') return 'derived';
    return archiveRepo.resumeChannel(scope, channelId);
  },
  archivePauseCategory: (channelId) => {
    const target = client.guilds.cache.get(scope.guildId)?.channels.cache.get(channelId);
    if (target?.type !== ChannelType.GuildCategory) return 'no-such-channel';
    const row = archiveRepo.findChannel(scope, channelId);
    if (row?.scopeKind === 'channel') return 'not-enabled';
    if (row?.scopeKind === 'derived') return 'derived';
    return archiveRepo.pauseChannel(scope, channelId);
  },
  archiveResumeCategory: (channelId) => {
    const target = client.guilds.cache.get(scope.guildId)?.channels.cache.get(channelId);
    if (target?.type !== ChannelType.GuildCategory) return 'no-such-channel';
    const row = archiveRepo.findChannel(scope, channelId);
    if (row?.scopeKind === 'channel') return 'not-enabled';
    if (row?.scopeKind === 'derived') return 'derived';
    return archiveRepo.resumeChannel(scope, channelId);
  },
  archiveSetThreads: (channelId, include) => {
    const channel = client.guilds.cache.get(scope.guildId)?.channels.cache.get(channelId);
    if (!include && channel?.type === ChannelType.GuildForum) return 'forum-requires-all';
    return archiveRepo.setIncludeThreads(scope, channelId, include) ? 'updated' : 'not-enabled';
  },
  archiveThreads: (channelId) => {
    const row = archiveRepo.findChannel(scope, channelId);
    return row === undefined ? undefined : { found: row.threadsFound, done: row.threadsDone };
  },
  archiveDisableChannel: (channelId) => {
    // Counted before the delete: the cascade below removes the rows, and the
    // audit trail should say how many went with the channel.
    const messageCount = archiveRepo.countMessages(scope, channelId);
    const outcome = archiveRepo.disableChannel(scope, channelId);
    if (outcome !== 'derived') {
      return outcome === 'disabled' ? { outcome, messageCount } : { outcome };
    }
    const channel = client.guilds.cache.get(scope.guildId)?.channels.cache.get(channelId);
    const categoryId =
      channel !== undefined && 'parentId' in channel ? (channel.parentId ?? undefined) : undefined;
    if (categoryId !== undefined && archiveRepo.hasCategoryRow(scope, categoryId)) {
      return { outcome: 'covered-by-category', categoryId };
    }
    // Orphaned: the channel moved out of the category, so archiving already
    // stopped and only the retained history is left to destroy.
    const removed = archiveRepo.disableDerivedChannel(scope, channelId);
    return removed.outcome === 'disabled'
      ? { outcome: 'disabled', messageCount: removed.messageCount }
      : { outcome: 'not-enabled' };
  },
  archiveStatus: () =>
    archiveRepo.listChannels(scope).map((channel) => ({
      ...channel,
      messageCount: archiveRepo.countMessages(scope, channel.channelId),
    })),
  // Review 2 N1: a derived row is coverage, and coverage is a live cache
  // fact, so only here can the two cases be told apart — still covered (no
  // delete: the next message re-materialises the row) versus orphaned by a
  // channel that moved out (deletable, which is the choice ADR 0047's
  // amendment says the operator has).
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
  // The named pickers' channel list, straight from the gateway cache: text,
  // announcement and forum channels with their display names. Empty before
  // READY (or after leaving), which the picker shows as its honest loading
  // state rather than a fabricated list.
  listGuildChannels: () => {
    const guild = client.guilds.cache.get(scope.guildId);
    if (guild === undefined) return [];
    const kindOf = (type: ChannelType): string => {
      if (type === ChannelType.GuildCategory) return 'category';
      if (type === ChannelType.GuildForum || type === ChannelType.GuildMedia) return 'forum';
      if (type === ChannelType.GuildAnnouncement) return 'announcement';
      return 'text';
    };
    // Categories ride along with the text-capable channels: the category
    // pickers (archive scope, MCP send allowlist) filter on kind, and the
    // text pickers exclude them, so one cache read serves both.
    return [...guild.channels.cache.values()]
      .filter(
        (channel) =>
          channel.type === ChannelType.GuildCategory ||
          (channel.isTextBased() && !channel.isThread()),
      )
      .map((channel) => ({
        channelId: channel.id,
        name: channel.name,
        kind: kindOf(channel.type),
        ...(channel.parentId !== null ? { parentId: channel.parentId } : {}),
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
  },
  inspectTaskChannel: async (channelId) => {
    const guild = client.guilds.cache.get(scope.guildId);
    if (!guild) return undefined;
    try {
      // A cache hit alone is not current authority: fetch the destination and its parent.
      const channel = await guild.channels.fetch(channelId, { force: true });
      if (!channel || !channel.isTextBased()) return undefined;
      if (channel.isThread()) {
        // Private threads are never task destinations: the bot cannot rely on
        // seeing them, so they return the existing invalid-destination answer.
        if (channel.type === ChannelType.PrivateThread) return undefined;
        if (!channel.parentId) return undefined;
        const parent = await guild.channels.fetch(channel.parentId, { force: true });
        if (!parent || parent.isThread() || !parent.parentId) return undefined;
        return {
          channelId,
          kind: 'thread' as const,
          parentId: parent.id,
          categoryId: parent.parentId,
        };
      }
      return {
        channelId,
        kind: 'channel' as const,
        parentId: channel.parentId,
        categoryId: channel.parentId,
      };
    } catch {
      return undefined;
    }
  },
  /** Live destinations inside a team category: text and announcement channels plus open threads. Private threads are excluded. */
  listTaskDestinations: async (categoryId) => {
    const guild = client.guilds.cache.get(scope.guildId);
    if (!guild) return [];
    try {
      // A full fetch always hits REST; the cache alone is not current authority.
      const channels = await guild.channels.fetch();
      const destinations: {
        channelId: string;
        name: string;
        kind: 'channel' | 'thread';
        parentName?: string | undefined;
      }[] = [];
      for (const channel of channels.values()) {
        if (!channel || channel.isThread()) continue;
        if (
          (channel.type === ChannelType.GuildText ||
            channel.type === ChannelType.GuildAnnouncement) &&
          channel.parentId === categoryId
        ) {
          destinations.push({ channelId: channel.id, name: channel.name, kind: 'channel' });
        }
      }
      destinations.sort((a, b) => a.name.localeCompare(b.name));
      const { threads } = await guild.channels.fetchActiveThreads();
      const threadRows: {
        channelId: string;
        name: string;
        kind: 'thread';
        parentName?: string | undefined;
      }[] = [];
      for (const thread of threads.values()) {
        if (thread.archived || thread.locked) continue;
        // Private threads are never task destinations (see inspectTaskChannel).
        if (thread.type === ChannelType.PrivateThread) continue;
        const parentId = thread.parentId;
        if (!parentId) continue;
        const parent = channels.get(parentId);
        if (!parent || parent.isThread() || parent.parentId !== categoryId) continue;
        threadRows.push({
          channelId: thread.id,
          name: thread.name,
          kind: 'thread',
          parentName: parent.name,
        });
      }
      threadRows.sort(
        (a, b) =>
          (a.parentName ?? '').localeCompare(b.parentName ?? '') || a.name.localeCompare(b.name),
      );
      return [...destinations, ...threadRows];
    } catch {
      return [];
    }
  },
  findGuildMessage: async (channelId, messageId) => {
    const guild = client.guilds.cache.get(scope.guildId);
    if (guild === undefined) return 'channel-not-found';
    const channel = guild.channels.cache.get(channelId);
    if (channel === undefined) return 'channel-not-found';
    if (!channel.isTextBased()) return 'not-text-channel';
    try {
      await channel.messages.fetch(messageId);
      return 'ok';
    } catch {
      return 'message-not-found';
    }
  },
  previewGuildMessage: async (channelId, messageId) => {
    const guild = client.guilds.cache.get(scope.guildId);
    const channel = guild?.channels.cache.get(channelId);
    if (channel === undefined || !channel.isTextBased()) return undefined;
    try {
      const message = await channel.messages.fetch(messageId);
      return {
        authorName: message.member?.displayName ?? message.author.displayName,
        content: message.content.slice(0, 2000),
      };
    } catch {
      return undefined;
    }
  },
  // REST, not the cache: the emoji cache is not guaranteed warm, and this is
  // only read when an operator opens the picker.
  listGuildEmojis: async () => {
    const guild = client.guilds.cache.get(scope.guildId);
    if (guild === undefined) return [];
    try {
      const emojis = await guild.emojis.fetch();
      return [...emojis.values()]
        .filter((emoji) => emoji.name !== null)
        .map((emoji) => ({
          emojiId: emoji.id,
          name: emoji.name ?? '',
          animated: emoji.animated ?? false,
          url: emoji.imageURL({ size: 64 }),
        }))
        .sort((a, b) => a.name.localeCompare(b.name));
    } catch {
      return [];
    }
  },
  // Same gateway-cache honesty as listGuildChannels: the guild's roles,
  // `@everyone` excluded (it is not a panel option), highest rank first.
  // `rawPosition`, deliberately: discord.js's `Role.position` is the role's
  // index in the sorted cache, NOT Discord's position field, and the
  // manageability check in `/api/guild/roles` compares this number against
  // the bot's rawPosition - mixing the two scales can report an above-bot
  // role as manageable (should-fix, review round 2).
  listGuildRoles: () => {
    const guild = client.guilds.cache.get(scope.guildId);
    if (guild === undefined) return [];
    return [...guild.roles.cache.values()]
      .filter((role) => role.id !== guild.id)
      .map((role) => ({
        roleId: role.id,
        name: role.name,
        colour: role.color,
        position: role.rawPosition,
        managed: role.managed,
      }))
      .sort((a, b) => b.position - a.position || a.name.localeCompare(b.name));
  },
  // Live hierarchy, not a remembered flag: the owner can reorder roles in
  // Discord at any time, and the dashboard must answer for the hierarchy as
  // it is now.
  botHighestRolePosition: () => {
    const guild = client.guilds.cache.get(scope.guildId);
    return guild?.members.me?.roles.highest.rawPosition;
  },
  // ADR 0125: live, so a reinstall's new integration role is picked up.
  botMentionIdentity: () => {
    const guild = client.guilds.cache.get(scope.guildId);
    const user = client.user;
    if (guild === undefined || user === null) return undefined;
    const role = guild.roles.botRoleFor(user.id);
    const names = [role?.name, user.username, user.globalName, guild.members.me?.nickname];
    return {
      roleId: role?.id,
      names: names.filter((name): name is string => typeof name === 'string' && name !== ''),
    };
  },
  // The same paginated REST read the MCP port makes (ruling M4-D10): the
  // 50-entry member cache would silently truncate, and `cache: false` keeps
  // the listing from churning it. No presence, activity or status fields.
  // Bulk, live, and absent-when-gone: moderation surfaces resolve the ids
  // on screen in one REST call, and a departed member comes back missing so
  // the dashboard shows the bare id rather than a stale name.
  fetchGuildMembers: async (userIds) => {
    const guild = client.guilds.cache.get(scope.guildId);
    if (guild === undefined) return [];
    const wanted = [...new Set(userIds)];
    if (wanted.length === 0) return [];
    // The bulk endpoint takes at most 100 ids per call; chunk rather than
    // truncate, so a surface handing over 100 ids does not silently lose the
    // rest (low, independent audit).
    const mapMember = (member: GuildMember): OpsGuildMemberInfo => ({
      memberId: member.id,
      username: member.user.username,
      displayName: member.displayName,
      roleIds: member.roles.cache.filter((role) => role.id !== guild.id).map((role) => role.id),
      joinedAt: member.joinedTimestamp,
    });
    return fetchInHundredIdChunks(wanted, async (ids) => {
      const fetched = await guild.members.fetch({ user: [...ids] });
      return [...fetched.values()].map(mapMember);
    });
  },
  listGuildMembers: async (input) => {
    const guild = client.guilds.cache.get(scope.guildId);
    if (guild === undefined) return { members: [], nextAfter: undefined };
    const limit = input.limit ?? 25;
    const page = await guild.members.list({
      limit,
      ...(input.after !== undefined ? { after: input.after } : {}),
      cache: false,
    });
    const members = [...page.values()].map((member) => ({
      memberId: member.id,
      username: member.user.username,
      displayName: member.displayName,
      // The role cache always contains @everyone; dropped so no member shows
      // a role that appears nowhere in the roles list.
      roleIds: [...member.roles.cache.keys()].filter((id) => id !== guild.id).sort(),
      joinedAt: member.joinedAt?.getTime() ?? null,
    }));
    const last = members[members.length - 1];
    return {
      members,
      nextAfter: members.length === limit && last !== undefined ? last.memberId : undefined,
    };
  },
  archiveIndexHealth: () => archiveSearchRepo.indexHealth(scope),
  // The operator sees what the archive holds, nothing wider: the visibility
  // set is every archive-enabled channel in this guild, built here from
  // `listChannels` — never from the caller's input. A `channelId` narrows
  // within that set (the repository returns empty for one outside it); `rank`
  // is dropped at this boundary but the best-first order is kept.
  archiveSearch: (input) => {
    const visibleChannelIds = archiveRepo
      .listChannels(scope)
      .map((channel) => channel.channelId)
      // ADR 0126 Task 9: No-access channels leave the visibility set — the
      // rows stay, the search stops seeing them.
      .filter((channelId) => !noAccessFromCache(client, scope, channelId));
    const result = archiveSearchRepo.searchMessages(scope, {
      query: input.query,
      visibility: { channelIds: visibleChannelIds },
      ...(input.channelId !== undefined && { channelIds: [input.channelId] }),
      ...(input.authorId !== undefined && { authorId: input.authorId }),
      ...(input.limit !== undefined && { limit: input.limit }),
      // N5: a thread excluded on its own hides its rows even though the
      // parent channel stays visible — in SQL, counted in the total with the
      // same predicate. The channel level is the visibility set above.
      excludeThreadIds: excludedThreadIds(scope),
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
  // Same visibility rule as archiveSearch: the repository itself refuses
  // channels outside the guild's archive-enabled set, so the wiring passes
  // the caller's channel id straight through. ADR 0126 Task 9: a No-access
  // channel reads as empty, the same as a channel with no archive.
  archiveChannelHistory: (input) => {
    if (!canSearchArchived(client, scope, input.channelId)) return [];
    // N5: a thread excluded on its own hides its rows even though the parent
    // channel stays visible — in SQL, so the page stays full-length.
    return archiveRepo
      .listChannelHistory(scope, {
        channelId: input.channelId,
        ...(input.before !== undefined && { beforeMessageId: input.before }),
        ...(input.limit !== undefined && { limit: input.limit }),
        excludeThreadIds: excludedThreadIds(scope),
      })
      .map((message) => ({
        messageId: message.messageId,
        channelId: message.channelId,
        authorId: message.authorId,
        content: message.content,
        createdAt: message.createdAt,
        editedAt: message.editedAt,
        deletedAt: message.deletedAt,
      }));
  },
  archiveFindMessage: (messageId) => {
    const message = archiveRepo.findMessage(scope, messageId);
    if (message === undefined) return undefined;
    // No oracle: a message in a No-access channel answers like an unknown id,
    // and the HTTP route maps both to its 404. ADR 0126 M6: a thread excluded
    // on its own hides its rows the same way.
    if (!canSearchArchived(client, scope, message.channelId)) return undefined;
    if (message.threadId !== undefined && noAccessFromCache(client, scope, message.threadId))
      return undefined;
    return {
      messageId: message.messageId,
      channelId: message.channelId,
      authorId: message.authorId,
      content: message.content,
      createdAt: message.createdAt,
      editedAt: message.editedAt,
      deletedAt: message.deletedAt,
    };
  },

  // Slice M5 (ADR 0044 §4): the channels this guild's MCP connector may post
  // to, and the ledger of what it posted. The clock is this composition
  // root's, not the command's, the same reasoning `recordMatchVerdict` gives.
  //
  // The guild-membership check is the allow-time half of C2: a row is written
  // *under* a guild, which never made it *of* that guild, so the write path
  // refuses anything that is not a text-capable channel of this guild before
  // the repository sees it. A DM-shaped id is simply absent from the guild's
  // channel cache and lands in `no-such-channel`.
  allowSendChannel: (input) => {
    if (!isTextChannelOfGuild(client, scope.guildId, input.channelId)) {
      return 'no-such-channel';
    }
    const added = mcpSendRepo.allowChannel(scope, {
      channelId: input.channelId,
      addedByAccountId: input.accountId,
      now: now(),
    });
    return added ? 'allowed' : 'already-allowed';
  },
  allowSendCategory: (input) => {
    // Review S2: the same allow-time shape check `allowSendChannel` has —
    // the id must name a category of this guild before any row is written.
    const target = client.guilds.cache.get(scope.guildId)?.channels.cache.get(input.channelId);
    if (target?.type !== ChannelType.GuildCategory) return 'no-such-channel';
    const added = mcpSendRepo.allowChannel(scope, {
      channelId: input.channelId,
      addedByAccountId: input.accountId,
      scopeKind: 'category',
      now: now(),
    });
    return added ? 'allowed' : 'already-allowed';
  },
  disallowSendCategory: (channelId) => mcpSendRepo.disallowChannel(scope, channelId, 'category'),
  sendScopeCoverage: (channelId) => {
    const guild = client.guilds.cache.get(scope.guildId);
    return guild === undefined
      ? 0
      : guild.channels.cache.filter(
          (channel) => !channel.isThread() && channel.parentId === channelId,
        ).size;
  },
  disallowSendChannel: (channelId) => mcpSendRepo.disallowChannel(scope, channelId, 'channel'),
  listSendAllowlist: () =>
    mcpSendRepo.listAllowedChannels(scope).map((row) => ({
      ...row,
      coverage:
        row.scopeKind === 'category'
          ? (() => {
              const guild = client.guilds.cache.get(scope.guildId);
              return guild === undefined
                ? 0
                : guild.channels.cache.filter(
                    (channel) => !channel.isThread() && channel.parentId === row.channelId,
                  ).size;
            })()
          : 1,
    })),
  listSends: (input) =>
    mcpSendRepo.listSends(scope, { sinceMs: input.sinceMs, limit: input.limit }),

  // ADR 0126: the channels and categories the assistant may read. The same
  // allow-time shape checks the send allowlist wires above: a channel verb
  // refuses anything that is not a text-capable channel of this guild, and a
  // category verb refuses anything that is not a category of this guild —
  // both resolved from the live cache before the repository sees the id. The
  // clock is this composition root's, not the command's. Unlike the send
  // allowlist there is no account: the repository stores no adder.
  readScopeAllow: (input) => {
    if (input.scopeKind === 'category') {
      const target = client.guilds.cache.get(scope.guildId)?.channels.cache.get(input.channelId);
      if (target?.type !== ChannelType.GuildCategory) return 'no-such-channel';
    } else if (!isTextChannelOfGuild(client, scope.guildId, input.channelId)) {
      return 'no-such-channel';
    }
    const added = channelReadRepo.allowRead(scope, {
      channelId: input.channelId,
      scopeKind: input.scopeKind,
      now: now(),
    });
    return added ? 'allowed' : 'already-allowed';
  },
  // Slice 5 task 6 (ADR 0117 §2): the role-policy modes and the role
  // allowlist. The clock is this composition root's, not the command's, the
  // same reasoning `recordMatchVerdict` gives.
  //
  // The allow-time role check is live: `roles.fetch` with `force: true` goes
  // to Discord rather than answering from the gateway cache alone, so a role
  // deleted (or given a dangerous permission) since the cache filled in is
  // refused rather than allowlisted on stale facts. Each refusal writes
  // nothing — the repository sees the id only after every check has passed.
  // Above-bot roles MAY be allowlisted: hierarchy is checked at use time by
  // the grant and ping paths, never here, so position is not read at all.
  readRolePolicy: () => mcpRolePolicyRepo.readRolePolicy(scope),
  setRolePolicy: (input) => mcpRolePolicyRepo.upsertRolePolicy(scope, { ...input, now: now() }),
  allowRole: async (input) => {
    const guild = client.guilds.cache.get(scope.guildId);
    let role: { id: string; managed: boolean; permissions: { bitfield: bigint } } | null;
    try {
      role = (await guild?.roles.fetch(input.roleId, { force: true })) ?? null;
    } catch {
      // Fail closed: without a live role there is nothing to check the floor
      // against, so the answer is the same as for a role that is not there.
      return 'no-such-role';
    }
    if (role === null) return 'no-such-role';
    if (role.id === scope.guildId) return 'everyone';
    if (role.managed) return 'managed';
    if (isDangerousRole(role.permissions.bitfield)) return 'dangerous';
    const added = mcpRolePolicyRepo.allowRole(scope, {
      roleId: input.roleId,
      purpose: input.purpose,
      addedByAccountId: input.accountId,
      now: now(),
    });
    return added ? 'allowed' : 'already-allowed';
  },
  readScopeDisallow: (input) =>
    channelReadRepo.disallowRead(scope, input.channelId, input.scopeKind),
  readScopeList: () => channelReadRepo.listReadScope(scope),
  disallowRole: (input) =>
    mcpRolePolicyRepo.disallowRole(scope, input.roleId, input.purpose) ? 'removed' : 'not-allowed',
  listRoleAllowlist: () => mcpRolePolicyRepo.listRoleAllowlist(scope),

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
  listAccountCapabilities: (accountId) => authzRepo.listAccountCapabilities(scope, accountId),
  // ADR 0069: revoke one capability in this guild, the sibling of the grant
  // above. The account lookup is instance-level through `instanceScope`;
  // `not-held` covers both "never held" and "no guild access" — either way
  // there is nothing to remove, and the operator hears that rather than a
  // constraint error.
  revokeAccountCapability: (input) => {
    const account = accountRepo.findAccountByUsername(instanceScope, input.username);
    if (account === undefined) return 'no-such-account';
    if (!authzRepo.listAccountCapabilities(scope, account.accountId).includes(input.capability)) {
      return 'not-held';
    }
    authzRepo.revokeAccountCapability(scope, {
      accountId: account.accountId,
      capability: input.capability,
    });
    return 'revoked';
  },

  // Slice 13 (S13-D1/D2): guild access itself, granted and revoked. The exact
  // pattern `grantAccountCapability` above uses: the account lookup is
  // instance-level (accounts predate any guild choice, ADR 0027) and runs
  // through the `instanceScope` parameter, while the access write is
  // guild-scoped — this closure's `scope` IS the guild being granted or
  // revoked, which is why the command takes no guild of its own and the
  // global `--guild` is the target. The pre-check before each write turns a
  // repeated grant and a vacant revoke into answers (`'already-had-it'`,
  // `'did-not-have-it'`) rather than silent no-ops; the revoke's capability
  // cascade is the foreign key's, not this function's (ADR 0028).
  accountGrantGuild: (username) => {
    const account = accountRepo.findAccountByUsername(instanceScope, username);
    if (account === undefined) return 'no-such-account';
    if (accountRepo.hasGuildAccess(scope, account.accountId)) return 'already-had-it';
    accountRepo.grantGuildAccess(scope, account.accountId);
    return 'granted';
  },
  accountRevokeGuild: (username) => {
    const account = accountRepo.findAccountByUsername(instanceScope, username);
    if (account === undefined) return 'no-such-account';
    if (!accountRepo.hasGuildAccess(scope, account.accountId)) return 'did-not-have-it';
    accountRepo.revokeGuildAccess(scope, account.accountId);
    return 'revoked';
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
 * Whether the id names a text-capable channel of this guild (C2 allow-time).
 *
 * A live check against `client.guilds.cache`, the same "already in memory,
 * nothing to fetch" style `keywordFilterRulesMissingManageMessages` below
 * uses — allowlisting happens once per channel with a human present, so the
 * cache is the right source and no REST call is needed. A guild absent from
 * the cache (not yet READY, or left) answers false: failing closed, because
 * an allowlist row written without validation is exactly what the send-time
 * check exists to contain. Threads are excluded like below: a thread id is
 * not a channel an owner allowlists.
 */
const isTextChannelOfGuild = (client: Client, guildId: string, channelId: string): boolean => {
  const guild = client.guilds.cache.get(guildId);
  if (guild === undefined) return false;
  const channel = guild.channels.cache.get(channelId);
  if (channel === undefined) return false;
  return channel.isTextBased() && !channel.isThread();
};

/**
 * `doctor`'s automod half: for every enabled `keyword_filter` rule, every
 * channel it is not exempted from where the bot's cached
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
  const rules = automodRuleRepo.listEnabledKeywordFilterRules(scope);
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
  enabled: rule.enabled,
  config: rule.config,
  countsAsViolation: rule.countsAsViolation,
  createdAt: rule.createdAt,
  updatedAt: rule.updatedAt,
  matchCount: matchCounts[rule.ruleId] ?? 0,
  reviewedCount: reviewedCounts[rule.ruleId] ?? 0,
  verdicts: verdicts[rule.ruleId] ?? { falsePositive: 0, truePositive: 0, unclear: 0 },
});

/**
 * S13-D5's input: whether anyone can sign in, computed over the account
 * tables for `doctor()`.
 *
 * Only ENABLED accounts count toward reachability: a disabled account's
 * sessions and tokens stop verifying, so a guild reachable solely through
 * one is a guild nobody can sign in to. With zero enabled accounts the guild
 * list is meaningless (every guild is trivially unreachable) and the report
 * turns on the bootstrap token instead — live means setup is pending, gone
 * means nobody can get in without a restart. A guild with no runtime in
 * `guildScopes` is unreachable with no account able to prove otherwise, so
 * it fails closed rather than passing silently.
 */
const readDashboardAccess = (
  instanceScope: InstanceScope,
  guildScopes: readonly GuildScope[],
  allowlistedGuildIds: readonly string[],
  nowMs: number,
): DoctorDashboardAccess => {
  const enabledAccountIds = accountRepo
    .listAccounts(instanceScope)
    .filter((account) => !account.disabled)
    .map((account) => account.accountId);
  const liveBootstrapTokens = accountRepo.countUnconsumedBootstrapTokens(instanceScope, nowMs);
  if (enabledAccountIds.length === 0) {
    return { enabledAccounts: 0, unreachableGuilds: [], liveBootstrapTokens };
  }
  const unreachableGuilds = allowlistedGuildIds.filter((guildId) => {
    const guildScope = guildScopes.find((candidate) => candidate.guildId === guildId);
    if (guildScope === undefined) return true;
    return !enabledAccountIds.some((accountId) =>
      accountRepo.hasGuildAccess(guildScope, accountId),
    );
  });
  return { enabledAccounts: enabledAccountIds.length, unreachableGuilds, liveBootstrapTokens };
};

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
  /** Every guild this daemon serves, because `dashboard_sessions` is guild-partitioned (M3c-R3). */
  readonly guildScopes: readonly GuildScope[];
  /** Injected, like every clock in this tree. Slice 13e found the bug. */
  readonly now: () => number;
  /** `backup now` and `backup list` (ADR 0034, slice 16). */
  readonly backupTimer: BackupTimer;
  /**
   * The provider actually chosen: the dashboard's saved choice when it is not
   * 'off', else env `AI_PROVIDER` (ADR 0061). Absent in tests: env only.
   */
  readonly chosenAiProvider?: (() => string) | undefined;
  /**
   * The account password vault (ADR 0070), resolved by `index.ts` next to
   * the assistant provider secret. Absent in tests, matching every other
   * secret-file resolution in this tree — no test writes a key file into a
   * real data directory.
   */
  readonly passwordVault?: PasswordVault | undefined;
}

/**
 * Dashboard-account operators (ADR 0045 D6), split out of `opsInstanceFor`
 * below.
 *
 * `opsInstanceFor` requires a `Config` and a live discord.js `Client` and has
 * no test anywhere in the tree; the account mapping needs neither. A separate
 * factory is what makes "no password hash crosses this boundary" a cheap test
 * — `accountOpsFor` over a migrated test database — rather than an expensive
 * one.
 */
export const accountOpsFor = (
  instanceScope: InstanceScope,
  guildScopes: readonly GuildScope[],
  now: () => number,
  /**
   * The password vault (ADR 0070), absent in tests that never seal anything
   * (`accountOpsFor(instance(), [], () => NOW)` stays valid — the existing
   * two- and three-argument call sites). `undefined` behaves exactly like an
   * unavailable vault: `accountCreate`/`accountSetPassword` store `null`
   * instead of sealing, and `accountRevealPassword` answers
   * `'not-revealable'`.
   */
  passwordVault?: PasswordVault,
): Pick<
  OpsInstance,
  | 'accountList'
  | 'accountCreate'
  | 'accountSetDisabled'
  | 'accountDelete'
  | 'accountRevokeCredentials'
  | 'accountSetPassword'
  | 'accountRevealPassword'
> => {
  // ADR 0070: seals `password` for a non-owner account when the vault is
  // available, else clears any sealed copy — never leaves a stale one
  // behind a password change the vault could not seal.
  const sealPassword = (accountId: string, isOwner: boolean, password: string): void => {
    const sealed =
      !isOwner && passwordVault?.available === true ? passwordVault.seal(password) : null;
    accountRepo.setPasswordSealed(instanceScope, accountId, sealed);
  };

  return {
    // Field by field, never a spread: the row carries a `passwordHash` (and
    // a `passwordSealed` ciphertext) that must not cross this boundary
    // (`ports.ts` may not import `@bananasaurs/storage`, ADR 0014, so the
    // shape names what crosses) — only the derived `revealable` boolean does.
    accountList: () =>
      accountRepo.listAccounts(instanceScope).map((row) => ({
        accountId: row.accountId,
        username: row.username,
        isOwner: row.isOwner,
        disabled: row.disabled,
        lockedUntil: row.lockedUntil,
        createdAt: row.createdAt,
        revealable: row.passwordSealed !== null && !row.isOwner,
      })),
    accountCreate: async (username, password) => {
      if (accountRepo.findAccountByUsername(instanceScope, username) !== undefined) {
        return 'username-taken';
      }
      // ADR 0069: a provided password is the dashboard's "I'll choose one" —
      // hashed exactly like a generated one below. Generated, never chosen,
      // stays the CLI default (S13-D3's rule applied to creation): the secret
      // lands in no shell history and no form field. The account
      // starts non-owner with no guild access and no capabilities - least
      // privilege by construction, with every later grant an explicit,
      // audited step.
      const chosen = password ?? generateToken();
      const passwordHash = await hashPassword(chosen);
      const accountId = `acct_${randomBytes(16).toString('hex')}`;
      const at = now();
      accountRepo.createAccount(instanceScope, {
        accountId,
        username,
        passwordHash,
        isOwner: false,
        now: at,
      });
      // ADR 0070: every account created here is non-owner (see above), so
      // this always attempts a seal — `sealPassword` itself is what checks
      // vault availability and stores `null` when there is none.
      sealPassword(accountId, false, chosen);
      return { accountId, username, password: chosen, createdAt: at };
    },
    accountSetDisabled: (username, disabled) => {
      const row = accountRepo.findAccountByUsername(instanceScope, username);
      if (row === undefined) return 'no-such-account';
      // Unreachable under the current synchronous single-writer model: nothing
      // is awaited between the lookup above and this write, and better-sqlite3
      // runs the whole handler on one writer, so the row cannot disappear in
      // between. Kept because the port must answer something for the
      // found-then-gone case, and a successful lookup followed by no matched
      // row is a race, not a usage mistake — the same answer the delete branch
      // below gives, deliberately.
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
      // Unreachable under the current synchronous single-writer model: nothing
      // is awaited between the lookup above and this delete, and better-sqlite3
      // runs the whole handler on one writer, so the row cannot disappear in
      // between. Kept because the port must answer something for the
      // found-then-gone case, and a successful lookup followed by
      // `deleted: false` is a race, not a usage mistake.
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
    /**
     * The session half of the sweep covers the guild allowlist and nothing else:
     * `guildScopes` comes from `BANANASAURS_GUILD_ALLOWLIST`, so a dashboard
     * session in a guild since dropped from the allowlist is never swept and
     * still authenticates. The token and code halves are instance-level and have
     * no such boundary.
     */
    accountRevokeCredentials: (username) => {
      const row = accountRepo.findAccountByUsername(instanceScope, username);
      if (row === undefined) return 'no-such-account';
      // One timestamp for every write in this call: the sessions and the tokens
      // die at the same instant, so the audit row names one moment, not a span.
      const at = now();
      // Separate transactions, not one (M3c-R4): the session revoke is a
      // guild-scoped write per guild and the token revoke and code delete are
      // instance-level, and `writeInstance` does not nest — so a crash between
      // them is a state a retry fixes, not a state one transaction prevents.
      let sessionsRevoked = 0;
      for (const guildScope of guildScopes) {
        sessionsRevoked += sessionRepo.revokeAllForAccount(guildScope, {
          accountId: row.accountId,
          now: at,
        });
      }
      const tokensRevoked = oauthRepo.revokeAllTokensForAccount(instanceScope, {
        accountId: row.accountId,
        now: at,
      });
      // ADR 0045 Amendment 4 A3-6: an unexchanged code is a token that has not
      // been minted yet, and `exchangeCode` cannot see a token revocation — so
      // the sweep deletes the account's codes too, the way `accountDelete` does.
      const codesDeleted = oauthRepo.deleteAuthorizationCodesForAccount(
        instanceScope,
        row.accountId,
      );
      // Re-read AFTER the writes, never the pre-write row: the row above is
      // stale by construction once anything has been written, and `disabled` is
      // exactly what this command must not touch — the read proves it did not.
      const reread = accountRepo.findAccountById(instanceScope, row.accountId);
      // Unreachable under the current synchronous single-writer model, the same
      // found-then-gone race the two branches above answer with
      // 'no-such-account' — and the same answer here, deliberately.
      if (reread === undefined) return 'no-such-account';
      return {
        username: row.username,
        accountId: row.accountId,
        sessionsRevoked,
        tokensRevoked,
        codesDeleted,
        guildsTouched: guildScopes.length,
        stillEnabled: !reread.disabled,
      };
    },
    /**
     * Slice 13 (S13-D3/D4): the password reset ADR 0045 Amendment 4 named as a
     * gap — `setPasswordHash` finally has a production caller.
     *
     * Generate, hash outside, write the finished hash inside: Argon2id is async
     * and `writeInstance` makes an async transaction uncompilable, so the hash
     * is computed before the write, the same split the repository's own comment
     * demands (`passwordHash`, never `password`). `generateToken` is the same
     * 32-random-bytes primitive the bootstrap path uses — S13-D3 generates
     * rather than accepts, so the secret never lands in shell history or `ps`
     * output.
     *
     * ADR 0069: a provided password is the dashboard's "type a new password" —
     * hashed exactly like a generated one below. The route refuses short ones
     * before this is called; the CLI keeps generating.
     *
     * The session sweep is exactly `accountRevokeCredentials`' guild half, and
     * deliberately ONLY that half: a session is trust derived from the
     * password, so it dies with it, while an OAuth token is bound to the
     * account and survives — the operator who wants both runs `account
     * revoke-credentials` for the other half, and the command says so. The
     * plaintext is returned and never stored: the command prints it into `text`
     * once, and it appears in neither `data` nor the audit row (rule 4).
     */
    accountSetPassword: async (username, password) => {
      const row = accountRepo.findAccountByUsername(instanceScope, username);
      if (row === undefined) return 'no-such-account';
      const chosen = password ?? generateToken();
      const passwordHash = await hashPassword(chosen);
      accountRepo.setPasswordHash(instanceScope, {
        accountId: row.accountId,
        passwordHash,
      });
      // ADR 0070: the sealed copy follows the hash — a stale sealed value
      // behind a rotated password would let the owner "reveal" a password
      // that no longer authenticates.
      sealPassword(row.accountId, row.isOwner, chosen);
      // The session half of the sweep covers the guild allowlist and nothing
      // else, the same boundary `accountRevokeCredentials` above documents: a
      // session in a guild since dropped from the allowlist is never swept.
      const at = now();
      let sessionsRevoked = 0;
      for (const guildScope of guildScopes) {
        sessionsRevoked += sessionRepo.revokeAllForAccount(guildScope, {
          accountId: row.accountId,
          now: at,
        });
      }
      return {
        username: row.username,
        accountId: row.accountId,
        password: chosen,
        sessionsRevoked,
        guildsTouched: guildScopes.length,
      };
    },
    /**
     * Opens the sealed copy of a non-owner account's password (ADR 0070, spec
     * A4). The owner-target refusal (`403 owner-protected`) and the caller's
     * own-capability check (`403 owner-only`) already happened at the route
     * layer before this is called — this only answers what the vault itself
     * can: is there a sealed value, and does it open.
     */
    accountRevealPassword: (username) => {
      const row = accountRepo.findAccountByUsername(instanceScope, username);
      if (row === undefined) return 'no-such-account';
      if (passwordVault === undefined || row.passwordSealed === null) return 'not-revealable';
      const password = passwordVault.open(row.passwordSealed);
      if (password === undefined) return 'not-revealable';
      return { username: row.username, password };
    },
  };
};

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
      // S13-D5: the dashboard-access input, computed here — this is the one
      // `buildDoctorReport` call site with a database handle. The account
      // reads are synchronous, so the report stays synchronous. Startup and
      // doctor mode pass nothing and skip the finding (see `doctor.ts`).
      const dashboardAccess = readDashboardAccess(
        deps.instanceScope,
        deps.guildScopes,
        deps.config.BANANASAURS_GUILD_ALLOWLIST,
        deps.now(),
      );
      // ADR 0070: the same shape `dashboardAccess` above is — computed here,
      // the one call site with a database handle, and never the sealed
      // values themselves, only a count.
      const passwordVault: DoctorPasswordVault = {
        available: deps.passwordVault?.available === true,
        ...(deps.passwordVault?.source === undefined ? {} : { source: deps.passwordVault.source }),
        revealableAccounts: accountRepo
          .listAccounts(deps.instanceScope)
          .filter((row) => !row.isOwner && row.passwordSealed !== null).length,
      };
      const report = buildDoctorReport(
        deps.client,
        deps.config,
        deps.now(),
        dashboardAccess,
        passwordVault,
      );
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
  /**
   * Ruling M6-D1's probe, behind `MCP_PUBLIC_URL` and with the global fetch.
   *
   * The one new outbound destination hard rule 8 names: the daemon's own
   * public URL, built from that base and nothing else. Unset means unprobed
   * and ok — a daemon that has not opted into the tunnel has no surface to
   * check. A probe that throws (a `fetch` the platform refuses to build, not
   * a network error, which the probe itself classifies) is reported as a
   * finding rather than thrown: a diagnostic that can take down the socket
   * handler is worse than no diagnostic, the same reason `doctor()` wraps.
   */
  probePublicSurface: async () => {
    try {
      const report = await runPublicSurfaceProbe({
        publicUrl: deps.config.MCP_PUBLIC_URL,
        fetch: globalThis.fetch,
      });
      return {
        probed: report.probed,
        ok: report.ok,
        text: formatPublicSurface(report),
        data: JSON.parse(JSON.stringify(report.rows)) as never,
      };
    } catch (err) {
      return {
        probed: true,
        ok: false,
        text: `public surface    probe failed: ${err instanceof Error ? err.message : String(err)}`,
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
  mcpTokens: () => {
    const connectionIds = oauthRepo.tokenConnectionIds(deps.instanceScope);
    return oauthRepo.listTokens(deps.instanceScope).map((row) => ({
      tokenId: row.tokenId,
      kind: row.kind,
      clientId: row.clientId,
      accountId: row.accountId,
      connectionId: connectionIds.get(row.tokenId) ?? row.tokenId,
      createdAt: row.createdAt,
      expiresAt: row.expiresAt,
      revokedAt: row.revokedAt,
      lastUsedAt: row.lastUsedAt,
    }));
  },
  // ADR 0130: connections, the unit the owner recognises. The username and
  // app name are joined here; a deleted account or client reads as null.
  mcpConnections: () => {
    const clientNames = new Map(
      oauthRepo.listClients(deps.instanceScope).map((c) => [c.clientId, c.clientName]),
    );
    const usernames = new Map<string, string | null>();
    const usernameOf = (accountId: string): string | null => {
      if (!usernames.has(accountId)) {
        usernames.set(
          accountId,
          accountRepo.findAccountById(deps.instanceScope, accountId)?.username ?? null,
        );
      }
      return usernames.get(accountId) ?? null;
    };
    return oauthRepo.listConnections(deps.instanceScope, deps.now()).map((row) => ({
      connectionId: row.connectionId,
      accountId: row.accountId,
      accountUsername: usernameOf(row.accountId),
      clientId: row.clientId,
      clientName: clientNames.get(row.clientId) ?? null,
      scopes: row.scopes,
      createdAt: row.createdAt,
      lastUsedAt: row.lastUsedAt,
      status: row.status,
      tokenCount: row.tokenCount,
    }));
  },
  mcpDisconnect: (connectionId) =>
    oauthRepo.revokeConnection(deps.instanceScope, connectionId, deps.now()),
  mcpDeleteConnection: (connectionId) =>
    oauthRepo.deleteConnection(deps.instanceScope, connectionId, deps.now()),
  mcpDeleteToken: (tokenId) => oauthRepo.deleteToken(deps.instanceScope, tokenId, deps.now()),
  mcpCleanup: () => oauthRepo.cleanupDead(deps.instanceScope, deps.now()),
  mcpRevokeToken: (tokenId) => {
    // A single-row revoke would leave the sibling refresh token free to mint
    // a replacement, so the operator's remedy kills the whole lineage — the
    // same `revokeTokensFromCode` the replay and revoke paths use.
    const row = oauthRepo.findTokenById(deps.instanceScope, tokenId);
    if (row === undefined) return undefined;
    return oauthRepo.revokeTokensFromCode(deps.instanceScope, row.issuedFromCodeHash, deps.now());
  },
  // `deleteClient` returns 0 for an unknown client and a count otherwise, so
  // existence is checked first: the port must answer `undefined` for "no such
  // client" rather than "0 tokens revoked", which would read as a success that
  // removed nothing.
  mcpRevokeClient: (clientId) => {
    if (oauthRepo.findClient(deps.instanceScope, clientId) === undefined) return undefined;
    return oauthRepo.deleteClient(deps.instanceScope, clientId, deps.now());
  },
  // ADR 0044 §7: the training-eligibility control behind hard rule 5.
  // Instance-level, the same reason `mcpClients` is — a provider is a fact
  // about the daemon, not a guild — so this reads `deps.instanceScope`
  // directly. Field by field: the row carries an `evidenceUrl` that must
  // never be logged (Pino allowlist), so only the provider, the verdict and
  // the review date cross this boundary.
  //
  // One warning per row, ordered most serious first: `'unknown'` warns as
  // `'not-no'` (`isEligible` is `'no'`-only, hard rule 5), so the not-`'no'`
  // verdict outranks everything — a row that both trains on input and
  // disallows production use warns once, as `'not-no'`, never as merely
  // `'not-production'`. `not-production` (ruling M4-D21: half of ADR 0010
  // §2's gate, the NIM free-tier case) outranks staleness: a row whose review
  // is merely old is a promise nobody recently verified, while a row that
  // disallows production use is a promise that does not cover this daemon.
  providerEligibilityWarnings: (nowMs): ReturnType<OpsInstance['providerEligibilityWarnings']> => {
    // The element type via the port itself, not a second copy of the shape:
    // core's index does not re-export every member shape (cf. `OpsMcpClient`,
    // likewise structural here), and this file must not reach past the root.
    const warnings: ReturnType<OpsInstance['providerEligibilityWarnings']>[number][] = [];
    // The configured provider with no row: without this line `doctor` prints
    // "every provider verified" while the assistant refuses every invoke.
    // The state is intentional - no row exists until an owner verifies the
    // provider's terms and seeds one by migration (ruling M4-D16) - and the
    // surface must say exactly that, never invent an approval.
    const configuredProvider = deps.chosenAiProvider?.() ?? deps.config.AI_PROVIDER;
    if (
      configuredProvider !== undefined &&
      configuredProvider !== 'off' &&
      eligibilityRepo.findEligibility(deps.instanceScope, configuredProvider) === undefined
    ) {
      warnings.push({
        provider: configuredProvider,
        reason: 'unverified',
        trainsOnInput: 'unknown',
        reviewedAt: 0,
      });
    }
    for (const row of eligibilityRepo.listEligibility(deps.instanceScope)) {
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
  // Field by field, the same reason `providerEligibilityWarnings` above maps
  // field by field — except `evidenceUrl`, which the command prints back and
  // therefore must cross here.
  providerReview: (provider): ReturnType<OpsInstance['providerReview']> => {
    const row = eligibilityRepo.findEligibility(deps.instanceScope, provider);
    if (row === undefined) return 'no-such-provider';
    const now = deps.now();
    eligibilityRepo.recordEligibilityReview(deps.instanceScope, { provider, now });
    return {
      provider: row.provider,
      trainsOnInput: row.trainsOnInput,
      evidenceUrl: row.evidenceUrl,
      productionUseAllowed: row.productionUseAllowed,
      reviewedAt: now,
      previouslyReviewedAt: row.reviewedAt,
    };
  },
  ...accountOpsFor(deps.instanceScope, deps.guildScopes, deps.now, deps.passwordVault),
});
