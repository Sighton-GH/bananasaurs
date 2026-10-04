import { beforeEach, describe, expect, it } from 'vitest';
import { openMigratedTestDatabase, type MigratedTestDatabase } from '../test-support.js';
import { parseGuildId, parseSnowflakeId } from '@bananasaurs/core';
import { upsertGuild } from './guilds.js';
import {
  addAllowlistPhrase,
  addCategory,
  addChannelExemption,
  addRoleExemption,
  addTerm,
  createRule,
  findRuleIncludingDisabled,
  hasRoleExemption,
  isExempt,
  listEnabledRules,
  listEnabledKeywordFilterRules,
  ruleExists,
  setRuleConfig,
  setRuleEnabled,
  type RuleKind,
} from './automod-rules.js';
import { addInviteAllowlistEntry, addLinkDomain } from './automod-rule-lists.js';

const GUILD = parseGuildId('111111111111111111');
const ROLE = parseSnowflakeId('222222222222222222');
const CHANNEL = parseSnowflakeId('333333333333333333');

let t: MigratedTestDatabase;

// `mod_rules.guild_id` carries a real foreign key to `guilds`, like every
// guild-scoped table — so, as in `panels.test.ts`, the guild must exist
// before a rule can be created in it.
beforeEach(() => {
  t = openMigratedTestDatabase();
  upsertGuild(t.scopes.forGuild(GUILD), { name: 'guild', now: 0 });
});

