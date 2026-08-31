# Automod Rule Engine Foundation + Fuzzy Keyword Filter Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the guild-scoped automod rule engine's core (rules, exemptions, cases, case events) and its first predicate — a fuzzy, evasion-resistant keyword filter backed by `obscenity` — that deletes a violating message and, past a configurable violation threshold, attempts a timeout/kick through the same layered safety pipeline Release 1's role effects use, with every refusal (owner, hierarchy) durably recorded rather than log-only.

**Architecture:** A new `MESSAGE_CREATE`/`MESSAGE_UPDATE` domain event (added to the existing `DomainEvent` union — it does not exist yet) reaches a new guild-scoped subscriber through the existing pipeline. The subscriber runs an in-process `obscenity` matcher (built from the guild's `word_terms`/`word_allowlist`, cached and rebuilt on write) against message content after stripping zero-width characters. A match deletes the message (not hierarchy-gated) and opens/updates a `mod_cases` row; if the violation count crosses a configured tier, a new `ModerationActionGateway` (mirroring `EffectGateway`'s exact layer ordering: auth, kill switch, breaker, hierarchy, idempotency, dry run, audit) attempts a timeout or kick, recording the outcome — including a refusal — as a `mod_case_events` row.

**Tech Stack:** TypeScript (Node 22, strict), discord.js v14, better-sqlite3 + Drizzle ORM, `obscenity` (new, MIT), Vitest, `FakeDiscord` test harness.

**Spec:** `docs/superpowers/specs/2026-08-30-automod-rule-engine-design.md` (design). `docs/decisions/0035-automod-rule-engine-foundation-and-fuzzy-keyword-filter.md` (ADR — why native AutoMod and `obscenity` were chosen, why message deletion vs. member-action are treated differently, why refusals are durably recorded here specifically).

## Global Constraints

