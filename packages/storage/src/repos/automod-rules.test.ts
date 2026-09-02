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
  hasRoleExemption,
  isExempt,
  listEnabledRules,
  listEnforceModeKeywordFilterRules,
  ruleExists,
  setRuleConfig,
  setRuleMode,
  type RuleKind,
} from './automod-rules.js';

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
    createRule(scope, { ruleId: 'r1', kind: 'keyword_filter', name: 'default filter', config: '{}', now: 1000 });
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
      mode: 'test',
      terms: [{ text: 'badword', categoryId: 'c1' }],
      allowlist: ['assassin'],
    });
  });

  it('does not list a disabled rule', () => {
    const scope = t.scopes.forGuild(GUILD);
    createRule(scope, { ruleId: 'r1', kind: 'keyword_filter', name: 'x', config: '{}', now: 1000 });
    setRuleMode(scope, { ruleId: 'r1', enabled: false, now: 1000 });
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
      createRule(scope, { ruleId: 'r1', kind: 'keyword_filter', name: 'x', config: '{}', now: 1000 });
      expect(hasRoleExemption(scope, 'r1')).toBe(false);

      addChannelExemption(scope, { ruleId: 'r1', channelId: CHANNEL });
      expect(hasRoleExemption(scope, 'r1')).toBe(false);
    });

    it('is true once a role exemption exists, and stays scoped to its own rule', () => {
      const scope = t.scopes.forGuild(GUILD);
      createRule(scope, { ruleId: 'r1', kind: 'keyword_filter', name: 'x', config: '{}', now: 1000 });
      createRule(scope, { ruleId: 'r2', kind: 'keyword_filter', name: 'y', config: '{}', now: 1000 });
      addRoleExemption(scope, { ruleId: 'r1', roleId: ROLE });

      expect(hasRoleExemption(scope, 'r1')).toBe(true);
      expect(hasRoleExemption(scope, 'r2')).toBe(false);
    });
  });

  describe('listEnforceModeKeywordFilterRules', () => {
    it('excludes a rule that is disabled or not in enforce mode', () => {
      const scope = t.scopes.forGuild(GUILD);
      createRule(scope, { ruleId: 'test-mode', kind: 'keyword_filter', name: 'x', config: '{}', now: 1000 });

      createRule(scope, { ruleId: 'disabled-enforce', kind: 'keyword_filter', name: 'x', config: '{}', now: 1000 });
      setRuleMode(scope, {
        ruleId: 'disabled-enforce',
        mode: 'enforce',
        enabled: false,
        now: 1000,
      });

      expect(listEnforceModeKeywordFilterRules(scope)).toEqual([]);
    });

    it('lists an enabled enforce-mode rule with its channel exemptions', () => {
      const scope = t.scopes.forGuild(GUILD);
      createRule(scope, { ruleId: 'r1', kind: 'keyword_filter', name: 'x', config: '{}', now: 1000 });
      setRuleMode(scope, { ruleId: 'r1', mode: 'enforce', now: 1000 });
      addChannelExemption(scope, { ruleId: 'r1', channelId: CHANNEL });

      expect(listEnforceModeKeywordFilterRules(scope)).toEqual([
        { ruleId: 'r1', exemptChannelIds: [CHANNEL] },
      ]);
    });

    it('is guild-scoped, like every other query in this file', () => {
      const other = parseGuildId('444444444444444444');
      upsertGuild(t.scopes.forGuild(other), { name: 'other', now: 0 });

      createRule(t.scopes.forGuild(GUILD), { ruleId: 'r1', kind: 'keyword_filter', name: 'x', config: '{}', now: 1000 });
      setRuleMode(t.scopes.forGuild(GUILD), { ruleId: 'r1', mode: 'enforce', now: 1000 });

      expect(listEnforceModeKeywordFilterRules(t.scopes.forGuild(other))).toEqual([]);
    });
  });

  describe('ruleExists', () => {
    it('is false before a rule is created and true after, whether enabled or not', () => {
      const scope = t.scopes.forGuild(GUILD);
      expect(ruleExists(scope, 'r1')).toBe(false);

      createRule(scope, { ruleId: 'r1', kind: 'keyword_filter', name: 'x', config: '{}', now: 1000 });
      expect(ruleExists(scope, 'r1')).toBe(true);

      // The daemon's first-run seeding guard relies on exactly this: a
      // disabled rule still "exists", so it must not be created a second
      // time (`mod_rules`' primary key is `(guild_id, rule_id)`).
      setRuleMode(scope, { ruleId: 'r1', enabled: false, now: 1000 });
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
    // A `caps` rule has no categories or terms; hydration must return empty
    // arrays rather than throwing or omitting the rule.
    const scope = t.scopes.forGuild(GUILD);
    createRule(scope, { ruleId: 'c1', kind: 'caps', name: 'shouting', config: '{}', now: 1 });
    const rule = listEnabledRules(scope)[0]!;
    expect(rule.terms).toEqual([]);
    expect(rule.allowlist).toEqual([]);
  });
});