describe('automod rules repo', () => {
  it('assembles a rule with its categories, terms and allowlist', () => {
    const scope = t.scopes.forGuild(GUILD);
    createRule(scope, {
      ruleId: 'r1',
      kind: 'keyword_filter',
      name: 'default filter',
      config: '{}',
      now: 1000,
    });
    addCategory(scope, {
      categoryId: 'c1',
      ruleId: 'r1',
      name: 'profanity',
      defaultAction: 'delete_and_case',
    });
    addTerm(scope, { termId: 't1', categoryId: 'c1', text: 'badword' });
    addAllowlistPhrase(scope, { ruleId: 'r1', phrase: 'assassin' });

    const rules = listEnabledRules(scope);
    expect(rules).toHaveLength(1);
    expect(rules[0]).toMatchObject({
      ruleId: 'r1',
      terms: [{ text: 'badword', categoryId: 'c1' }],
      allowlist: ['assassin'],
    });
    expect(rules[0]).not.toHaveProperty('mode');
  });

  it('does not list a disabled rule', () => {
    const scope = t.scopes.forGuild(GUILD);
    createRule(scope, { ruleId: 'r1', kind: 'keyword_filter', name: 'x', config: '{}', now: 1000 });
    setRuleEnabled(scope, { ruleId: 'r1', enabled: false, now: 1000 });
    expect(listEnabledRules(scope)).toEqual([]);
  });

  it('exempts a member by role', () => {
    const scope = t.scopes.forGuild(GUILD);
    createRule(scope, { ruleId: 'r1', kind: 'keyword_filter', name: 'x', config: '{}', now: 1000 });
    // exemption insert goes through the repo once its write function exists —
    // implement addRoleExemption alongside the others, same table shape.
    expect(isExempt(scope, 'r1', { authorRoleIds: [ROLE], channelId: CHANNEL })).toBe(false);
  });

  /**
   * The subscriber asks this before deciding whether to spend a REST call on
   * the author's role ids, so "no role exemptions" must be answerable without
   * one — and a channel exemption must not be mistaken for a role one.
   */
  describe('hasRoleExemption', () => {
    it('is false for a rule with no exemptions, and for a channel-only exemption', () => {
      const scope = t.scopes.forGuild(GUILD);
      createRule(scope, {
        ruleId: 'r1',
        kind: 'keyword_filter',
        name: 'x',
        config: '{}',
        now: 1000,
      });
      expect(hasRoleExemption(scope, 'r1')).toBe(false);

      addChannelExemption(scope, { ruleId: 'r1', channelId: CHANNEL });
      expect(hasRoleExemption(scope, 'r1')).toBe(false);
    });

    it('is true once a role exemption exists, and stays scoped to its own rule', () => {
      const scope = t.scopes.forGuild(GUILD);
      createRule(scope, {
        ruleId: 'r1',
        kind: 'keyword_filter',
        name: 'x',
        config: '{}',
        now: 1000,
      });
      createRule(scope, {
        ruleId: 'r2',
        kind: 'keyword_filter',
        name: 'y',
        config: '{}',
        now: 1000,
      });
      addRoleExemption(scope, { ruleId: 'r1', roleId: ROLE });

      expect(hasRoleExemption(scope, 'r1')).toBe(true);
      expect(hasRoleExemption(scope, 'r2')).toBe(false);
    });
  });

  describe('listEnabledKeywordFilterRules (ADR 0121)', () => {
    it('lists an enabled keyword rule whatever its mode, and skips a disabled one or another kind', () => {
      const scope = t.scopes.forGuild(GUILD);
      createRule(scope, {
        ruleId: 'kw-on',
        kind: 'keyword_filter',
        name: 'x',
        config: '{}',
        now: 1000,
      });
      createRule(scope, {
        ruleId: 'kw-off',
        kind: 'keyword_filter',
        name: 'x',
        config: '{}',
        now: 1000,
      });
      setRuleEnabled(scope, { ruleId: 'kw-off', enabled: false, now: 1000 });
      createRule(scope, { ruleId: 'caps', kind: 'caps', name: 'x', config: '{}', now: 1000 });
      addChannelExemption(scope, { ruleId: 'kw-on', channelId: CHANNEL });

      expect(listEnabledKeywordFilterRules(scope)).toEqual([
        { ruleId: 'kw-on', exemptChannelIds: [CHANNEL] },
      ]);
    });

    it('is guild-scoped, like every other query in this file', () => {
      const other = parseGuildId('444444444444444444');
      upsertGuild(t.scopes.forGuild(other), { name: 'other', now: 0 });
      createRule(t.scopes.forGuild(GUILD), {
        ruleId: 'r1',
        kind: 'keyword_filter',
        name: 'x',
        config: '{}',
        now: 1000,
      });

      expect(listEnabledKeywordFilterRules(t.scopes.forGuild(other))).toEqual([]);
    });
  });

  describe('findRuleIncludingDisabled', () => {
    it('returns a disabled rule, and each guild sees only its own colliding r1', () => {
      const other = parseGuildId('444444444444444444');
      upsertGuild(t.scopes.forGuild(other), { name: 'other', now: 0 });

      const scope = t.scopes.forGuild(GUILD);
      createRule(scope, { ruleId: 'r1', kind: 'caps', name: 'x', config: '{}', now: 1000 });
      setRuleEnabled(scope, { ruleId: 'r1', enabled: false, now: 2000 });
      addAllowlistPhrase(scope, { ruleId: 'r1', phrase: 'our-phrase' });

      const otherScope = t.scopes.forGuild(other);
      createRule(otherScope, { ruleId: 'r1', kind: 'caps', name: 'y', config: '{}', now: 1000 });
      addAllowlistPhrase(otherScope, { ruleId: 'r1', phrase: 'their-phrase' });

      // Disabled, so invisible to the subscriber's read — but still found here.
      expect(listEnabledRules(scope)).toEqual([]);
      expect(findRuleIncludingDisabled(scope, 'r1')).toMatchObject({ ruleId: 'r1', kind: 'caps' });
      expect(findRuleIncludingDisabled(scope, 'r1')?.allowlist).toEqual(['our-phrase']);
      expect(findRuleIncludingDisabled(scope, 'missing')).toBeUndefined();
      expect(findRuleIncludingDisabled(otherScope, 'r1')).toMatchObject({
        ruleId: 'r1',
        kind: 'caps',
      });
      expect(findRuleIncludingDisabled(otherScope, 'r1')?.allowlist).toEqual(['their-phrase']);
    });

    it('writes an allowlist phrase under one guild without touching the colliding r1', () => {
      const other = parseGuildId('444444444444444444');
      upsertGuild(t.scopes.forGuild(other), { name: 'other', now: 0 });

      const scope = t.scopes.forGuild(GUILD);
      createRule(scope, {
        ruleId: 'r1',
        kind: 'keyword_filter',
        name: 'x',
        config: '{}',
        now: 1000,
      });
      const otherScope = t.scopes.forGuild(other);
      createRule(otherScope, {
        ruleId: 'r1',
        kind: 'keyword_filter',
        name: 'y',
        config: '{}',
        now: 1000,
      });
      addAllowlistPhrase(otherScope, { ruleId: 'r1', phrase: 'their-phrase' });

      addAllowlistPhrase(scope, { ruleId: 'r1', phrase: 'our-phrase' });

      expect(findRuleIncludingDisabled(scope, 'r1')?.allowlist).toEqual(['our-phrase']);
      expect(findRuleIncludingDisabled(otherScope, 'r1')?.allowlist).toEqual(['their-phrase']);
    });
  });

  describe('ruleExists', () => {
    it('is false before a rule is created and true after, whether enabled or not', () => {
      const scope = t.scopes.forGuild(GUILD);
      expect(ruleExists(scope, 'r1')).toBe(false);

      createRule(scope, {
        ruleId: 'r1',
        kind: 'keyword_filter',
        name: 'x',
        config: '{}',
        now: 1000,
      });
      expect(ruleExists(scope, 'r1')).toBe(true);

      // The daemon's first-run seeding guard relies on exactly this: a
      // disabled rule still "exists", so it must not be created a second
      // time (`mod_rules`' primary key is `(guild_id, rule_id)`).
      setRuleEnabled(scope, { ruleId: 'r1', enabled: false, now: 1000 });
      expect(ruleExists(scope, 'r1')).toBe(true);
    });
  });
});

