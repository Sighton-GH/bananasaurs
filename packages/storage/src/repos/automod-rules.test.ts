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
  listEnforceModeKeywordFilterRules,
  ruleExists,
  setEnforceSignOff,
  setRuleConfig,
  setRuleMode,
  setRuleReady,
  type RuleKind,
} from './automod-rules.js';
import { addInviteAllowlistEntry, addLinkDomain } from './automod-rule-lists.js';
import { makeRuleEnforceableForTest } from '../test-support.js';

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

  describe('listEnforceModeKeywordFilterRules', () => {
    it('excludes a rule that is disabled or not in enforce mode', () => {
      const scope = t.scopes.forGuild(GUILD);
      createRule(scope, {
        ruleId: 'test-mode',
        kind: 'keyword_filter',
        name: 'x',
        config: '{}',
        now: 1000,
      });

      createRule(scope, {
        ruleId: 'disabled-enforce',
        kind: 'keyword_filter',
        name: 'x',
        config: '{}',
        now: 1000,
      });
      // PR-31 (plan ruling): `setRuleMode`'s enforce path now runs through
      // the ADR 0042 gate, which this test is not about — it reaches
      // `mode: 'enforce'` through the gate via the test-only helper rather
      // than around it.
      makeRuleEnforceableForTest(scope, 'disabled-enforce', 1000);
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
      createRule(scope, {
        ruleId: 'r1',
        kind: 'keyword_filter',
        name: 'x',
        config: '{}',
        now: 1000,
      });
      makeRuleEnforceableForTest(scope, 'r1', 1000); // PR-31: reach enforce through the gate.
      setRuleMode(scope, { ruleId: 'r1', mode: 'enforce', now: 1000 });
      addChannelExemption(scope, { ruleId: 'r1', channelId: CHANNEL });

      expect(listEnforceModeKeywordFilterRules(scope)).toEqual([
        { ruleId: 'r1', exemptChannelIds: [CHANNEL] },
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
      makeRuleEnforceableForTest(t.scopes.forGuild(GUILD), 'r1', 1000); // PR-31: through the gate.
      setRuleMode(t.scopes.forGuild(GUILD), { ruleId: 'r1', mode: 'enforce', now: 1000 });

      expect(listEnforceModeKeywordFilterRules(t.scopes.forGuild(other))).toEqual([]);
    });
  });

  describe('findRuleIncludingDisabled', () => {
    it('returns a disabled rule, and each guild sees only its own colliding r1', () => {
      const other = parseGuildId('444444444444444444');
      upsertGuild(t.scopes.forGuild(other), { name: 'other', now: 0 });

      const scope = t.scopes.forGuild(GUILD);
      createRule(scope, { ruleId: 'r1', kind: 'caps', name: 'x', config: '{}', now: 1000 });
      setRuleMode(scope, { ruleId: 'r1', enabled: false, now: 2000 });
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

/**
 * ADR 0042's eight new `mod_rules` columns — the cutover state machine
 * (PR-27), the two-tier false-positive gate's thresholds (PR-30), and the
 * low-volume sign-off (PR-29). Task 1 only adds the columns and widens the
 * read shape; `enforcementEligibility` and its writers arrive in Task 2/3.
 */
describe('mod_rules cutover-gate columns (ADR 0042)', () => {
  it('gives a freshly created rule the documented defaults', () => {
    const scope = t.scopes.forGuild(GUILD);
    createRule(scope, { ruleId: 'r1', kind: 'caps', name: 'shouting', config: '{}', now: 1000 });

    const rule = listEnabledRules(scope)[0]!;
    expect(rule).toMatchObject({
      cutoverState: 'not_started',
      observeStartedAt: null,
      legacyRuleRef: null,
      countsAsViolation: true,
      maxFalsePositiveRate: 0.05,
      minReviewedMatches: 20,
      enforceSignedOffBy: null,
      enforceSignedOffAt: null,
    });
  });

  /**
   * Raw inserts, deliberately bypassing `createRule`: these columns have no
   * writer yet (Task 2/3/6), so the only way to probe the CHECK today is a
   * hand-written row — exactly the "hand-edited row" scenario ADR 0042 §3
   * says the database-level CHECK must survive regardless.
   */
  const insertRawRule = (ruleId: string, column: string, value: unknown): void => {
    t.raw
      .prepare(
        `INSERT INTO mod_rules (guild_id, rule_id, kind, name, created_at, updated_at, ${column})
         VALUES (?, ?, 'caps', 'x', 0, 0, ?)`,
      )
      .run(GUILD, ruleId, value);
  };

  it('rejects a cutover_state the CHECK does not name', () => {
    expect(() => insertRawRule('bad-cutover', 'cutover_state', 'banana')).toThrow(
      /CHECK constraint failed/,
    );
  });

  it('accepts every cutover_state the state machine names (PR-27)', () => {
    for (const [i, state] of [
      'not_started',
      'observing',
      'ready',
      'cutover',
      'rolled_back',
    ].entries()) {
      expect(() => insertRawRule(`cutover-ok-${String(i)}`, 'cutover_state', state)).not.toThrow();
    }
  });

  /**
   * Both directions of the boundary (Global Constraint 7): a `>`/`<` typo in
   * either CHECK would pass a test that only probes obviously-invalid values.
   */
  it('max_false_positive_rate accepts exactly 0 and exactly 1', () => {
    expect(() => insertRawRule('rate-zero', 'max_false_positive_rate', 0)).not.toThrow();
    expect(() => insertRawRule('rate-one', 'max_false_positive_rate', 1)).not.toThrow();
  });

  it('max_false_positive_rate rejects just outside 0 and 1', () => {
    expect(() => insertRawRule('rate-neg', 'max_false_positive_rate', -0.1)).toThrow(
      /CHECK constraint failed/,
    );
    expect(() => insertRawRule('rate-over', 'max_false_positive_rate', 1.5)).toThrow(
      /CHECK constraint failed/,
    );
  });

  it('min_reviewed_matches accepts exactly 0 and rejects -1', () => {
    expect(() => insertRawRule('reviewed-zero', 'min_reviewed_matches', 0)).not.toThrow();
    expect(() => insertRawRule('reviewed-neg', 'min_reviewed_matches', -1)).toThrow(
      /CHECK constraint failed/,
    );
  });
});

/**
 * `automod ready` (Task 6, ADR 0042 §3/PR-27): the production writer for
 * `observing -> ready`, refused from every other state. Deliberately **not**
 * driven through `makeRuleEnforceableForTest` — that helper writes `ready`
 * with no precondition at all, and a test reaching `ready` through it would
 * prove nothing about `setRuleReady`'s own refusal. States are planted with
 * raw SQL or the real `setRuleMode`, the same choice `enforcement-gate.test.ts`
 * makes for the same reason.
 */
describe('setRuleReady', () => {
  const setCutoverStateRaw = (ruleId: string, state: string): void => {
    t.raw
      .prepare(`UPDATE mod_rules SET cutover_state = ? WHERE guild_id = ? AND rule_id = ?`)
      .run(state, GUILD, ruleId);
  };

  const cutoverStateOf = (ruleId: string): string =>
    (
      t.raw
        .prepare(`SELECT cutover_state FROM mod_rules WHERE guild_id = ? AND rule_id = ?`)
        .get(GUILD, ruleId) as { cutover_state: string }
    ).cutover_state;

  it('succeeds from observing, moving cutover_state to ready', () => {
    const scope = t.scopes.forGuild(GUILD);
    createRule(scope, { ruleId: 'r1', kind: 'caps', name: 'x', config: '{}', now: 0 });
    setRuleMode(scope, { ruleId: 'r1', mode: 'observe', now: 1000 });

    expect(setRuleReady(scope, { ruleId: 'r1', now: 2000 })).toEqual({ ok: true });
    expect(cutoverStateOf('r1')).toBe('ready');
  });

  it('refuses from rolled_back — without this, a rollback could be undone by ready then enforce, never revisiting observing', () => {
    // This is the test the brief names as the one that matters: ADR 0042
    // exists to prevent exactly this shortcut.
    const scope = t.scopes.forGuild(GUILD);
    createRule(scope, { ruleId: 'r1', kind: 'caps', name: 'x', config: '{}', now: 0 });
    setCutoverStateRaw('r1', 'rolled_back');

    const result = setRuleReady(scope, { ruleId: 'r1', now: 2000 });
    expect(result).toEqual({ ok: false, reason: 'not-observing', state: 'rolled_back' });
    // Refused, so nothing moved.
    expect(cutoverStateOf('r1')).toBe('rolled_back');
  });

  it('refuses from not_started — the operator has not started a window', () => {
    const scope = t.scopes.forGuild(GUILD);
    createRule(scope, { ruleId: 'r1', kind: 'caps', name: 'x', config: '{}', now: 0 });
    // cutover_state stays at its default, 'not_started'.

    expect(setRuleReady(scope, { ruleId: 'r1', now: 2000 })).toEqual({
      ok: false,
      reason: 'not-observing',
      state: 'not_started',
    });
  });

  it('refuses from cutover — already enforcing is not the same as ready to enforce', () => {
    const scope = t.scopes.forGuild(GUILD);
    createRule(scope, { ruleId: 'r1', kind: 'caps', name: 'x', config: '{}', now: 0 });
    setCutoverStateRaw('r1', 'cutover');

    expect(setRuleReady(scope, { ruleId: 'r1', now: 2000 })).toEqual({
      ok: false,
      reason: 'not-observing',
      state: 'cutover',
    });
  });

  it('refuses from ready itself — ready is not idempotent past the first call', () => {
    const scope = t.scopes.forGuild(GUILD);
    createRule(scope, { ruleId: 'r1', kind: 'caps', name: 'x', config: '{}', now: 0 });
    setCutoverStateRaw('r1', 'ready');

    expect(setRuleReady(scope, { ruleId: 'r1', now: 2000 })).toEqual({
      ok: false,
      reason: 'not-observing',
      state: 'ready',
    });
  });

  it('refuses for a rule id that does not exist, reporting not_started', () => {
    // Mirrors `enforcementEligibility`'s own treatment of a stale id: no row
    // means no evidence and no state, which is the same refusal a real
    // `not_started` row gets, rather than a distinct not-found branch.
    const scope = t.scopes.forGuild(GUILD);
    expect(setRuleReady(scope, { ruleId: 'does-not-exist', now: 2000 })).toEqual({
      ok: false,
      reason: 'not-observing',
      state: 'not_started',
    });
  });
});

/**
 * `automod signoff` (Task 6, ADR 0042 §4/PR-29): the plain write. The corpus
 * dry-run precondition is the command's job (`packages/core`, which storage
 * may not import per ADR 0014) — this repository function is deliberately
 * unconditional, the same way `setRuleConfig` is a plain `UPDATE` that trusts
 * its caller to have already validated the config.
 */
describe('setEnforceSignOff', () => {
  it('records enforce_signed_off_by and enforce_signed_off_at', () => {
    const scope = t.scopes.forGuild(GUILD);
    createRule(scope, { ruleId: 'r1', kind: 'caps', name: 'x', config: '{}', now: 0 });

    setEnforceSignOff(scope, { ruleId: 'r1', signedOffBy: 'cli:bryan', now: 5000 });

    const rule = listEnabledRules(scope)[0]!;
    expect(rule.enforceSignedOffBy).toBe('cli:bryan');
    expect(rule.enforceSignedOffAt).toBe(5000);
  });
});