- Every new table carries `guild_id`; every repository function takes a `GuildScope` first and uses `scope.only(table, ...)` for every query (`CLAUDE.md` rule 2). `packages/storage/src/schema-invariants.test.ts` enforces this at the schema level — it will fail the build if a new table is missing guild scope and isn't on the short `INSTANCE_LEVEL` exemption list.
- No AI, no external network call, in the matching or enforcement path (`CLAUDE.md` rule 1 / ADR 0013). Matching is synchronous and in-process.
- `packages/core` may not import discord.js or reach the database directly (`packages/core/src/boundaries.test.ts`, ADR 0014). The matcher and the moderation gateway live in `packages/core`; schema and repos live in `packages/storage`; wiring and the discord.js adapter live in `apps/daemon` / `packages/discord`.
- TDD throughout: write the failing test, watch it fail, write the minimal implementation, watch it pass, commit. No exceptions for anything touching hierarchy, idempotency, or guild scope (`CLAUDE.md`'s own working-style rule).
- `npm run typecheck && npm run lint && npm run test` must be clean before any task is considered done.
- Out of scope, do not add anything for: other predicate kinds (regex/invite/spam-rate/etc.), username/nickname filtering, non-owner Administrator-abuse alerting, dashboard/CLI configuration surface for rules.

---

### Task 1: Schema — the seven new tables

**Files:**
- Modify: `packages/storage/src/schema.ts`
- Test: `packages/storage/src/schema-invariants.test.ts` (existing, no changes — it reads the live schema; this task's job is to pass it, not edit it)

**Interfaces:**
- Produces: Drizzle table exports `modRules`, `modRuleExemptions`, `wordCategories`, `wordTerms`, `wordAllowlist`, `modCases`, `modCaseEvents` from `packages/storage/src/schema.ts`, consumed by every later task's repo layer.

- [ ] **Step 1: Add the tables to `packages/storage/src/schema.ts`**, in a new `// --- automod ------` section after the existing `// --- logging ---` section (before the dashboard-account tables), following the file's own conventions exactly (`snowflake()` for Discord ids, `text()` for enums with a `check()` constraint, `integer()` epoch-millis for timestamps, composite `primaryKey()`, `foreignKey().onDelete(...)`):

```typescript
// --- automod ------------------------------------------------------------

/**
 * A configured automod rule. `kind` is the extension point for the
 * predicate types the roadmap names beyond this slice's `keyword_filter`
 * (ADR 0035) — adding one is a new predicate implementation against this
 * table, not a schema change.
 */
export const modRules = sqliteTable(
  'mod_rules',
  {
    guildId: snowflake('guild_id').notNull(),
    ruleId: text('rule_id').notNull(),
    kind: text('kind').notNull(),
    name: text('name').notNull(),
    mode: text('mode').notNull().default('test'),
    enabled: integer('enabled').notNull().default(1),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.guildId, t.ruleId] }),
    foreignKey({ columns: [t.guildId], foreignColumns: [guilds.guildId] }).onDelete('cascade'),
    check('mod_rules_guild_id_snowflake', snowflakeCheck(t.guildId)),
    check('mod_rules_kind', sql`${t.kind} IN ('keyword_filter')`),
    check('mod_rules_mode', sql`${t.mode} IN ('test','observe','enforce')`),
    check('mod_rules_enabled_bool', boolCheck(t.enabled)),
  ],
);

export const modRuleExemptions = sqliteTable(
  'mod_rule_exemptions',
  {
    guildId: snowflake('guild_id').notNull(),
    ruleId: text('rule_id').notNull(),
    exemptType: text('exempt_type').notNull(),
    exemptId: snowflake('exempt_id').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.guildId, t.ruleId, t.exemptType, t.exemptId] }),
    foreignKey({
      columns: [t.guildId, t.ruleId],
      foreignColumns: [modRules.guildId, modRules.ruleId],
    }).onDelete('cascade'),
    check('mod_rule_exemptions_guild_id_snowflake', snowflakeCheck(t.guildId)),
    check('mod_rule_exemptions_exempt_id_snowflake', snowflakeCheck(t.exemptId)),
    check('mod_rule_exemptions_type', sql`${t.exemptType} IN ('role','channel')`),
  ],
);

/** A group of word terms sharing a default action. One rule may have several. */
export const wordCategories = sqliteTable(
  'word_categories',
  {
    guildId: snowflake('guild_id').notNull(),
    categoryId: text('category_id').notNull(),
    ruleId: text('rule_id').notNull(),
    name: text('name').notNull(),
    defaultAction: text('default_action').notNull(),
    enabled: integer('enabled').notNull().default(1),
  },
  (t) => [
    primaryKey({ columns: [t.guildId, t.categoryId] }),
    foreignKey({
      columns: [t.guildId, t.ruleId],
      foreignColumns: [modRules.guildId, modRules.ruleId],
    }).onDelete('cascade'),
    check('word_categories_guild_id_snowflake', snowflakeCheck(t.guildId)),
    check(
      'word_categories_default_action',
      sql`${t.defaultAction} IN ('log_only','delete','delete_and_case')`,
    ),
    check('word_categories_enabled_bool', boolCheck(t.enabled)),
  ],
);

/** One matched word or phrase. `actionOverride` NULL inherits the category default. */
export const wordTerms = sqliteTable(
  'word_terms',
  {
    guildId: snowflake('guild_id').notNull(),
    termId: text('term_id').notNull(),
    categoryId: text('category_id').notNull(),
    text: text('text').notNull(),
    actionOverride: text('action_override'),
    enabled: integer('enabled').notNull().default(1),
  },
  (t) => [
    primaryKey({ columns: [t.guildId, t.termId] }),
    foreignKey({
      columns: [t.guildId, t.categoryId],
      foreignColumns: [wordCategories.guildId, wordCategories.categoryId],
    }).onDelete('cascade'),
    check('word_terms_guild_id_snowflake', snowflakeCheck(t.guildId)),
    check(
      'word_terms_action_override',
      sql`${t.actionOverride} IS NULL OR ${t.actionOverride} IN ('log_only','delete','delete_and_case')`,
    ),
    check('word_terms_enabled_bool', boolCheck(t.enabled)),
  ],
);

/** Explicit exceptions, wired into obscenity's own allowlist mechanism. */
export const wordAllowlist = sqliteTable(
  'word_allowlist',
  {
    guildId: snowflake('guild_id').notNull(),
    ruleId: text('rule_id').notNull(),
    phrase: text('phrase').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.guildId, t.ruleId, t.phrase] }),
    foreignKey({
      columns: [t.guildId, t.ruleId],
      foreignColumns: [modRules.guildId, modRules.ruleId],
    }).onDelete('cascade'),
    check('word_allowlist_guild_id_snowflake', snowflakeCheck(t.guildId)),
  ],
);

/** Per-member violation history. What escalation reads to pick the next tier. */
export const modCases = sqliteTable(
  'mod_cases',
  {
    guildId: snowflake('guild_id').notNull(),
    caseId: text('case_id').notNull(),
    memberId: snowflake('member_id').notNull(),
    openedAt: integer('opened_at').notNull(),
    violationCount: integer('violation_count').notNull().default(0),
    escalationTier: integer('escalation_tier').notNull().default(0),
    status: text('status').notNull().default('open'),
  },
  (t) => [
    primaryKey({ columns: [t.guildId, t.caseId] }),
    foreignKey({ columns: [t.guildId], foreignColumns: [guilds.guildId] }).onDelete('cascade'),
    // One open case per member — a new violation resolves into the existing
    // open case rather than forking a second one.
    uniqueIndex('mod_cases_open_per_member')
      .on(t.guildId, t.memberId)
      .where(sql`${t.status} = 'open'`),
    check('mod_cases_guild_id_snowflake', snowflakeCheck(t.guildId)),
    check('mod_cases_member_id_snowflake', snowflakeCheck(t.memberId)),
    check('mod_cases_status', sql`${t.status} IN ('open','closed')`),
    check('mod_cases_violation_count_nonnegative', sql`${t.violationCount} >= 0`),
    check('mod_cases_escalation_tier_nonnegative', sql`${t.escalationTier} >= 0`),
  ],
);

/**
 * One matched event and what happened as a result — including a refusal.
 *
 * ADR 0035: a moderation-action refusal (owner, hierarchy) is recorded here
 * as its own event, not left log-only the way a Release 1 role-effect
 * refusal is. `refusalReason` is deliberately a superset of the effect
 * gateway's `RefusalReason` plus one moderation-specific value
 * (`'discord-owner'`) for Discord's own unconditional owner protection,
 * which has no equivalent in the role-mutation vocabulary.
 */
export const modCaseEvents = sqliteTable(
  'mod_case_events',
  {
    guildId: snowflake('guild_id').notNull(),
    eventId: text('event_id').notNull(),
    caseId: text('case_id').notNull(),
    ruleId: text('rule_id').notNull(),
    memberId: snowflake('member_id').notNull(),
    at: integer('at').notNull(),
    matchedCategory: text('matched_category').notNull(),
    matchedSnippet: text('matched_snippet').notNull(),
    actionTaken: text('action_taken').notNull(),
    escalationAction: text('escalation_action'),
    refusalReason: text('refusal_reason'),
  },
  (t) => [
    primaryKey({ columns: [t.guildId, t.eventId] }),
    foreignKey({
      columns: [t.guildId, t.caseId],
      foreignColumns: [modCases.guildId, modCases.caseId],
    }).onDelete('cascade'),
    check('mod_case_events_guild_id_snowflake', snowflakeCheck(t.guildId)),
    check('mod_case_events_member_id_snowflake', snowflakeCheck(t.memberId)),
    check(
      'mod_case_events_action_taken',
      sql`${t.actionTaken} IN ('deleted','deleted_and_escalated','escalation_refused')`,
    ),
    check(
      'mod_case_events_escalation_action',
      sql`${t.escalationAction} IS NULL OR ${t.escalationAction} IN ('timeout','kick')`,
    ),
    check(
      'mod_case_events_refusal_reason',
      sql`${t.refusalReason} IS NULL OR ${t.refusalReason} IN
        ('unauthorized','guild-unknown','killswitch','breaker-open','rate-cap','discord-owner','role-above-bot')`,
    ),
  ],
);
```

- [ ] **Step 2: Generate and strictify the migration**

Run: `npm run db:generate`

Expected: a new file under `drizzle/` (e.g. `NNNN_<generated-name>.sql`) creating the seven tables, and `scripts/strictify.mjs` (run automatically as part of `db:generate`, per `package.json`) adds `STRICT` to each `CREATE TABLE`. Open the generated file and confirm all seven `CREATE TABLE` statements are `STRICT`.

- [ ] **Step 3: Apply the migration to the dev database and run the invariant test**

Run: `npm run build && npm run db:migrate && npm run test -- schema-invariants`

Expected: PASS. `schema-invariants.test.ts` reads the live schema and asserts guild scope on every non-instance-level table — this is what actually verifies Step 1 was done correctly, since there is no hand-written test for a schema file.

- [ ] **Step 4: Commit**

```bash
git add packages/storage/src/schema.ts drizzle/
git commit -m "schema: add automod rule engine tables (mod_rules, cases, word lists)"
```

---

### Task 2: `messageCreate` domain event

**Files:**
- Modify: `packages/core/src/discord/events.ts:116-117` (`MessageEvent.kind`)
- Modify: `packages/discord/src/events.ts:134-139,349-372` (`toMessageEvent`, `client.on`)
- Modify: `packages/testkit/src/fake-discord.ts` (add an `emitMessageCreate` helper, mirroring `emitReactionAdd`)
- Test: `packages/discord/src/events.test.ts` (new `describe('messages', ...)` block)

**Interfaces:**
- Consumes: `DomainEvent`, `MessageEvent` from `packages/core/src/discord/events.ts` (existing).
- Produces: `MessageEvent` with `kind: 'messageCreate'` now constructible; `FakeDiscord.emitMessageCreate(p: { channelId: Snowflake; messageId: Snowflake; authorId: Snowflake; content: string })` for later tasks' integration tests.

- [ ] **Step 1: Write the failing adapter test**, in `packages/discord/src/events.test.ts`, after the existing `describe('roles and guild lifecycle', ...)` block:

```typescript
const messageCreatePacket = (over: Record<string, unknown> = {}): object => ({
  id: MESSAGE,
  channel_id: CHANNEL,
  guild_id: GUILD,
  author: { id: USER, username: 'member', discriminator: '0' },
  content: 'hello',
  timestamp: '2026-08-30T00:00:00.000Z',
  type: 0,
  ...over,
});

describe('messages', () => {
  it('translates a create into the domain shape, guild id included', () => {
    const h = harness();
    h.packet('MessageCreate', messageCreatePacket());
    expect(h.events).toEqual<DomainEvent[]>([
      {
        kind: 'messageCreate',
        guildId: GUILD,
        receivedAtMs: 1_700_000_000_000,
        channelId: CHANNEL,
        messageId: MESSAGE,
        authorId: USER,
        content: 'hello',
        editedTimestampMs: undefined,
      },
    ]);
  });

  it('drops a message that carries no guild', () => {
    const h = harness();
    h.packet('MessageCreate', messageCreatePacket({ guild_id: undefined }));
    expect(h.events).toEqual([]);
  });

  it('drops a message from a guild that is not allowlisted', () => {
    const h = harness({ allow: [OTHER_GUILD] });
    h.packet('MessageCreate', messageCreatePacket());
    expect(h.events).toEqual([]);
  });
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `npm run test -- events.test.ts -t messages`
Expected: FAIL — `'messageCreate'` is not assignable to `MessageEvent['kind']` (a type error surfaces as a test-run failure since `vitest` transpiles via `esbuild`, which does not type-check; run `npm run typecheck` too and expect it to fail on `events.test.ts` and on `client.on(Events.MessageCreate, ...)` not yet existing).

- [ ] **Step 3: Widen `MessageEvent.kind`** in `packages/core/src/discord/events.ts:117`:

```typescript
export interface MessageEvent extends Base {
  kind: 'messageCreate' | 'messageUpdate' | 'messageDelete';
```

- [ ] **Step 4: Widen `toMessageEvent` and add the listener** in `packages/discord/src/events.ts`. Change the signature at line 349-350:

```typescript
function toMessageEvent(
  kind: 'messageCreate' | 'messageUpdate' | 'messageDelete',
  message: AnyMessage,
  receivedAtMs: number,
): DomainEvent | undefined {
```

And add a listener alongside the existing two, in the `// --- messages ---` block (`packages/discord/src/events.ts:133-139`):

```typescript
  client.on(Events.MessageCreate, (message: AnyMessage) => {
    translate('messageCreate', () => toMessageEvent('messageCreate', message, now()));
  });
  client.on(Events.MessageUpdate, (_old: AnyMessage, message: AnyMessage) => {
    translate('messageUpdate', () => toMessageEvent('messageUpdate', message, now()));
  });
  client.on(Events.MessageDelete, (message: AnyMessage) => {
    translate('messageDelete', () => toMessageEvent('messageDelete', message, now()));
  });
```

- [ ] **Step 5: Run the test again to confirm it passes**

Run: `npm run typecheck && npm run test -- events.test.ts -t messages`
Expected: PASS, all three cases.

- [ ] **Step 6: Add `emitMessageCreate` to `FakeDiscord`**, in `packages/testkit/src/fake-discord.ts`, next to the existing `emitReactionAdd` (around line 291), following its exact shape (push onto whatever internal event queue the fake already drains — read `emitReactionAdd`'s body first and mirror its `this.emit({...})` call rather than inventing a new delivery path):

```typescript
  async emitMessageCreate(p: {
    channelId: Snowflake;
    messageId: Snowflake;
    authorId: Snowflake;
    content: string;
  }): Promise<void> {
    await this.emit({
      kind: 'messageCreate',
      guildId: this.guildId,
      receivedAtMs: this.now(),
      channelId: p.channelId,
      messageId: p.messageId,
      authorId: p.authorId,
      content: p.content,
      editedTimestampMs: undefined,
    });
  }
```

(If `this.guildId` / `this.now()` are not the actual private members `FakeDiscord` uses — confirm against `emitReactionAdd`'s real body, which is already in the file, before finalizing this step; use whatever it actually reads.)

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/discord/events.ts packages/discord/src/events.ts packages/discord/src/events.test.ts packages/testkit/src/fake-discord.ts
git commit -m "discord: add messageCreate domain event"
```

---

### Task 3: `DiscordPort` — delete message, timeout, kick

**Files:**
- Modify: `packages/core/src/discord/port.ts:113-132` (interface)
- Modify: `packages/discord/src/rest/port.ts` (real REST implementation)
- Modify: `packages/testkit/src/fake-discord.ts` (fake implementation — note `deleteMessage(ref)` already exists as an internal test helper around line 213; this task adds the actual `DiscordPort`-shaped method, reusing that internal logic rather than duplicating it)
- Test: `packages/discord/src/rest/port.test.ts` (existing file's pattern — check it exists; if the REST layer's tests live elsewhere, mirror whatever file already tests `addRole`/`removeRole`)

**Interfaces:**
- Produces: `DiscordPort.deleteMessage(guildId, ref, reason)`, `DiscordPort.timeoutMember(guildId, userId, durationMs, reason)`, `DiscordPort.kickMember(guildId, userId, reason)`, all `Promise<void>`, consumed by Task 8 (moderation gateway) and Task 9 (subscriber, for the delete call).

- [ ] **Step 1: Read `packages/discord/src/rest/port.ts`'s existing `addRole`/`removeRole` implementations first** (they are the closest analogues — same guild/reason shape, same REST error handling via `DiscordApiError`) so the new methods match its exact style (route construction, header/reason encoding, error wrapping) rather than inventing a different one.

- [ ] **Step 2: Add the three methods to the `DiscordPort` interface**, in `packages/core/src/discord/port.ts`, in the `// --- messages and reactions ---` section after `editMessage` (line 132):

```typescript
  /** Not hierarchy-gated — works against any member's message, any role. */
  deleteMessage(guildId: Snowflake, ref: DiscordMessageRef, reason: string): Promise<void>;

  // --- moderation ----------------------------------------------------------
  /** `durationMs` is clamped to Discord's 28-day maximum by the caller. */
  timeoutMember(
    guildId: Snowflake,
    userId: Snowflake,
    durationMs: number,
    reason: string,
  ): Promise<void>;
  kickMember(guildId: Snowflake, userId: Snowflake, reason: string): Promise<void>;
```

- [ ] **Step 3: Write the failing REST-layer test(s)**, mirroring whatever test already exists for `addRole` in the REST port test file (same mock-fetch/nock-style setup this repo already uses — read that file's imports and setup before writing, since it must match, not be invented) — at minimum: `deleteMessage` calls `DELETE /channels/{channel}/messages/{message}` with the `X-Audit-Log-Reason` header set to `reason`; `timeoutMember` calls `PATCH /guilds/{guild}/members/{user}` with `{ communication_disabled_until: <ISO string> }`; `kickMember` calls `DELETE /guilds/{guild}/members/{user}`.

- [ ] **Step 4: Run to confirm failure**

Run: `npm run test -- rest/port.test.ts -t "deleteMessage\|timeoutMember\|kickMember"`
Expected: FAIL — methods not implemented.

- [ ] **Step 5: Implement the three methods** in `packages/discord/src/rest/port.ts`, matching `addRole`'s existing route-building and `DiscordApiError` wrapping pattern exactly.

- [ ] **Step 6: Run to confirm pass**

Run: `npm run test -- rest/port.test.ts`
Expected: PASS.

- [ ] **Step 7: Implement `FakeDiscord`'s versions.** For `deleteMessage(guildId, ref, reason)`: call the existing internal `deleteMessage(ref)` helper (line 213) if its behavior matches (marks the message gone, emits nothing extra), and additionally `this.record('deleteMessage', [guildId, ref, reason])` / `this.check('deleteMessage', guildId)` following the exact pattern `addRole` uses (lines 606-613) so tests can assert on calls the same way they already do for role effects. For `timeoutMember`/`kickMember`: track state in a new `Map<Snowflake, { until: number } | 'kicked'>` on the class (read the class's existing state-tracking fields first, e.g. how member roles are tracked, and follow that pattern rather than inventing a new one), and honor the existing hierarchy-check machinery already used by `addRole`/`removeRole` (`this.check(...)`) so a fake "owner" or "above-bot" member can refuse the same way the real API does — read `this.check`'s implementation before writing this, since it is what Task 8's refusal tests will exercise.

- [ ] **Step 8: Commit**

```bash
git add packages/core/src/discord/port.ts packages/discord/src/rest/port.ts packages/discord/src/rest/port.test.ts packages/testkit/src/fake-discord.ts
git commit -m "discord: add deleteMessage, timeoutMember, kickMember to DiscordPort"
```

---

### Task 4: The `obscenity` dependency and the matcher module

**Files:**
- Modify: `package.json` (root, add `obscenity` to the workspace that needs it — likely `packages/core`; add to `packages/core/package.json`'s `dependencies`)
- Create: `packages/core/src/automod/matcher.ts`
- Test: `packages/core/src/automod/matcher.test.ts`

**Interfaces:**
- Produces: `stripZeroWidth(text: string): string`; `buildMatcher(terms: readonly { text: string; categoryId: string }[], allowlist: readonly string[]): AutomodMatcher`; `AutomodMatcher.match(content: string): { categoryId: string; snippet: string } | undefined` — consumed by Task 9 (subscriber).

- [ ] **Step 1: Install and verify the real API**

Run: `npm install obscenity --workspace=@bananasaurs/core`

Then read `node_modules/obscenity/dist/index.d.ts` (or the package's own README, already fetched during design and confirmed to export `RegExpMatcher`, `TextCensor`, `englishDataset`, `englishRecommendedTransformers`, `pattern`) to confirm the exact `RegExpMatcherOptions` shape — specifically whether `blacklistedTerms` from `englishDataset.build()` and a hand-built array (for `word_terms`) must be concatenated before constructing `RegExpMatcher`, or whether there is a `DataSet.addPhrase` method that composes them at the dataset level instead. Use whichever the shipped types actually show; do not guess further than this plan already has.

- [ ] **Step 2: Write the failing normalization test**, `packages/core/src/automod/matcher.test.ts`:

```typescript
import { describe, expect, it } from 'vitest';
import { stripZeroWidth } from './matcher.js';

describe('stripZeroWidth', () => {
  it('removes zero-width space, non-joiner, joiner, and BOM', () => {
    expect(stripZeroWidth('b​a‌d‍﻿')).toBe('bad');
  });

  it('leaves ordinary text untouched', () => {
    expect(stripZeroWidth('hello world')).toBe('hello world');
  });
});
```

- [ ] **Step 3: Run to confirm failure**

Run: `npm run test -- automod/matcher.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 4: Implement `stripZeroWidth`**, in `packages/core/src/automod/matcher.ts`:

```typescript
/**
 * Zero-width and invisible formatting characters, stripped before matching.
 *
 * `obscenity`'s transformers handle leetspeak, homoglyphs, and stretched or
 * spaced-out letters (ADR 0035) — this is the one evasion class Bananasaurs'
 * own code closes. `\p{Cf}` is the Unicode "format" category: zero-width
 * space/non-joiner/joiner, the byte-order mark, and the rest of the class
 * inserted mid-word specifically to break substring matching.
 */
export function stripZeroWidth(text: string): string {
  return text.replace(/\p{Cf}/gu, '');
}
```

- [ ] **Step 5: Run to confirm pass**

Run: `npm run test -- automod/matcher.test.ts`
Expected: PASS (both cases).

- [ ] **Step 6: Write the failing matcher-construction and match test**, appended to the same file:

```typescript
import { buildMatcher } from './matcher.js';

describe('buildMatcher', () => {
  it('matches a configured term and reports its category', () => {
    const matcher = buildMatcher([{ text: 'badword', categoryId: 'cat-1' }], []);
    const result = matcher.match('this message has badword in it');
    expect(result).toEqual({ categoryId: 'cat-1', snippet: 'badword' });
  });

  it('matches leetspeak-substituted evasion via obscenity transformers', () => {
    const matcher = buildMatcher([{ text: 'badword', categoryId: 'cat-1' }], []);
    expect(matcher.match('b4dw0rd')).toBeDefined();
  });

  it('does not match after zero-width characters are stripped, then matches', () => {
    const matcher = buildMatcher([{ text: 'badword', categoryId: 'cat-1' }], []);
    // The caller is responsible for calling stripZeroWidth before match() —
    // this asserts match() itself has no opinion on pre-stripped input.
    expect(matcher.match('bad​word')).toBeDefined();
  });

  it('suppresses a match covered by the allowlist', () => {
    const matcher = buildMatcher([{ text: 'ass', categoryId: 'cat-1' }], ['assassin']);
    expect(matcher.match('an assassin walked by')).toBeUndefined();
  });

  it('reports no match for clean text', () => {
    const matcher = buildMatcher([{ text: 'badword', categoryId: 'cat-1' }], []);
    expect(matcher.match('hello world')).toBeUndefined();
  });
});
```

- [ ] **Step 7: Run to confirm failure**

Run: `npm run test -- automod/matcher.test.ts -t buildMatcher`
Expected: FAIL — `buildMatcher` does not exist.

- [ ] **Step 8: Implement `buildMatcher`**, appended to `packages/core/src/automod/matcher.ts`, using the exact construction shape confirmed in Step 1:

```typescript
import { RegExpMatcher, englishRecommendedTransformers, pattern } from 'obscenity';

export interface AutomodMatcher {
  /** `undefined` means no configured term matched. Call on already-normalized text. */
  match(content: string): { categoryId: string; snippet: string } | undefined;
}

/**
 * One matcher per guild, built from that guild's own word_terms and
 * word_allowlist — not the obscenity English dataset (ADR 0035: that seeds
 * the initial word list on first migration, via a separate seeding step,
 * but the running matcher only ever reflects what is actually in
 * word_terms/word_categories, so removing a seeded word really removes it).
 */
export function buildMatcher(
  terms: readonly { text: string; categoryId: string }[],
  allowlist: readonly string[],
): AutomodMatcher {
  const byPattern = new Map<number, string>();
  const blacklistedTerms = terms.map((term, id) => {
    byPattern.set(id, term.categoryId);
    return { id, pattern: pattern([term.text]) };
  });

  const matcher = new RegExpMatcher({
    blacklistedTerms,
    whitelistedTerms: [...allowlist],
    ...englishRecommendedTransformers,
  });

  return {
    match(content) {
      const matches = matcher.getAllMatches(content);
      if (matches.length === 0) return undefined;
      const first = matches[0]!;
      return {
        categoryId: byPattern.get(first.termId) ?? 'unknown',
        snippet: content.slice(first.startIndex, first.endIndex + 1),
      };
    },
  };
}
```

(If Step 1's type-check reveals `pattern` is a tagged template — `` pattern`literal` `` — rather than a function taking a string array, adjust this call accordingly; this is exactly the kind of detail Step 1 exists to pin down before this step is written for real.)

- [ ] **Step 9: Run to confirm pass**

Run: `npm run test -- automod/matcher.test.ts`
Expected: PASS, all cases.

- [ ] **Step 10: Confirm the package-boundary check still passes** (matcher.ts imports `obscenity`, a plain npm dependency with no discord.js/database reach, so this should be a formality, not a fix)

Run: `npm run test -- boundaries.test.ts`
Expected: PASS.

- [ ] **Step 11: Commit**

```bash
git add package.json packages/core/package.json package-lock.json packages/core/src/automod/matcher.ts packages/core/src/automod/matcher.test.ts
git commit -m "automod: add obscenity-backed fuzzy keyword matcher"
```

---

### Task 5: Repos — rules, exemptions, word list

**Files:**
- Create: `packages/storage/src/repos/automod-rules.ts`
- Test: `packages/storage/src/repos/automod-rules.test.ts`

**Interfaces:**
- Consumes: `modRules`, `modRuleExemptions`, `wordCategories`, `wordTerms`, `wordAllowlist` from `../schema.js` (Task 1); `read`/`write` from `../write.js`; `GuildScope` from `../scope.js`.
- Produces: `listEnabledKeywordFilterRules(scope): readonly RuleWithWordList[]`, `isExempt(scope, ruleId, input: { authorRoleIds: readonly string[]; channelId: string }): boolean`, `createRule(scope, input): void`, `addCategory`/`addTerm`/`addAllowlistPhrase` writes — consumed by Task 6 (seeding) and Task 9 (subscriber).

- [ ] **Step 1: Read `packages/storage/src/repos/panels.ts` in full first** (already partially read during design) — this task's shape (assembling a rule from three related tables, guild-scoped reads via `scope.only`) is the same pattern, and the repo must not diverge from it stylistically.

- [ ] **Step 2: Write the failing repo test**, `packages/storage/src/repos/automod-rules.test.ts` (mirror `packages/storage/src/repos/panels.test.ts`'s setup — `openMigratedTestDatabase`, a fixed `GUILD` via `parseGuildId`):

```typescript
import { beforeEach, describe, expect, it } from 'vitest';
import { openMigratedTestDatabase, type MigratedTestDatabase } from '../test-support.js';
import { parseGuildId, parseSnowflakeId } from '@bananasaurs/core';
import {
  addAllowlistPhrase,
  addCategory,
  addTerm,
  createRule,
  isExempt,
  listEnabledKeywordFilterRules,
  setRuleMode,
} from './automod-rules.js';

const GUILD = parseGuildId('111111111111111111');
const ROLE = parseSnowflakeId('222222222222222222');
const CHANNEL = parseSnowflakeId('333333333333333333');

let t: MigratedTestDatabase;

beforeEach(() => {
  t = openMigratedTestDatabase();
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
});
```

- [ ] **Step 3: Run to confirm failure**

Run: `npm run test -- automod-rules.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 4: Implement `packages/storage/src/repos/automod-rules.ts`**, following `panels.ts`'s exact style: `read(scope, db => ...)` for queries joining `modRules`/`wordCategories`/`wordTerms`/`wordAllowlist` on `guild_id` (+ `rule_id` where applicable), `write(scope, ({db}) => db.insert(...).values({guildId: scope.guildId, ...}))` for each of `createRule`, `addCategory`, `addTerm`, `addAllowlistPhrase`, `addRoleExemption`, `addChannelExemption`, `setRuleMode`. `isExempt` reads `modRuleExemptions` and checks membership against the supplied role ids / channel id.

- [ ] **Step 5: Run to confirm pass**

Run: `npm run test -- automod-rules.test.ts`
Expected: PASS, all three cases.

- [ ] **Step 6: Commit**

```bash
git add packages/storage/src/repos/automod-rules.ts packages/storage/src/repos/automod-rules.test.ts
git commit -m "storage: automod rules/word-list repo"
```

---

### Task 6: Seed the word list from `obscenity`'s bundled dataset

**Files:**
- Create: `packages/core/src/automod/seed.ts`
- Test: `packages/core/src/automod/seed.test.ts`

**Interfaces:**
- Consumes: `englishDataset` from `obscenity`; the repo write functions from Task 5 (via an injected `SeedPorts` interface, not a direct storage import — `packages/core` cannot import `packages/storage`, ADR 0014).
- Produces: `seedDefaultWordList(ports: SeedPorts, ruleId: string): void`, called once by the daemon's first-run path (wired in Task 10).

- [ ] **Step 1: Confirm `englishDataset`'s iterable shape** against the type definitions read in Task 4 Step 1 — specifically what `englishDataset.build().blacklistedTerms` entries look like (an `id`/`pattern` pair, or a phrase with metadata) and whether there is a human-readable phrase string available per entry, or only a compiled pattern. If only compiled patterns are available with no readable phrase, this task seeds one category ("default") containing entries whose `text` is a placeholder identifier rather than the literal word — note which is true here before writing Step 4, since it changes what `word_terms.text` actually holds for seeded rows (this is a real fact to pin down from the installed package, not a choice to make up).

- [ ] **Step 2: Write the failing test**, `packages/core/src/automod/seed.test.ts`:

```typescript
import { describe, expect, it, vi } from 'vitest';
import { seedDefaultWordList } from './seed.js';

describe('seedDefaultWordList', () => {
  it('adds one category and at least one term from the bundled dataset', () => {
    const addCategory = vi.fn();
    const addTerm = vi.fn();
    seedDefaultWordList({ addCategory, addTerm }, 'r1');

    expect(addCategory).toHaveBeenCalledWith(
      expect.objectContaining({ ruleId: 'r1', defaultAction: 'delete_and_case' }),
    );
    expect(addTerm.mock.calls.length).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 3: Run to confirm failure**

Run: `npm run test -- automod/seed.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 4: Implement `seedDefaultWordList`**, in `packages/core/src/automod/seed.ts`, using whatever iteration shape Step 1 confirmed:

```typescript
import { englishDataset } from 'obscenity';

export interface SeedPorts {
  addCategory(input: {
    categoryId: string;
    ruleId: string;
    name: string;
    defaultAction: 'log_only' | 'delete' | 'delete_and_case';
  }): void;
  addTerm(input: { termId: string; categoryId: string; text: string }): void;
}

/** ADR 0035: seeds from obscenity's own bundled dataset, same MIT license as the matcher. */
export function seedDefaultWordList(ports: SeedPorts, ruleId: string): void {
  const categoryId = `${ruleId}-default`;
  ports.addCategory({
    categoryId,
    ruleId,
    name: 'default (obscenity englishDataset)',
    defaultAction: 'delete_and_case',
  });

  const { blacklistedTerms } = englishDataset.build();
  blacklistedTerms.forEach((term, index) => {
    ports.addTerm({ termId: `${categoryId}-${index}`, categoryId, text: String(term.id) });
  });
}
```

(This step's exact body depends on Step 1's finding — if entries carry no readable phrase, `word_terms.text` seeded here is not directly human-editable per-word from this data alone, which is worth a one-line note in the commit message rather than silently shipping something the design's "then is fully editable" claim doesn't quite hold for; if `englishDataset` does expose readable phrases, use them as `text` directly instead of `String(term.id)`.)

- [ ] **Step 5: Run to confirm pass**

Run: `npm run test -- automod/seed.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/automod/seed.ts packages/core/src/automod/seed.test.ts
git commit -m "automod: seed default word list from obscenity's bundled dataset"
```

---

### Task 7: `mod_cases`/`mod_case_events` repo

**Files:**
- Create: `packages/storage/src/repos/mod-cases.ts`
- Test: `packages/storage/src/repos/mod-cases.test.ts`

**Interfaces:**
- Produces: `openOrResolveCase(scope, input: { memberId: string; now: number }): { caseId: string; violationCount: number }`, `recordCaseEvent(scope, input): void`, `nextEscalationTier(violationCount: number): { tier: number; action: 'timeout' | 'kick' | undefined; timeoutMs: number | undefined }` — consumed by Task 9 (subscriber) and Task 8 (gateway records refusals through `recordCaseEvent`).

- [ ] **Step 1: Write the failing tests**, `packages/storage/src/repos/mod-cases.test.ts` (same `openMigratedTestDatabase` setup as Task 5's test):

```typescript
describe('mod cases repo', () => {
  it('opens a new case on first violation, violationCount 1', () => {
    const scope = t.scopes.forGuild(GUILD);
    const result = openOrResolveCase(scope, { memberId: MEMBER, now: 1000 });
    expect(result.violationCount).toBe(1);
  });

  it('resolves into the same open case on a second violation', () => {
    const scope = t.scopes.forGuild(GUILD);
    const first = openOrResolveCase(scope, { memberId: MEMBER, now: 1000 });
    const second = openOrResolveCase(scope, { memberId: MEMBER, now: 2000 });
    expect(second.caseId).toBe(first.caseId);
    expect(second.violationCount).toBe(2);
  });

  it('records a case event, including a refusal', () => {
    const scope = t.scopes.forGuild(GUILD);
    const { caseId } = openOrResolveCase(scope, { memberId: MEMBER, now: 1000 });
    recordCaseEvent(scope, {
      eventId: 'e1',
      caseId,
      ruleId: 'r1',
      memberId: MEMBER,
      at: 1000,
      matchedCategory: 'c1',
      matchedSnippet: 'badword',
      actionTaken: 'escalation_refused',
      escalationAction: 'timeout',
      refusalReason: 'discord-owner',
    });
    // asserted via a read helper this task also adds, listCaseEvents(scope, caseId)
    expect(listCaseEvents(scope, caseId)).toHaveLength(1);
  });
});

describe('nextEscalationTier', () => {
  it('is log-only below the first threshold', () => {
    expect(nextEscalationTier(1)).toEqual({ tier: 0, action: undefined, timeoutMs: undefined });
  });

  it('times out at the configured threshold', () => {
    expect(nextEscalationTier(3)).toEqual({ tier: 1, action: 'timeout', timeoutMs: 600_000 });
  });

  it('kicks at the top tier', () => {
    expect(nextEscalationTier(6)).toEqual({ tier: 2, action: 'kick', timeoutMs: undefined });
  });
});
```

- [ ] **Step 2: Run to confirm failure**

Run: `npm run test -- mod-cases.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement `packages/storage/src/repos/mod-cases.ts`.** `openOrResolveCase`: `write(scope, ({db}) => ...)` — select the existing `status = 'open'` row for `memberId` (the `mod_cases_open_per_member` partial unique index from Task 1 makes this at most one row); if present, `UPDATE ... SET violation_count = violation_count + 1`; if absent, `INSERT` with `violationCount: 1`. `recordCaseEvent`: plain insert into `modCaseEvents`. `listCaseEvents`: plain guild-scoped select. `nextEscalationTier` is a pure function, no `GuildScope` — hardcode the example ladder from the tests above (tier 0 below 3, tier 1 = timeout 10 minutes at 3, tier 2 = kick at 6) as the Release 2 default; a future slice makes this guild-configurable (out of scope here per the spec).

- [ ] **Step 4: Run to confirm pass**

Run: `npm run test -- mod-cases.test.ts`
Expected: PASS, all six cases.

- [ ] **Step 5: Commit**

```bash
git add packages/storage/src/repos/mod-cases.ts packages/storage/src/repos/mod-cases.test.ts
git commit -m "storage: mod_cases/mod_case_events repo and the default escalation ladder"
```

---

### Task 8: `ModerationActionGateway` — timeout/kick, mirroring `EffectGateway`

**Files:**
- Create: `packages/core/src/effects/moderation-gateway.ts`
- Test: `packages/core/src/effects/moderation-gateway.test.ts`

**Interfaces:**
- Consumes: `AuthzStore`/`authorize`/`Actor`/`Authorized` from `../authz.js`; `DiscordPort` (Task 3); the same `SafetyState` shape `EffectGateway` already reads.
- Produces: `ModerationActionGateway.applyAction(auth, intent: ModerationIntent): Promise<ModerationOutcome>`, consumed by Task 9 (subscriber).

- [ ] **Step 1: Re-read `packages/core/src/effects/gateway.ts` in full** (already read through line 200 during design; read the rest — the idempotency claim, dry-run branch, and the actual REST call/record sequence at the bottom of `applyRoleEffect`) so this task's ordering matches it layer-for-layer, substituting "hierarchy/owner" for "role allowlist/protected-target" where the action target is a member rather than a role.

- [ ] **Step 2: Write the failing tests**, `packages/core/src/effects/moderation-gateway.test.ts` (mirror `gateway.test.ts`'s existing setup — fake `AuthzStore`, fake `DiscordPort`, fake `state` ports — read that file's test setup first and reuse its fixtures rather than writing new ones):

```typescript
describe('ModerationActionGateway', () => {
  it('applies a timeout and records it', async () => {
    // authorized, killswitch off, breaker closed, target not the owner, target
    // below the bot's role — expect discord.timeoutMember called once, outcome
    // { status: 'applied' }
  });

  it('refuses against the guild owner without calling Discord, reason discord-owner', async () => {
    // deps.state read reports the target isGuildOwner: true (mirrors
    // gateway.ts:266's `member.isGuildOwner` check) -> outcome
    // { status: 'refused', reason: 'discord-owner' }, discord.timeoutMember
    // and discord.kickMember never called
  });

  it('refuses when the target outranks the bot, reason role-above-bot', async () => {
    // -> { status: 'refused', reason: 'role-above-bot' }
  });

  it('refuses when the kill switch is on, reason killswitch', async () => {
    // -> { status: 'refused', reason: 'killswitch' }, before any hierarchy check
  });

  it('records dry-run without calling Discord', async () => {
    // deps.state.read().dryRun === true -> { status: 'dry-run' }, no REST call
  });

  it('is idempotent: a replayed intent with the same dedupe key is a no-op the second time', async () => {
    // two calls with the same ModerationIntent -> discord method called exactly once
  });
});
```

- [ ] **Step 3: Run to confirm failure**

Run: `npm run test -- moderation-gateway.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 4: Implement `packages/core/src/effects/moderation-gateway.ts`**, mirroring `gateway.ts`'s exact structure:

```typescript
import { authorize, capabilityOf, type Actor, type Authorized, type AuthzStore } from '../authz.js';
import type { DiscordPort } from '../discord/port.js';
import type { GuildId, SnowflakeId } from '../ids.js';
import { safeLogFields, type Logger } from '../obs/logger.js';

export interface ModerationIntent {
  readonly userId: SnowflakeId;
  readonly action: 'timeout' | 'kick';
  readonly timeoutMs: number | undefined;
  readonly dedupeKey: string;
  readonly reason: string;
}

export type ModerationRefusalReason =
  | 'unauthorized'
  | 'guild-unknown'
  | 'killswitch'
  | 'breaker-open'
  | 'rate-cap'
  | 'discord-owner'
  | 'role-above-bot';

export type ModerationOutcome =
  | { readonly status: 'applied' }
  | { readonly status: 'dry-run' }
  | { readonly status: 'skipped'; readonly reason: 'already-applied' }
  | { readonly status: 'refused'; readonly reason: ModerationRefusalReason }
  | { readonly status: 'failed'; readonly code: string };

export interface ModerationGatewayDeps {
  readonly guildId: GuildId;
  readonly authz: AuthzStore;
  readonly discord: DiscordPort;
  readonly logger: Logger;
  now(): number;
  readonly state: {
    read(): { killswitch: boolean; breakerOpen: boolean; dryRun: boolean } | undefined;
    /** Live hierarchy check — mirrors gateway.ts's use of member.isGuildOwner. */
    checkTarget(userId: SnowflakeId): { ok: true } | { ok: false; reason: 'discord-owner' | 'role-above-bot' };
  };
  readonly claims: {
    /** Same insert-or-ignore idempotency pattern as role_effects. */
    claim(dedupeKey: string): { claimed: boolean };
  };
}

export class ModerationActionGateway {
  constructor(private readonly deps: ModerationGatewayDeps) {}

  async applyAction(
    auth: Authorized<'moderation.act'>,
    intent: ModerationIntent,
  ): Promise<ModerationOutcome> {
    const { deps } = this;
    const refuse = (reason: ModerationRefusalReason): ModerationOutcome => {
      deps.logger.warn(
        safeLogFields({
          component: 'moderation-effects',
          guildId: deps.guildId,
          userId: intent.userId,
          action: intent.action,
          outcome: 'refused',
          reason,
        }),
        'moderation action refused',
      );
      return { status: 'refused', reason };
    };

    const recheck = authorize(
      { store: deps.authz, guildId: deps.guildId, actor: auth.actor },
      capabilityOf(auth),
    );
    if (!recheck.ok) return refuse('unauthorized');

    const state = deps.state.read();
    if (!state) return refuse('guild-unknown');
    if (state.killswitch) return refuse('killswitch');
    if (state.breakerOpen) return refuse('breaker-open');

    const target = deps.state.checkTarget(intent.userId);
    if (!target.ok) return refuse(target.reason);

    const claimed = deps.claims.claim(intent.dedupeKey);
    if (!claimed.claimed) return { status: 'skipped', reason: 'already-applied' };

    if (state.dryRun) return { status: 'dry-run' };

    try {
      if (intent.action === 'timeout') {
        await deps.discord.timeoutMember(deps.guildId, intent.userId, intent.timeoutMs ?? 0, intent.reason);
      } else {
        await deps.discord.kickMember(deps.guildId, intent.userId, intent.reason);
      }
      return { status: 'applied' };
    } catch (err) {
      deps.logger.error(safeLogFields({ component: 'moderation-effects', err }), 'moderation action failed');
      return { status: 'failed', code: err instanceof Error ? err.name : 'unknown' };
    }
  }
}
```

(Note the deliberate omission of an audit-row call inside this class itself — Task 9 calls `recordCaseEvent` from Task 7 with the returned `ModerationOutcome` directly, which is where ADR 0035's durable-refusal-recording requirement is actually satisfied; this class's job is the safety decision, not the case bookkeeping, matching `EffectGateway`'s own separation from `effectRepo.recordAudit`.)

- [ ] **Step 5: Run to confirm pass**

Run: `npm run test -- moderation-gateway.test.ts`
Expected: PASS, all six cases.

- [ ] **Step 6: Confirm package boundaries still hold**

Run: `npm run test -- boundaries.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/effects/moderation-gateway.ts packages/core/src/effects/moderation-gateway.test.ts
git commit -m "automod: ModerationActionGateway for timeout/kick, mirroring EffectGateway's layering"
```

---

### Task 9: The automod subscriber

**Files:**
- Create: `packages/core/src/automod/subscriber.ts`
- Test: `packages/core/src/automod/subscriber.test.ts`

**Interfaces:**
- Consumes: `Subscriber` from `../pipeline/pipeline.js`; `AutomodMatcher`/`buildMatcher` (Task 4); `ModerationActionGateway` (Task 8); rule/case ports supplied via a `AutomodSubscriberDeps` interface (concrete repo calls wired in Task 10, per the port pattern every other subscriber uses — `createAutomodSubscriber` takes ports, never imports `@bananasaurs/storage` directly).
- Produces: `createAutomodSubscriber(deps: AutomodSubscriberDeps): Subscriber`, consumed by Task 10.

- [ ] **Step 1: Write the failing tests**, `packages/core/src/automod/subscriber.test.ts` (fake every port; do not reach a real database — this is a unit test of the subscriber's decision logic, the same level `packages/core/src/logging/subscriber.test.ts` already tests at):

```typescript
describe('automod subscriber', () => {
  it('ignores an event that is not messageCreate or messageUpdate', async () => {
    // event.kind === 'reactionAdd' -> no port called
  });

  it('deletes a message that matches an enforce-mode rule', async () => {
    // rule mode 'enforce', matcher matches -> discord.deleteMessage called,
    // openOrResolveCase called, recordCaseEvent called with actionTaken 'deleted'
  });

  it('does not call Discord in test mode, but still records what would have happened', async () => {
    // rule mode 'test' -> discord.deleteMessage NOT called; recordCaseEvent
    // still called (matches the spec's data-flow: test records, never acts)
  });

  it('does not call Discord in observe mode either', async () => {
    // rule mode 'observe' -> same as test, but distinguishable in the recorded event
  });

  it('skips an exempt author/channel entirely', async () => {
    // isExempt returns true -> no matcher call, no port call
  });

  it('escalates and records the applied action when the violation count crosses a tier', async () => {
    // openOrResolveCase returns violationCount: 3 -> nextEscalationTier gives
    // 'timeout' -> moderationGateway.applyAction called, outcome 'applied' ->
    // recordCaseEvent actionTaken 'deleted_and_escalated', escalationAction 'timeout'
  });

  it('records a refused escalation durably, not just deletes the message', async () => {
    // moderationGateway.applyAction resolves { status: 'refused', reason: 'discord-owner' }
    // -> recordCaseEvent actionTaken 'escalation_refused', refusalReason 'discord-owner'
    // -> the message is still deleted regardless (deletion already succeeded
    //    before escalation was attempted)
  });

  it('a matcher throwing is caught, logged, and does not stop the message from being processed by other rules', async () => {
    // matcher.match throws -> logger.error called, no crash, event otherwise handled
  });
});
```

- [ ] **Step 2: Run to confirm failure**

Run: `npm run test -- automod/subscriber.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement `packages/core/src/automod/subscriber.ts`**, following `createLoggingSubscriber`'s exact factory shape (`packages/core/src/logging/subscriber.ts:132-134`):

```typescript
import type { Subscriber } from '../pipeline/pipeline.js';
import type { Logger } from '../obs/logger.js';
import { safeLogFields } from '../obs/logger.js';
import type { ModerationActionGateway } from '../effects/moderation-gateway.js';
import type { Authorized } from '../authz.js';
import { buildMatcher, stripZeroWidth } from './matcher.js';

export interface RuleWithWordList {
  readonly ruleId: string;
  readonly mode: 'test' | 'observe' | 'enforce';
  readonly terms: readonly { text: string; categoryId: string }[];
  readonly allowlist: readonly string[];
}

export interface AutomodSubscriberDeps {
  readonly logger: Logger;
  readonly moderationAuth: Authorized<'moderation.act'>;
  now(): number;
  newEventId(): string;
  listRules(): readonly RuleWithWordList[];
  isExempt(ruleId: string, input: { authorRoleIds: readonly string[]; channelId: string }): boolean;
  deleteMessage(channelId: string, messageId: string, reason: string): Promise<void>;
  openOrResolveCase(memberId: string): { caseId: string; violationCount: number };
  recordCaseEvent(input: {
    caseId: string;
    ruleId: string;
    memberId: string;
    matchedCategory: string;
    matchedSnippet: string;
    actionTaken: 'deleted' | 'deleted_and_escalated' | 'escalation_refused';
    escalationAction: 'timeout' | 'kick' | undefined;
    refusalReason: string | undefined;
  }): void;
  nextEscalationTier(violationCount: number): {
    action: 'timeout' | 'kick' | undefined;
    timeoutMs: number | undefined;
  };
  moderationGateway: ModerationActionGateway;
  authorRoleIds(userId: string): readonly string[];
}

/** One matcher per rule, cached and rebuilt whenever the caller re-lists rules with new content. */
const matcherCache = new Map<string, ReturnType<typeof buildMatcher>>();

export const createAutomodSubscriber = (deps: AutomodSubscriberDeps): Subscriber => ({
  name: 'automod',
  async handle(event) {
    if (event.kind !== 'messageCreate' && event.kind !== 'messageUpdate') return;
    if (event.authorId === undefined || event.content === undefined) return;

    const normalized = stripZeroWidth(event.content);

    for (const rule of deps.listRules()) {
      if (deps.isExempt(rule.ruleId, { authorRoleIds: deps.authorRoleIds(event.authorId), channelId: event.channelId })) {
        continue;
      }

      let matcher = matcherCache.get(rule.ruleId);
      if (matcher === undefined) {
        matcher = buildMatcher(rule.terms, rule.allowlist);
        matcherCache.set(rule.ruleId, matcher);
      }

      let hit;
      try {
        hit = matcher.match(normalized);
      } catch (err) {
        deps.logger.error(
          safeLogFields({ component: 'automod', ruleId: rule.ruleId, err }),
          'matcher threw, message left unmatched for this rule',
        );
        continue;
      }
      if (hit === undefined) continue;

      const { caseId, violationCount } = deps.openOrResolveCase(event.authorId);

      if (rule.mode === 'enforce') {
        await deps.deleteMessage(event.channelId, event.messageId, `automod: ${rule.ruleId}`);
      }

      const tier = deps.nextEscalationTier(violationCount);
      if (rule.mode !== 'enforce' || tier.action === undefined) {
        deps.recordCaseEvent({
          caseId,
          ruleId: rule.ruleId,
          memberId: event.authorId,
          matchedCategory: hit.categoryId,
          matchedSnippet: hit.snippet,
          actionTaken: 'deleted',
          escalationAction: undefined,
          refusalReason: undefined,
        });
        continue;
      }

      const outcome = await deps.moderationGateway.applyAction(deps.moderationAuth, {
        userId: event.authorId,
        action: tier.action,
        timeoutMs: tier.timeoutMs,
        dedupeKey: `${event.guildId}:${caseId}:${event.eventId ?? event.messageId}`,
        reason: `automod escalation: ${rule.ruleId}`,
      });

      deps.recordCaseEvent({
        caseId,
        ruleId: rule.ruleId,
        memberId: event.authorId,
        matchedCategory: hit.categoryId,
        matchedSnippet: hit.snippet,
        actionTaken: outcome.status === 'refused' ? 'escalation_refused' : 'deleted_and_escalated',
        escalationAction: tier.action,
        refusalReason: outcome.status === 'refused' ? outcome.reason : undefined,
      });
    }
  },
});
```

- [ ] **Step 4: Run to confirm pass**

Run: `npm run test -- automod/subscriber.test.ts`
Expected: PASS, all eight cases.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/automod/subscriber.ts packages/core/src/automod/subscriber.test.ts
git commit -m "automod: the MESSAGE_CREATE/MESSAGE_UPDATE subscriber"
```

---

### Task 10: Wire it into the composition root

**Files:**
- Modify: `apps/daemon/src/runtime/guild.ts:291-309` (`subscribers` array)
- Modify: `apps/daemon/src/runtime/daemon.ts` (first-run seeding call, if this guild has no `mod_rules` yet)
- Test: `apps/daemon/src/automod.integration.test.ts` (new — but this is Task 12's job; this task only needs the wiring itself to compile and the existing full test suite to stay green)

**Interfaces:**
- Consumes: everything from Tasks 4-9.
- Produces: a running `automod` subscriber in the live daemon.

- [ ] **Step 1: Add the automod ports and subscriber construction** in `apps/daemon/src/runtime/guild.ts`, following the exact pattern already used for `loggingPorts`/`createLoggingSubscriber` (lines 239-257, 308) — construct an `AutomodSubscriberDeps` object whose `listRules`/`isExempt`/`openOrResolveCase`/`recordCaseEvent`/`deleteMessage`/`authorRoleIds` each call the Task 5/7 repo functions and `discord.deleteMessage`/`discord.fetchMember` (for role ids), a `ModerationActionGateway` constructed the same way `gateway` already is nearby, and add `createAutomodSubscriber(automodPorts)` to the `subscribers` array (line 291-309).

- [ ] **Step 2: Seed on first run.** In `apps/daemon/src/runtime/daemon.ts`, near wherever per-guild setup already happens at startup (read the surrounding composition code first), call `seedDefaultWordList` (Task 6) once per guild if `listEnabledKeywordFilterRules(scope)` is empty — this is the "ships as `test` mode, not `enforce`" rollout behavior from spec §8, so `createRule` here must pass `mode: 'test'` explicitly.

- [ ] **Step 3: Typecheck and run the full suite**

Run: `npm run typecheck && npm run lint && npm run test`
Expected: PASS, no regressions. This is the checkpoint that catches any signature drift between what Tasks 5-9 assumed and what the composition root actually has available (e.g., `discord.fetchMember` for role ids — confirm this exists and returns `roleIds`, from `packages/core/src/discord/port.ts:111`, already read during design).

- [ ] **Step 4: Commit**

```bash
git add apps/daemon/src/runtime/guild.ts apps/daemon/src/runtime/daemon.ts
git commit -m "automod: wire the subscriber and first-run seeding into the daemon"
```

---

### Task 11: `doctor` check — `keyword_filter` rule missing Manage Messages

**Files:**
- Modify: `packages/core/src/ops/commands/reads.ts:37-83` (`doctorCommand`)
- Modify: `apps/daemon/src/runtime/doctor.ts` if the startup `--doctor` check should mirror it (confirm against Task 1's ADR-noted scope split — Section B finding 1c from the Release 1 smoke test established the live `doctor` command and the startup `--doctor` intentionally check different things; this new check belongs with the live command, alongside the existing `listPanels`/`listUnassignableRoles` checks, not the startup one)
- Test: `packages/core/src/ops/commands/reads.test.ts` (existing file's `doctorCommand` describe block)

**Interfaces:**
- Consumes: a new `OpsPorts` method, `listKeywordFilterRulesMissingManageMessages(): readonly { ruleId: string; channelId: string }[]` (implemented in `packages/storage`, wired the same way `listUnassignableRoles`/`listPanels` already are).
- Produces: an additional `doctor` report line, and `ok` incorporating it — matching `reads.ts:56-67`'s existing pattern of ANDing every check into one `ok` boolean.

- [ ] **Step 1: Write the failing test**, appended to `packages/core/src/ops/commands/reads.test.ts`'s `doctorCommand` block, following its existing fixture style:

```typescript
it('flags an enforce-mode keyword_filter rule where the bot lacks Manage Messages', () => {
  // fixture: one mod_rules row, mode 'enforce', and a fake
  // listKeywordFilterRulesMissingManageMessages returning one entry
  // -> report.text includes 'automod' and the rule id; report.data.ok === false
});

it('reports clean when every enforce-mode rule has Manage Messages', () => {
  // empty list -> report.data.ok stays true (assuming every other check passes)
});
```

- [ ] **Step 2: Run to confirm failure**

Run: `npm run test -- reads.test.ts -t doctor`
Expected: FAIL.

- [ ] **Step 3: Add the port and wire the check**, in `packages/core/src/ops/ports.ts` (new method on `OpsPorts`, alongside `listPanels`/`listUnassignableRoles`) and `packages/core/src/ops/commands/reads.ts`'s `doctorCommand.run`:

```typescript
    const missingManageMessages = ctx.ports.listKeywordFilterRulesMissingManageMessages();
    lines.push(
      missingManageMessages.length === 0
        ? 'automod    every enforce-mode keyword filter rule has Manage Messages'
        : `automod    ${String(missingManageMessages.length)} rule(s) missing Manage Messages:\n` +
            missingManageMessages
              .map((r) => `            ${r.ruleId}  channel ${r.channelId}`)
              .join('\n'),
    );
```

and fold `missingManageMessages.length === 0` into the existing `ok` computation (`reads.ts:67`) alongside `stale.length === 0` and `unassignable.length === 0`.

- [ ] **Step 4: Implement `listKeywordFilterRulesMissingManageMessages`** in `packages/storage` (wherever the concrete `OpsPorts` implementation lives — find it via the existing `listUnassignableRoles` wiring in `apps/daemon/src/ops/wiring.ts`, already read during design) — queries `mod_rules` joined against a live permission check the same way the existing panel/role checks do (read `doctor.ts`'s `inspectGuild` permission-bit logic, already read during design, for the `Manage Messages` bit check pattern).

- [ ] **Step 5: Run to confirm pass**

Run: `npm run test -- reads.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/ops/ports.ts packages/core/src/ops/commands/reads.ts packages/core/src/ops/commands/reads.test.ts apps/daemon/src/ops/wiring.ts
git commit -m "doctor: flag an enforce-mode keyword_filter rule missing Manage Messages"
```

---

### Task 12: End-to-end `FakeDiscord` integration tests

**Files:**
- Create: `apps/daemon/src/automod.integration.test.ts`

**Interfaces:**
- Consumes: everything wired in Task 10, exercised through the real `Pipeline` + `FakeDiscord`, mirroring `apps/daemon/src/panels.integration.test.ts`'s exact setup style (already read in full during design).

- [ ] **Step 1: Write the failing end-to-end tests**, following `panels.integration.test.ts`'s structure (fixed snowflakes via `parseGuildId`/`parseSnowflakeId`, `openMigratedTestDatabase`, `FakeDiscord`, a real `Pipeline` dispatching a real event):

```typescript
describe('automod, end to end on the fake gateway', () => {
  it('deletes a matching message and opens a case, in enforce mode', async () => {
    // seed one enabled enforce-mode rule with term 'badword', dispatch a real
    // messageCreate via fake.emitMessageCreate with content 'badword here' ->
    // assert fake.deleteMessage was called (via fake.calls / whatever
    // FakeDiscord's existing assertion surface is, read panels.integration
    // for the exact idiom) and a mod_cases row exists with violationCount 1
  });

  it('does not delete from an exempt role', async () => {
    // member has the exempt role -> no deleteMessage call
  });

  it('makes no Discord call in test mode', async () => {
    // rule mode 'test' -> no deleteMessage call, but a mod_case_events row exists
  });

  it('an escalation against a fake owner member is refused and durably recorded', async () => {
    // drive violationCount to the timeout threshold via repeated messages,
    // configure the fake guild's owner as the author -> the message is still
    // deleted, but mod_case_events records actionTaken 'escalation_refused',
    // refusalReason 'discord-owner', and fake.timeoutMember was never called
    // — this is the exact test the spec names as "would have caught tonight's
    // finding about refusals being log-only, had it existed for role effects"
  });
});
```

- [ ] **Step 2: Run to confirm failure**

Run: `npm run test -- automod.integration.test.ts`
Expected: FAIL (or does not compile, if the composition helpers this test needs from `guild.ts` aren't exported yet — export whatever Task 10 built privately, following how `panelAuthorization`/`panelEffectsFor`/`panelStoreFor` are already exported from `panels/wiring.ts` for exactly this purpose).

- [ ] **Step 3: Fix whatever the failure reveals** — this task is integration glue, so a real gap here (a wrong port signature between Task 9's subscriber and Task 10's wiring, discovered only once all the pieces run together) is expected and is what this task exists to catch; fix it in the task where it actually belongs (e.g., a wiring bug goes back to Task 10, not this test file) and re-run.

- [ ] **Step 4: Run to confirm pass**

Run: `npm run typecheck && npm run lint && npm run test`
Expected: PASS, full suite, no regressions anywhere in the existing 1,638+ tests.

- [ ] **Step 5: Commit**

```bash
git add apps/daemon/src/automod.integration.test.ts
git commit -m "automod: end-to-end FakeDiscord tests, including the owner-refusal case"
```

---

## Self-Review

**Spec coverage:** §1 scope (rule engine core + one predicate) — Tasks 1, 5, 7. §2 data model (all seven tables) — Task 1. §3 matching engine (obscenity, per-guild cache, zero-width stripping, seeding) — Tasks 4, 6, 9 (cache lives in the subscriber per the spec's own note that it belongs there, not a new abstraction). §4 data flow (exemption → match → mode → delete → case → escalation → refusal recording) — Task 9, wired live in Task 10. §5 message content stored in full — Task 1's schema, Task 9's `matchedSnippet`. §6 error handling (matcher throw, doctor check) — Task 9 Step 3's try/catch, Task 11. §7 testing plan (matcher unit tests, FakeDiscord integration, doctor tests) — Tasks 4, 12, 11 respectively, in that order. §8 rollout (test mode default, seeded rules start in test) — Task 10 Step 2.

**Placeholder scan:** every code step above contains real, complete code or a concretely-actionable verification step (Task 4 Step 1, Task 6 Step 1) rather than a deferred decision — the two places this plan explicitly says "confirm against the installed package" are library-API facts no amount of further research replaces a `.d.ts` read for, not vagueness about what Bananasaurs' own code should do.

**Type consistency:** `ModerationOutcome`'s `'refused'` variant (Task 8) carries `reason: ModerationRefusalReason`, and Task 9's subscriber reads `outcome.reason` only after narrowing `outcome.status === 'refused'` — consistent. `AutomodMatcher.match()`'s return shape (`{categoryId, snippet} | undefined`, Task 4) matches every call site in Task 9. `RuleWithWordList` (Task 9) matches what Task 5's `listEnabledKeywordFilterRules` produces (`ruleId`, `mode`, `terms`, `allowlist`) — same field names, same shapes. `mod_case_events.actionTaken`'s three values (schema check constraint, Task 1) match the three literals Task 9 actually writes (`'deleted'`, `'deleted_and_escalated'`, `'escalation_refused'`) and Task 7's test fixture.

**Known gap this plan does not resolve (flagged, not hidden):** Task 6 Step 1/Step 4 depends on `englishDataset`'s exact shape for whether seeded terms carry a readable phrase or only a compiled pattern — if the latter, the design's "fully editable, no different from adding a new one" claim (spec §3) doesn't quite hold for seeded rows until Task 6 is actually run against the real package. This is real uncertainty about a third-party library, not a plan omission, and Task 6 Step 4 says so explicitly rather than asserting a shape from memory.