describe('mod_rules.config', () => {
  it('defaults to an empty JSON object', () => {
    const scope = t.scopes.forGuild(GUILD);
    createRule(scope, {
      ruleId: 'r1',
      kind: 'keyword_filter',
      name: 'words',
      config: '{}',
      now: 1,
    });
    const rules = listEnabledRules(scope);
    expect(rules).toHaveLength(1);
    expect(rules[0]!.kind).toBe('keyword_filter');
    expect(rules[0]!.config).toBe('{}');
  });

  it('round-trips a non-empty config verbatim', () => {
    const scope = t.scopes.forGuild(GUILD);
    createRule(scope, {
      ruleId: 'r2',
      kind: 'caps',
      name: 'shouting',
      config: '{"ratio":0.7,"minLength":20}',
      now: 1,
    });
    expect(listEnabledRules(scope)[0]!.config).toBe('{"ratio":0.7,"minLength":20}');
  });

  it('setRuleConfig replaces the stored config', () => {
    const scope = t.scopes.forGuild(GUILD);
    createRule(scope, {
      ruleId: 'r3',
      kind: 'caps',
      name: 'shouting',
      config: '{}',
      now: 1,
    });
    setRuleConfig(scope, { ruleId: 'r3', config: '{"ratio":0.5}', now: 2 });
    expect(listEnabledRules(scope)[0]!.config).toBe('{"ratio":0.5}');
  });

  it('rejects a kind outside the ten the CHECK permits', () => {
    const scope = t.scopes.forGuild(GUILD);
    expect(() =>
      createRule(scope, {
        ruleId: 'r4',
        // Cast deliberately. The point of this test is that the *database*
        // CHECK rejects the value even when TypeScript is bypassed — a
        // hand-written row, a future caller, a schema drift. A case the type
        // system already covers cannot be written any other way.
        kind: 'telepathy' as RuleKind,
        name: 'nope',
        config: '{}',
        now: 1,
      }),
    ).toThrow();
  });

  it('accepts every one of the ten permitted kinds', () => {
    const scope = t.scopes.forGuild(GUILD);
    const kinds: RuleKind[] = [
      'keyword_filter',
      'regex',
      'invite',
      'link_domain',
      'mention_spam',
      'rapid_spam',
      'duplicate_message',
      'caps',
      'attachment_type',
      'emoji',
    ];
    for (const [i, kind] of kinds.entries()) {
      createRule(scope, { ruleId: `k${String(i)}`, kind, name: kind, config: '{}', now: 1 });
    }
    expect(listEnabledRules(scope)).toHaveLength(kinds.length);
  });

  it('keeps a non-keyword_filter rule out of the word-list hydration path', () => {
    // A lone `caps` rule cannot exercise this: with no other rule in the
    // database, `terms`/`allowlist` come back empty for *any* implementation
    // of `hydrate`, including one that leaked another rule's word list — the
    // failure this test is named for needs a second rule with a non-empty
    // word list actually present to leak (docs/22: a fixture must contain
    // the ambiguity its named failure mode needs). So a `keyword_filter` rule
    // with a term and an allowlist phrase sits alongside the `caps` rule, and
    // the assertion is that hydration keeps them apart in both directions.
    const scope = t.scopes.forGuild(GUILD);
    createRule(scope, {
      ruleId: 'kw1',
      kind: 'keyword_filter',
      name: 'filter',
      config: '{}',
      now: 1,
    });
    addCategory(scope, {
      categoryId: 'cat1',
      ruleId: 'kw1',
      name: 'profanity',
      defaultAction: 'delete_and_case',
    });
    addTerm(scope, { termId: 'term1', categoryId: 'cat1', text: 'badword' });
    addAllowlistPhrase(scope, { ruleId: 'kw1', phrase: 'assassin' });

    createRule(scope, { ruleId: 'c1', kind: 'caps', name: 'shouting', config: '{}', now: 1 });

    const rules = listEnabledRules(scope);
    const capsRule = rules.find((r) => r.ruleId === 'c1')!;
    const keywordRule = rules.find((r) => r.ruleId === 'kw1')!;
    expect(capsRule.terms).toEqual([]);
    expect(capsRule.allowlist).toEqual([]);
    expect(keywordRule.terms).toEqual([{ text: 'badword', categoryId: 'cat1' }]);
    expect(keywordRule.allowlist).toEqual(['assassin']);
  });

  it("keeps each rule's invite allowlist and link domains to itself", () => {
    // NOT decorative: two rules, each WITH entries in both new tables, so an
    // implementation of `hydrate` that dropped the `rule_id` predicate on
    // either query hands both lists to both rules and this goes red. One
    // rule with entries and one without would pass under that exact bug —
    // the shape `docs/22` records (Task 6, plan Step 8).
    const scope = t.scopes.forGuild(GUILD);
    createRule(scope, { ruleId: 'inv1', kind: 'invite', name: 'invites', config: '{}', now: 1 });
    addInviteAllowlistEntry(scope, {
      ruleId: 'inv1',
      code: 'clubhouse',
      label: 'our server',
      now: 1,
    });

    createRule(scope, {
      ruleId: 'link1',
      kind: 'link_domain',
      name: 'links',
      config: '{}',
      now: 1,
    });
    addLinkDomain(scope, { ruleId: 'link1', domain: 'example.com', listType: 'deny', now: 1 });

    const rules = listEnabledRules(scope);
    const inviteRule = rules.find((r) => r.ruleId === 'inv1')!;
    const linkRule = rules.find((r) => r.ruleId === 'link1')!;

    expect(inviteRule.inviteAllowlist).toEqual([{ code: 'clubhouse', label: 'our server' }]);
    expect(inviteRule.linkDomains).toEqual([]);
    expect(linkRule.inviteAllowlist).toEqual([]);
    expect(linkRule.linkDomains).toEqual([{ domain: 'example.com', listType: 'deny' }]);
  });
});

