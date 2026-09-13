import { beforeEach, describe, expect, it } from 'vitest';
import {
  createPredicateCache,
  OPERATOR_COMMANDS,
  parseGuildId,
  type Actor,
  type OpsContext,
  type OpsInstance,
  type OpsPorts,
  type PredicateInput,
} from '@bananasaurs/core';
import { evaluateRule } from '@bananasaurs/core';
import { openMigratedTestDatabase, type MigratedTestDatabase } from '../test-support.js';
import { upsertGuild } from './guilds.js';
import { createRule, findRuleKindAndConfig, listEnabledRules } from './automod-rules.js';
import {
  addInviteAllowlistEntry,
  addLinkDomain,
  listInviteAllowlist,
  listLinkDomains,
  removeInviteAllowlistEntry,
  removeLinkDomain,
} from './automod-rule-lists.js';
import type { GuildScope } from '../scope.js';

/**
 * A `link_domain` rule's configured `mode`, read the same tolerant way
 * `apps/daemon/src/ops/wiring.ts`'s `linkDomainModeOf` does (duplicated
 * rather than imported: that module lives in `apps/daemon`, which `storage`
 * may not depend on, the same reason `portsFor` below reimplements the ports
 * themselves instead of calling `opsPortsFor`).
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
 * The end-to-end test the Task 9 brief names as the one that makes this task
 * worth having: an added invite code stops the `invite` predicate firing on
 * it, all the way through command → storage → hydration → fingerprint →
 * predicate.
 *
 * **Why this lives here, in `packages/storage`, rather than beside the
 * command in `packages/core/src/ops/commands/automod.test.ts`.** `core` may
 * not import `@bananasaurs/storage` (ADR 0014, enforced by
 * `eslint.config.js`'s `no-restricted-imports`, not just by convention) — so
 * a test that needs a *real* migrated database, not `fakeOpsPorts`, cannot
 * live in `core` at all. `packages/storage` is the other direction: it
 * already depends on `@bananasaurs/core` (`storage/package.json`), so it is
 * the one place that can hold a real `GuildScope` in one hand and
 * `evaluateRule`/`createPredicateCache`/`OPERATOR_COMMANDS` in the other. A
 * new file rather than appending to `automod-rules.test.ts`: that file tests
 * the repository in isolation (Task 6 already put `addInviteAllowlistEntry`'s
 * own round-trip there), and this test is about the ops wiring layer stacked
 * on top of it — a different concern that happens to need the same tables.
 *
 * The command itself is reached through `OPERATOR_COMMANDS` and
 * `RegisteredCommand.runParsed` — the same public surface the operator
 * socket calls — rather than importing the command object directly, because
 * individual `automod` commands are not re-exported from `core`'s public
 * `index.ts` (only `OPERATOR_COMMANDS` and the generic dispatch types are).
 * Finding it by name also proves it is actually registered, not just defined.
 */

const GUILD = parseGuildId('444444444444444444');
const NOW = 1_700_000_000_000;

let t: MigratedTestDatabase;
let scope: GuildScope;

beforeEach(() => {
  t = openMigratedTestDatabase();
  scope = t.scopes.forGuild(GUILD);
  upsertGuild(scope, { name: 'guild', now: NOW });
});

/**
 * A minimal `OpsPorts`, wired to the *real* repository the way
 * `apps/daemon/src/ops/wiring.ts`'s `opsPortsFor` is (this test cannot import
 * that module — it lives in `apps/daemon`, not a package `storage` may
 * depend on — so the three ports this test actually exercises are
 * reimplemented against the same repository functions). Every other member
 * throws if called: a test that reaches a port it did not mean to exercise
 * should fail loudly at that line, not read a fake zero.
 */
const notNeeded = (name: string) => (): never => {
  throw new Error(`OpsPorts.${name} was called but this test does not stub it`);
};

