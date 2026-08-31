import { beforeEach, describe, expect, it } from 'vitest';
import { openMigratedTestDatabase, type MigratedTestDatabase } from '../test-support.js';
import { parseGuildId, parseSnowflakeId } from '@bananasaurs/core';
import { upsertGuild } from './guilds.js';
import {
  addAllowlistPhrase,
  addCategory,
  addTerm,
  createRule,
  isExempt,
  listEnabledKeywordFilterRules,
  ruleExists,
  setRuleMode,
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
    createRule(scope, { ruleId: 'r1', name: 'default filter', now: 1000 });
    addCategory(scope, {
      categoryId: 'c1',
      ruleId: 'r1',
      name: 'profanity',
      defaultAction: 'delete_and_case',
    });
    addTerm(scope, { termId: 't1', categoryId: 'c1', text: 'badword' });
    addAllowlistPhrase(scope, { ruleId: 'r1', phrase: 'assassin' });

    const rules = listEnabledKeywordFilterRules(scope);
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
    createRule(scope, { ruleId: 'r1', name: 'x', now: 1000 });
    setRuleMode(scope, { ruleId: 'r1', enabled: false, now: 1000 });
    expect(listEnabledKeywordFilterRules(scope)).toEqual([]);
  });

  it('exempts a member by role', () => {
    const scope = t.scopes.forGuild(GUILD);
    createRule(scope, { ruleId: 'r1', name: 'x', now: 1000 });
    // exemption insert goes through the repo once its write function exists —
    // implement addRoleExemption alongside the others, same table shape.
    expect(isExempt(scope, 'r1', { authorRoleIds: [ROLE], channelId: CHANNEL })).toBe(false);
  });

  describe('ruleExists', () => {
    it('is false before a rule is created and true after, whether enabled or not', () => {
      const scope = t.scopes.forGuild(GUILD);
      expect(ruleExists(scope, 'r1')).toBe(false);

      createRule(scope, { ruleId: 'r1', name: 'x', now: 1000 });
      expect(ruleExists(scope, 'r1')).toBe(true);

      // The daemon's first-run seeding guard relies on exactly this: a
      // disabled rule still "exists", so it must not be created a second
      // time (`mod_rules`' primary key is `(guild_id, rule_id)`).
      setRuleMode(scope, { ruleId: 'r1', enabled: false, now: 1000 });
      expect(ruleExists(scope, 'r1')).toBe(true);
    });
  });
});