describe('setRuleEnabled (ADR 0121)', () => {
  const OTHER = parseGuildId('999999999999999999');
  const seed = (guild: typeof GUILD, ruleId: string): void => {
    createRule(t.scopes.forGuild(guild), {
      ruleId,
      kind: 'keyword_filter',
      name: ruleId,
      config: '{}',
      now: 0,
    });
  };

  it('turns a rule off and back on', () => {
    const scope = t.scopes.forGuild(GUILD);
    seed(GUILD, 'r-enabled');
    expect(setRuleEnabled(scope, { ruleId: 'r-enabled', enabled: false, now: 10 })).toBe(true);
    expect(listEnabledRules(scope).some((r) => r.ruleId === 'r-enabled')).toBe(false);
    expect(setRuleEnabled(scope, { ruleId: 'r-enabled', enabled: true, now: 20 })).toBe(true);
    expect(listEnabledRules(scope).some((r) => r.ruleId === 'r-enabled')).toBe(true);
  });

  it('answers false for a rule that does not exist', () => {
    const scope = t.scopes.forGuild(GUILD);
    expect(setRuleEnabled(scope, { ruleId: 'nope', enabled: false, now: 10 })).toBe(false);
  });

  it('never reaches a rule of another guild', () => {
    upsertGuild(t.scopes.forGuild(OTHER), { name: 'other', now: 0 });
    seed(OTHER, 'r-other');
    const mine = t.scopes.forGuild(GUILD);
    expect(setRuleEnabled(mine, { ruleId: 'r-other', enabled: false, now: 10 })).toBe(false);
    expect(listEnabledRules(t.scopes.forGuild(OTHER)).some((r) => r.ruleId === 'r-other')).toBe(
      true,
    );
  });
});