const portsFor = (s: GuildScope): OpsPorts => ({
  guildName: notNeeded('guildName'),
  safetyState: notNeeded('safetyState'),
  jobCounts: notNeeded('jobCounts'),
  oldestDueJobAtMs: notNeeded('oldestDueJobAtMs'),
  recordAudit: () => undefined,
  setKillswitch: notNeeded('setKillswitch'),
  tailAudit: notNeeded('tailAudit'),
  listJobs: notNeeded('listJobs'),
  listPanels: notNeeded('listPanels'),
  findPanel: notNeeded('findPanel'),
  listUnassignableRoles: notNeeded('listUnassignableRoles'),
  listKeywordFilterRulesMissingManageMessages: notNeeded(
    'listKeywordFilterRulesMissingManageMessages',
  ),
  listUnusableAutomodRules: notNeeded('listUnusableAutomodRules'),
  listAutomodRulesEnforcingWithBadCutoverState: notNeeded(
    'listAutomodRulesEnforcingWithBadCutoverState',
  ),
  listAutomodRulesObservingPastWindowWithBacklog: notNeeded(
    'listAutomodRulesObservingPastWindowWithBacklog',
  ),
  listRoutes: notNeeded('listRoutes'),
  listExcludedChannels: notNeeded('listExcludedChannels'),
  findJob: notNeeded('findJob'),
  findAutomodRule: notNeeded('findAutomodRule'),
  listAutomodFixtures: notNeeded('listAutomodFixtures'),
  listUnreviewedMatches: notNeeded('listUnreviewedMatches'),
  listUnreviewedNativeHits: notNeeded('listUnreviewedNativeHits'),
  nativeBlockedCount: notNeeded('nativeBlockedCount'),
  listAutomodRules: notNeeded('listAutomodRules'),
  findAutomodRuleDetail: notNeeded('findAutomodRuleDetail'),
  runAutomodDryRun: notNeeded('runAutomodDryRun'),
  listRecentCases: notNeeded('listRecentCases'),
  findCaseDetail: notNeeded('findCaseDetail'),
  listCasesForMember: notNeeded('listCasesForMember'),
  applySetting: notNeeded('applySetting'),
  recordMatchVerdict: notNeeded('recordMatchVerdict'),
  setAutomodRuleReady: notNeeded('setAutomodRuleReady'),
  recordAutomodSignOff: notNeeded('recordAutomodSignOff'),
  // The ports this test exercises for real — the same logic
  // `apps/daemon/src/ops/wiring.ts` uses: `findRuleKindAndConfig` guards both
  // existence and kind ahead of the write (IMPORTANT-7), so a mistyped rule
  // id is a usage answer rather than an opaque `FOREIGN KEY constraint
  // failed`, and a rule of the wrong kind is refused rather than writing a
  // row nothing will ever read.
  addInviteAllowlistEntry: (input) => {
    const rule = findRuleKindAndConfig(s, input.ruleId);
    if (rule === undefined) return 'no-such-rule';
    if (rule.kind !== 'invite') return 'wrong-kind';
    const before = listInviteAllowlist(s, input.ruleId).length;
    addInviteAllowlistEntry(s, { ...input, now: NOW });
    const after = listInviteAllowlist(s, input.ruleId).length;
    return after > before ? 'added' : 'already-present';
  },
  listInviteAllowlist: (ruleId) => listInviteAllowlist(s, ruleId),
  removeInviteAllowlistEntry: (input) => {
    const rule = findRuleKindAndConfig(s, input.ruleId);
    if (rule === undefined) return 'no-such-rule';
    if (rule.kind !== 'invite') return 'wrong-kind';
    const removed = removeInviteAllowlistEntry(s, input.ruleId, input.code);
    return removed ? 'removed' : 'not-present';
  },
  // Mirrors `wiring.ts`'s `addLinkDomain`/`removeLinkDomain`: the repository
  // reports the canonical domain and whether the insert actually happened
  // (IMPORTANT-1), so the port names the *stored* listType on a no-op
  // instead of the operator's requested one.
  addLinkDomain: (input) => {
    const rule = findRuleKindAndConfig(s, input.ruleId);
    if (rule === undefined) return { outcome: 'no-such-rule' };
    if (rule.kind !== 'link_domain') return { outcome: 'wrong-kind' };
    const mode = linkDomainModeOf(rule.config);
    const result = addLinkDomain(s, { ...input, now: NOW });
    if (result.inserted) return { outcome: 'added', mode };
    const stored = listLinkDomains(s, input.ruleId).find((entry) => entry.domain === result.domain);
    return { outcome: 'already-present', listType: stored?.listType ?? input.listType, mode };
  },
  listLinkDomains: (ruleId) => listLinkDomains(s, ruleId),
  removeLinkDomain: (input) => {
    const rule = findRuleKindAndConfig(s, input.ruleId);
    if (rule === undefined) return { outcome: 'no-such-rule' };
    if (rule.kind !== 'link_domain') return { outcome: 'wrong-kind' };
    const mode = linkDomainModeOf(rule.config);
    const removed = removeLinkDomain(s, input.ruleId, input.domain);
    return { outcome: removed ? 'removed' : 'not-present', mode };
  },
  createAutomodRule: notNeeded('createAutomodRule'),
  setAutomodRuleConfig: notNeeded('setAutomodRuleConfig'),
  setAutomodRuleMode: notNeeded('setAutomodRuleMode'),
  addAutomodExemption: notNeeded('addAutomodExemption'),
  addAutomodAllowlistPhrase: notNeeded('addAutomodAllowlistPhrase'),
  removeAutomodExemption: notNeeded('removeAutomodExemption'),
  setRoute: notNeeded('setRoute'),
  setRouteEnabled: notNeeded('setRouteEnabled'),
  excludeChannel: notNeeded('excludeChannel'),
  unexcludeChannel: notNeeded('unexcludeChannel'),
  retryJob: notNeeded('retryJob'),
  publishPanel: notNeeded('publishPanel'),
  enqueueReconcile: notNeeded('enqueueReconcile'),
  findBatch: notNeeded('findBatch'),
  countUndoable: notNeeded('countUndoable'),
  enqueueUndo: notNeeded('enqueueUndo'),
  grantAdoptionAllowance: notNeeded('grantAdoptionAllowance'),
  adoptionAllowance: notNeeded('adoptionAllowance'),
});

const instance: OpsInstance = {
  startedAtMs: NOW,
  readonly: false,
  env: 'test',
  gateway: () => ({ connected: true, pingMs: undefined, guildCount: 1 }),
  doctor: () => ({ ok: true, text: 'not used by this test', data: null }),
  redactedConfig: () => ({}),
  reissueBootstrapToken: () => ({ ok: false, reason: 'readonly' }),
  backupNow: notNeeded('backupNow'),
  backupList: notNeeded('backupList'),
};

const actor: Actor = { type: 'operator_cli', id: undefined, roleIds: [], unixUserClaimed: 'test' };

const message = (content: string): PredicateInput => ({
  guildId: GUILD,
  channelId: '500000000000000001',
  messageId: '600000000000000001',
  authorId: '700000000000000001',
  eventKind: 'messageCreate',
  content,
  rawContent: content,
  mentionedUserIds: [],
  mentionedRoleIds: [],
  mentionsEveryone: false,
  attachments: [],
  atMs: NOW,
});

describe('the CLI write path for the invite allowlist (Task 9, plan ruling PR-19)', () => {
  it('an added code stops the invite predicate firing on it', () => {
    createRule(scope, {
      ruleId: 'invite-rule',
      kind: 'invite',
      name: 'invites',
      config: '{}',
      now: NOW,
    });

    const cache = createPredicateCache();
    const content = 'come join us: discord.gg/clubhouse';

    // Before: the rule's allowlist is empty, so the club's own invite fires.
    const before = listEnabledRules(scope).find((r) => r.ruleId === 'invite-rule');
    if (before === undefined) throw new Error('rule should exist');
    const outcomeBefore = evaluateRule(cache, before, message(content));
    expect(outcomeBefore.kind).toBe('match');

    // The command: found the way the operator socket finds it, by name in
    // the registered surface, and run the way the plan's own Step 1 example
    // calls it — directly, not through the confirm/audit machinery, which
    // has its own coverage in `packages/core/src/ops/commands/automod.test.ts`.
    const command = OPERATOR_COMMANDS.find((c) => c.name === 'automod invite-allow');
    if (command === undefined) throw new Error('automod invite-allow must be registered');

    const ctx: OpsContext = {
      guildId: GUILD,
      now: () => NOW,
      ports: portsFor(scope),
      actor,
      instance,
    };
    const parsed = command.runParsed(ctx, {
      ruleId: 'invite-rule',
      code: 'clubhouse',
      label: 'our own server',
    });
    expect(parsed.ok).toBe(true);

    // After: re-read through `listEnabledRules` — real hydration, not a
    // cached reference to `before` — and evaluate again with the SAME cache.
    // Reusing it is the point: it proves the rule's fingerprint changed and
    // invalidated the stale compiled artifact, rather than the test working
    // around a cache that was never populated in the first place. A fresh
    // cache per evaluation would pass this test even if the fingerprint
    // never hashed `inviteAllowlist` at all — obligation 2's exact failure
    // mode, observed from the outside this time rather than at the unit
    // level `fingerprint.test.ts` already covers.
    const after = listEnabledRules(scope).find((r) => r.ruleId === 'invite-rule');
    if (after === undefined) throw new Error('rule should still exist');
    expect(after.inviteAllowlist).toEqual([{ code: 'clubhouse', label: 'our own server' }]);

    const outcomeAfter = evaluateRule(cache, after, message(content));
    expect(outcomeAfter.kind).toBe('no-match');
  });

  it('refuses to add an entry to a rule that does not exist', () => {
    const command = OPERATOR_COMMANDS.find((c) => c.name === 'automod invite-allow');
    if (command === undefined) throw new Error('automod invite-allow must be registered');
    const ctx: OpsContext = {
      guildId: GUILD,
      now: () => NOW,
      ports: portsFor(scope),
      actor,
      instance,
    };

    const parsed = command.runParsed(ctx, { ruleId: 'no-such-rule', code: 'x', label: 'y' });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.result).toMatchObject({
      data: { ok: false, reason: 'no-such-rule' },
    });
  });

  it('refuses invite-allow against a rule that exists but is the wrong kind, rather than writing a row nothing will ever read (IMPORTANT-7)', () => {
    // `keyword_filter`'s `compile` never reads `inviteAllowlist` — a write
    // through this command against such a rule would be silently inert
    // forever, which is exactly the failure `ruleExists` alone could not
    // catch (it only answers "does this id name a rule at all").
    createRule(scope, {
      ruleId: 'word-filter-rule',
      kind: 'keyword_filter',
      name: 'words',
      config: '{}',
      now: NOW,
    });

    const command = OPERATOR_COMMANDS.find((c) => c.name === 'automod invite-allow');
    if (command === undefined) throw new Error('automod invite-allow must be registered');
    const ctx: OpsContext = {
      guildId: GUILD,
      now: () => NOW,
      ports: portsFor(scope),
      actor,
      instance,
    };

    const parsed = command.runParsed(ctx, {
      ruleId: 'word-filter-rule',
      code: 'clubhouse',
      label: 'our own server',
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.result).toMatchObject({ data: { ok: false, reason: 'wrong-kind' } });

    // Nothing was written: the rule's invite allowlist stays empty.
    expect(listInviteAllowlist(scope, 'word-filter-rule')).toEqual([]);
  });
});

describe('the CLI write path for the link_domain lists (Task 9, plan ruling PR-19)', () => {
  it("names the domain's stored listType, not the operator's requested one, on a repeat add under the other list (IMPORTANT-1)", () => {
    createRule(scope, {
      ruleId: 'domain-rule',
      kind: 'link_domain',
      name: 'links',
      config: '{"mode":"allow"}',
      now: NOW,
    });

    const addCommand = OPERATOR_COMMANDS.find((c) => c.name === 'automod domain-add');
    if (addCommand === undefined) throw new Error('automod domain-add must be registered');
    const ctx: OpsContext = {
      guildId: GUILD,
      now: () => NOW,
      ports: portsFor(scope),
      actor,
      instance,
    };

    const first = addCommand.runParsed(ctx, {
      ruleId: 'domain-rule',
      domain: 'example.com',
      listType: 'deny',
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const firstResult = first.result;
    if (firstResult instanceof Promise) throw new Error('expected a synchronous result');
    expect(firstResult.data).toMatchObject({ ok: true, listType: 'deny' });

    // Same domain, the *other* listType: the primary key is (guild, rule,
    // domain), so this is a no-op — and the message must name the listType
    // actually stored (deny, from the first add), not the one just asked
    // for (allow), or an operator reading it would believe a move happened
    // that did not.
    const second = addCommand.runParsed(ctx, {
      ruleId: 'domain-rule',
      domain: 'example.com',
      listType: 'allow',
    });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    const secondResult = second.result;
    if (secondResult instanceof Promise) throw new Error('expected a synchronous result');
    expect(secondResult.data).toMatchObject({ ok: true, alreadyPresent: true, listType: 'deny' });
    expect(secondResult.text).toContain("already on rule domain-rule's deny list");
    expect(secondResult.text).not.toContain("already on rule domain-rule's allow list");

    expect(listLinkDomains(scope, 'domain-rule')).toEqual([
      { domain: 'example.com', listType: 'deny' },
    ]);
  });

  it('removes a domain added in a different case, because removal canonicalises the same way add does (IMPORTANT-2)', () => {
    createRule(scope, {
      ruleId: 'domain-rule-2',
      kind: 'link_domain',
      name: 'links',
      config: '{"mode":"deny"}',
      now: NOW,
    });

    const addCommand = OPERATOR_COMMANDS.find((c) => c.name === 'automod domain-add');
    const rmCommand = OPERATOR_COMMANDS.find((c) => c.name === 'automod domain-rm');
    if (addCommand === undefined || rmCommand === undefined) {
      throw new Error('automod domain-add / domain-rm must be registered');
    }
    const ctx: OpsContext = {
      guildId: GUILD,
      now: () => NOW,
      ports: portsFor(scope),
      actor,
      instance,
    };

    addCommand.runParsed(ctx, {
      ruleId: 'domain-rule-2',
      domain: 'example.com',
      listType: 'deny',
    });
    expect(listLinkDomains(scope, 'domain-rule-2')).toEqual([
      { domain: 'example.com', listType: 'deny' },
    ]);

    // Removing 'WWW.Example.COM' must find the row stored as 'example.com':
    // `addLinkDomain` canonicalises (lower-case, strip leading www.), and
    // until IMPORTANT-2's fix `removeLinkDomain` compared verbatim, so this
    // deleted nothing and the operator had to reverse-engineer the stored
    // form from the printed list.
    const removed = rmCommand.runParsed(ctx, {
      ruleId: 'domain-rule-2',
      domain: 'WWW.Example.COM',
    });
    expect(removed.ok).toBe(true);
    if (!removed.ok) return;
    const removedResult = removed.result;
    if (removedResult instanceof Promise) throw new Error('expected a synchronous result');
    expect(removedResult.data).toMatchObject({ ok: true, removed: true });
    expect(listLinkDomains(scope, 'domain-rule-2')).toEqual([]);
  });
});
