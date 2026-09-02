# Slice 1 — Predicate abstraction and the `mod_rules.config` carrier

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the automod subscriber's hard-wired `keyword_filter` matching
into a registered `Predicate` behind a two-stage `compile`/`evaluate`
interface, give `mod_rules` a Zod-validated JSON `config` column, and replace
the never-invalidating matcher cache with one keyed on a content fingerprint.

**Architecture:** A predicate answers only "did this message match, and what is
the trace?"; the subscriber keeps every decision (safety state, deletion,
escalation, case recording) exactly as it is today. Predicates are registered
by `kind` in one registry, each with a Zod schema for its own configuration.
The subscriber compiles a rule into a reusable artifact and caches it beside a
SHA-256 fingerprint of everything `compile` read, so an edit to a rule's terms
or config takes effect on the next message with no daemon restart.

**Tech Stack:** TypeScript (Node 22, strict, `exactOptionalPropertyTypes`),
Drizzle ORM + drizzle-kit, better-sqlite3, Zod 3, Vitest, `obscenity`.

**Spec:** `docs/superpowers/specs/2026-09-01-release-2-completion-and-release-3-roadmap-design.md` (§3, Slice 1)
**ADR:** `docs/decisions/0040-the-predicate-interface-and-the-mod-rules-config-carrier.md`

## Global Constraints

Every task's requirements implicitly include this section.

- **CLAUDE.md rule 2 — guild scope is a mandatory partition key.** Every
  repository function takes `GuildScope` first. Every cache key begins with the
  guild id. A query that *can* omit guild scope is a bug even if every current
  caller passes it.
- **CLAUDE.md rule 3 — model output and stored JSON are untrusted input.**
  `mod_rules.config` gets a Zod validator on write *and* on read, never a cast.
- **CLAUDE.md rule 1 — nothing in this path may depend on an AI provider.**
  There is no provider call anywhere in this slice.
- **ADR 0014 boundary — `packages/core` must never import `@bananasaurs/storage`.**
  Shapes core needs from storage are re-declared in core, as
  `RuleWithWordList` already is. `packages/core/src/boundaries.test.ts`
  enforces this; do not weaken it.
- **No new dependencies.** Everything here uses `zod`, `obscenity` and
  `node:crypto`, all already installed.
- **Gates:** `npm run typecheck && npm run lint && npm run test` must all pass
  before any task is reported complete. Do not report completion on the basis
  of code you have not run.
- **Commit after every task.** If you run low on capacity, commit what works
  and report partial rather than losing the attempt.
- **Do not dispatch subagents.** You are the implementer; the coordinator runs
  review separately.
- **Naming:** this codebase spells British English in prose and comments
  (`authorise`, `behaviour`) but keeps identifiers in the existing code's
  spelling. Match the file you are editing.

## File Structure

**Created**

| File | Responsibility |
| --- | --- |
| `packages/core/src/automod/predicates/types.ts` | `PredicateInput`, `PredicateMatch`, `MatchTrace`, `Predicate`, `CompiledPredicate`, `AutomodRule`, `RULE_KINDS` |
| `packages/core/src/automod/predicates/keyword-filter.ts` | The `keyword_filter` predicate — `buildMatcher` behind `compile` |
| `packages/core/src/automod/predicates/registry.ts` | kind → predicate lookup, and `compileRule` (validate config, compile, or report why not) |
| `packages/core/src/automod/predicates/registry.test.ts` | Registry and config-validation tests |
| `packages/core/src/automod/predicates/keyword-filter.test.ts` | Predicate-level tests |
| `packages/core/src/automod/fingerprint.ts` | `ruleFingerprint` — SHA-256 over everything `compile` reads |
| `packages/core/src/automod/fingerprint.test.ts` | Fingerprint stability and sensitivity tests |
| `drizzle/0010_*.sql` | Generated migration: `mod_rules.config`, widened `kind` CHECK |

**Modified**

| File | Change |
| --- | --- |
| `packages/storage/src/schema.ts` | `modRules.config` column; `mod_rules_kind` CHECK widened to ten kinds |
| `packages/storage/src/repos/automod-rules.ts` | Return `kind` and `config`; `listEnabledRules` replaces `listEnabledKeywordFilterRules`; `createRule` takes a kind and a config; `setRuleConfig` added |
| `packages/core/src/automod/subscriber.ts` | Uses the registry and the fingerprinted cache; `RuleWithWordList` → `AutomodRule` |
| `packages/core/src/discord/events.ts` | `MessageEvent` gains mentions and attachments |
| `packages/discord/src/events.ts` | `toMessageEvent` populates them |
| `packages/core/src/ops/ports.ts` | `listUnusableAutomodRules()` |
| `packages/core/src/ops/commands/reads.ts` | `doctor` reports unusable rules |
| `packages/core/src/ops/test-fixtures.ts` | Stub for the new port |
| `apps/daemon/src/automod/wiring.ts` | Binds the new repo function and the new port |
| `apps/daemon/src/ops/wiring.ts` | Binds `listUnusableAutomodRules` |
| `packages/core/src/index.ts` | Exports the new public types |

---

### Task 1: `mod_rules.config` and the widened `kind` CHECK

**Files:**
- Modify: `packages/storage/src/schema.ts` (the `modRules` table, ~line 607)
- Modify: `packages/storage/src/repos/automod-rules.ts`
- Test: `packages/storage/src/repos/automod-rules.test.ts`
- Create: `drizzle/0010_*.sql` (generated — do not hand-write)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `RULE_KINDS_SQL` — not exported; the CHECK's ten values.
  - `automodRuleRepo.listEnabledRules(scope): readonly StoredAutomodRule[]`
  - `interface StoredAutomodRule { ruleId: string; kind: string; mode: RuleMode; config: string; terms: readonly { text: string; categoryId: string }[]; allowlist: readonly string[] }`
    — note `config` is the **raw JSON text**, unparsed and unvalidated; parsing
    is core's job (rule 3, and ADR 0014 keeps Zod schemas for predicate config
    in core, not storage).
  - `automodRuleRepo.createRule(scope, { ruleId, kind, name, config, now })`
  - `automodRuleRepo.setRuleConfig(scope, { ruleId, config, now })`
  - `automodRuleRepo.listEnabledKeywordFilterRules` is **deleted**; callers move
    to `listEnabledRules`.

- [ ] **Step 1: Write the failing tests**

Append to `packages/storage/src/repos/automod-rules.test.ts`. Follow the
existing file's setup helpers exactly — read the top of that file first and
reuse whatever it already uses to make a scoped test database and a guild row;
do not invent a second harness.

```ts
describe('mod_rules.config', () => {
  it('defaults to an empty JSON object', () => {
    const scope = /* the file's existing scope helper */;
    automodRuleRepo.createRule(scope, {
      ruleId: 'r1',
      kind: 'keyword_filter',
      name: 'words',
      config: '{}',
      now: 1,
    });
    const rules = automodRuleRepo.listEnabledRules(scope);
    expect(rules).toHaveLength(1);
    expect(rules[0]!.kind).toBe('keyword_filter');
    expect(rules[0]!.config).toBe('{}');
  });

  it('round-trips a non-empty config verbatim', () => {
    const scope = /* … */;
    automodRuleRepo.createRule(scope, {
      ruleId: 'r2',
      kind: 'caps',
      name: 'shouting',
      config: '{"ratio":0.7,"minLength":20}',
      now: 1,
    });
    expect(automodRuleRepo.listEnabledRules(scope)[0]!.config).toBe(
      '{"ratio":0.7,"minLength":20}',
    );
  });

  it('setRuleConfig replaces the stored config', () => {
    const scope = /* … */;
    automodRuleRepo.createRule(scope, {
      ruleId: 'r3', kind: 'caps', name: 'shouting', config: '{}', now: 1,
    });
    automodRuleRepo.setRuleConfig(scope, { ruleId: 'r3', config: '{"ratio":0.5}', now: 2 });
    expect(automodRuleRepo.listEnabledRules(scope)[0]!.config).toBe('{"ratio":0.5}');
  });

  it('rejects a kind outside the ten the CHECK permits', () => {
    const scope = /* … */;
    expect(() =>
      automodRuleRepo.createRule(scope, {
        ruleId: 'r4', kind: 'telepathy', name: 'nope', config: '{}', now: 1,
      }),
    ).toThrow();
  });

  it('accepts every one of the ten permitted kinds', () => {
    const scope = /* … */;
    const kinds = [
      'keyword_filter', 'regex', 'invite', 'link_domain', 'mention_spam',
      'rapid_spam', 'duplicate_message', 'caps', 'attachment_type', 'emoji',
    ];
    for (const [i, kind] of kinds.entries()) {
      automodRuleRepo.createRule(scope, {
        ruleId: `k${String(i)}`, kind, name: kind, config: '{}', now: 1,
      });
    }
    expect(automodRuleRepo.listEnabledRules(scope)).toHaveLength(kinds.length);
  });

  it('keeps a non-keyword_filter rule out of the word-list hydration path', () => {
    // A `caps` rule has no categories or terms; hydration must return empty
    // arrays rather than throwing or omitting the rule.
    const scope = /* … */;
    automodRuleRepo.createRule(scope, {
      ruleId: 'c1', kind: 'caps', name: 'shouting', config: '{}', now: 1,
    });
    const rule = automodRuleRepo.listEnabledRules(scope)[0]!;
    expect(rule.terms).toEqual([]);
    expect(rule.allowlist).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run packages/storage/src/repos/automod-rules.test.ts`
Expected: FAIL — `listEnabledRules` is not a function, `createRule` does not
accept `kind`/`config`.

- [ ] **Step 3: Widen the schema**

In `packages/storage/src/schema.ts`, inside `modRules`:

```ts
export const modRules = sqliteTable(
  'mod_rules',
  {
    guildId: snowflake('guild_id').notNull(),
    ruleId: text('rule_id').notNull(),
    kind: text('kind').notNull(),
    name: text('name').notNull(),
    /**
     * Scalar, whole-rule predicate configuration as a JSON object (ADR 0040).
     * Validated per `kind` by a Zod schema in
     * `packages/core/src/automod/predicates/`, on write *and* on read — JSON
     * this process wrote is still untrusted on the way back in (CLAUDE.md
     * rule 3, the same reason `jobs.payload` has a validator, ADR 0037).
     *
     * List-shaped data an operator edits item by item stays relational:
     * `keyword_filter`'s word list is three tables and its `config` is `{}`.
     * ADR 0040 states that split as a rule so Slices 3-5 do not re-decide it
     * per predicate.
     */
    config: text('config').notNull().default('{}'),
    mode: text('mode').notNull().default('test'),
    enabled: integer('enabled').notNull().default(1),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.guildId, t.ruleId] }),
    foreignKey({ columns: [t.guildId], foreignColumns: [guilds.guildId] }).onDelete('cascade'),
    check('mod_rules_guild_id_snowflake', snowflakeCheck(t.guildId)),
    /**
     * The ten predicate kinds Release 2 ships (ADR 0040). Widened once, here,
     * rather than one migration per predicate slice, so Slices 3-5 are pure
     * code. A kind is permitted by the CHECK before its predicate exists; a
     * rule whose kind has no registered predicate is inert, logged, and
     * reported by `doctor` — the same handling as an unparseable config.
     */
    check(
      'mod_rules_kind',
      sql`${t.kind} IN ('keyword_filter','regex','invite','link_domain','mention_spam','rapid_spam','duplicate_message','caps','attachment_type','emoji')`,
    ),
    check('mod_rules_mode', sql`${t.mode} IN ('test','observe','enforce')`),
    check('mod_rules_enabled_bool', boolCheck(t.enabled)),
  ],
);
```

Also update the table's leading doc comment: ADR 0035's claim that adding a
predicate needs no schema change was true only for `keyword_filter`; say so and
point at ADR 0040.

- [ ] **Step 4: Generate the migration**

Run: `npm run db:generate`

Then **read the generated `drizzle/0010_*.sql`** and confirm two things before
going further:

1. SQLite cannot `ALTER TABLE … ADD CONSTRAINT`, so changing a CHECK forces
   drizzle-kit to emit the table-rebuild dance (create new table, copy rows,
   drop old, rename). Confirm the copy carries **every** existing column and
   that `PRAGMA foreign_keys` handling matches what migrations 0000–0009
   already do — compare against an earlier migration that rebuilt a table if
   one exists.
2. The new `config` column is `NOT NULL DEFAULT '{}'`, so existing rows
   backfill without a data migration.

If the generated SQL drops and recreates `mod_rules`, the child tables
(`mod_rule_exemptions`, `word_categories`, `word_allowlist`) have composite
foreign keys onto it. Verify with a test that those rows survive: add to
`packages/storage/src/schema-invariants.test.ts` (or wherever that file's
existing migration tests live) a case that migrates a database holding a rule
with terms, categories, an allowlist phrase and an exemption, and asserts all
of them are still readable afterwards. **If they are not, stop and report —
do not hand-edit the migration to paper over it.**

- [ ] **Step 5: Rewrite the repository**

In `packages/storage/src/repos/automod-rules.ts`:

```ts
/** The ten predicate kinds `mod_rules_kind` permits (ADR 0040). */
export type RuleKind =
  | 'keyword_filter' | 'regex' | 'invite' | 'link_domain' | 'mention_spam'
  | 'rapid_spam' | 'duplicate_message' | 'caps' | 'attachment_type' | 'emoji';

/**
 * One enabled rule as stored, with its relational word list attached.
 *
 * `config` is the **raw JSON text**, deliberately unparsed. Parsing and
 * validating it belongs to `packages/core`'s predicate registry, which owns
 * the per-kind Zod schemas; storage may not import core and core may not
 * import storage (ADR 0014), so the string is the boundary.
 *
 * `terms` and `allowlist` are empty for every kind but `keyword_filter`,
 * whose data is relational by ADR 0040's split. A later predicate with
 * list-shaped data adds its own field here the same way.
 */
export interface StoredAutomodRule {
  readonly ruleId: string;
  readonly kind: RuleKind;
  readonly mode: RuleMode;
  readonly config: string;
  readonly terms: readonly { text: string; categoryId: string }[];
  readonly allowlist: readonly string[];
}
```

`hydrate` takes the extra columns through; keep its per-table queries exactly
as they are (the doc comment explaining why it is not a join still applies).
For a non-`keyword_filter` kind there are no categories, so `terms` comes back
`[]` naturally — no branch needed, and a test above pins that.

```ts
export const listEnabledRules = (scope: GuildScope): readonly StoredAutomodRule[] => {
  const rows = read(scope, (db) =>
    db
      .select({
        ruleId: modRules.ruleId,
        kind: modRules.kind,
        mode: modRules.mode,
        config: modRules.config,
      })
      .from(modRules)
      .where(scope.only(modRules, eq(modRules.enabled, 1)))
      .all(),
  );
  return rows.map((row) => hydrate(scope, row));
};
```

Delete `listEnabledKeywordFilterRules` and fix its callers (Task 6 rewires the
daemon; `listEnforceModeKeywordFilterRules` stays as it is — `doctor`'s Manage
Messages check is deliberately keyword-filter-specific and about deletion
permissions, not predicates).

`createRule` gains `kind` and `config` and stops hard-coding
`'keyword_filter'`. Keep the existing doc comment's point about `ruleExists`
and duplicate keys; it is still true.

```ts
export interface CreateRuleInput {
  readonly ruleId: string;
  readonly kind: RuleKind;
  readonly name: string;
  /** Serialised JSON. The caller validated it; the CHECK cannot. */
  readonly config: string;
  readonly now: number;
}

export const createRule = (scope: GuildScope, input: CreateRuleInput): void =>
  write(scope, ({ db }) => {
    db.insert(modRules)
      .values({
        guildId: scope.guildId,
        ruleId: input.ruleId,
        kind: input.kind,
        name: input.name,
        config: input.config,
        mode: 'test',
        enabled: 1,
        createdAt: input.now,
        updatedAt: input.now,
      })
      .run();
  });

export interface SetRuleConfigInput {
  readonly ruleId: string;
  /** Serialised JSON, already validated against the kind's schema by core. */
  readonly config: string;
  readonly now: number;
}

/**
 * Replaces a rule's config wholesale — not a merge. A partial update would
 * need a read-modify-write, and the caller that has a validated config object
 * already has the whole of it.
 */
export const setRuleConfig = (scope: GuildScope, input: SetRuleConfigInput): void =>
  write(scope, ({ db }) => {
    db.update(modRules)
      .set({ config: input.config, updatedAt: input.now })
      .where(scope.only(modRules, eq(modRules.ruleId, input.ruleId)))
      .run();
  });
```

Keep `RuleWithWordList` exported for now **only if** something outside this
file still imports it; otherwise delete it. Check with
`grep -rn "RuleWithWordList" packages apps --include=*.ts`.

- [ ] **Step 6: Run the tests**

Run: `npx vitest run packages/storage`
Expected: PASS. Then `npm run typecheck` — expect errors in
`apps/daemon/src/automod/wiring.ts` and `apps/daemon/src/runtime/daemon.ts`
about `listEnabledKeywordFilterRules` / `createRule`. Fix **only** the
call-site signatures needed to compile (`kind: 'keyword_filter'`,
`config: '{}'`, `listEnabledRules`); the real rewiring is Task 6.

- [ ] **Step 7: Run the full gates and commit**

```bash
npm run typecheck && npm run lint && npm run test
git add -A
git commit -m "automod: mod_rules.config carrier and the ten-kind CHECK (ADR 0040)"
```

---

### Task 2: `MessageEvent` carries mentions and attachments

**Files:**
- Modify: `packages/core/src/discord/events.ts` (`MessageEvent`, ~line 116)
- Modify: `packages/discord/src/events.ts` (`toMessageEvent`, ~line 364)
- Test: `packages/discord/src/events.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `MessageEvent` additionally carries
  `mentionedUserIds: readonly Snowflake[]`,
  `mentionedRoleIds: readonly Snowflake[]`,
  `mentionsEveryone: boolean`,
  `attachments: readonly MessageAttachment[]`, where
  `interface MessageAttachment { readonly fileName: string; readonly contentType: string | undefined; readonly sizeBytes: number }`.

**Why now rather than in Slices 4 and 5.** `mention_spam` needs mentions and
`attachment_type` needs attachments. Adding them once here, with the translator
tested once, keeps Slices 3–5 as pure predicate code — the same reasoning that
widens the `kind` CHECK once in Task 1. Cost if wrong: a few unused fields ride
along on every message event until Slice 4; discord.js already holds all of
them on the `Message` object, so nothing new is fetched.

**Check first:** `packages/core/src/pipeline/fingerprint.ts:95` — the
`messageCreate` fingerprint hashes the message id only, so adding fields does
not change any fingerprint. Confirm that by reading the function before you
start; if it hashes anything else, stop and report.

- [ ] **Step 1: Write the failing test**

In `packages/discord/src/events.test.ts`, following that file's existing fake-
message helpers:

```ts
it('carries mentions and attachments on messageCreate', () => {
  const event = translateMessageCreate(
    fakeMessage({
      content: 'hey @everyone',
      mentions: {
        users: new Map([['111111111111111111', {}]]),
        roles: new Map([['222222222222222222', {}]]),
        everyone: true,
      },
      attachments: new Map([
        ['1', { name: 'payload.exe', contentType: 'application/octet-stream', size: 4096 }],
      ]),
    }),
  );
  expect(event).toMatchObject({
    mentionedUserIds: ['111111111111111111'],
    mentionedRoleIds: ['222222222222222222'],
    mentionsEveryone: true,
    attachments: [
      { fileName: 'payload.exe', contentType: 'application/octet-stream', sizeBytes: 4096 },
    ],
  });
});

it('reports no mentions and no attachments for a partial message', () => {
  // A partial carries only ids. `content` is already `undefined` here for the
  // same reason; empty arrays say "nothing is known", which is what every
  // predicate downstream must treat as "do not match".
  const event = translateMessageDelete(fakeMessage({ partial: true }));
  expect(event).toMatchObject({
    mentionedUserIds: [],
    mentionedRoleIds: [],
    mentionsEveryone: false,
    attachments: [],
  });
});
```

Adapt the helper names to whatever that test file actually uses — read it
first. If it has no fake-message helper, build the smallest one that satisfies
`toMessageEvent`'s `AnyMessage` parameter and put it beside the existing
fakes.

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run packages/discord/src/events.test.ts`
Expected: FAIL — the properties do not exist.

- [ ] **Step 3: Extend the domain type**

In `packages/core/src/discord/events.ts`:

```ts
/**
 * One file attached to a message, as Discord declared it.
 *
 * `contentType` is Discord's `content_type`, which is **the uploader's
 * declaration**, not a sniffed type — trivially spoofed by renaming a file.
 * That is exactly why Slice 5's `attachment_type` predicate matches on the
 * declared type *and* the file extension rather than either alone. No bytes
 * are fetched here or anywhere in Release 2.
 */
export interface MessageAttachment {
  readonly fileName: string;
  /** Absent when Discord did not declare one. Never flattened to `''`. */
  readonly contentType: string | undefined;
  readonly sizeBytes: number;
}

export interface MessageEvent extends Base {
  kind: 'messageCreate' | 'messageUpdate' | 'messageDelete';
  channelId: Snowflake;
  messageId: Snowflake;
  authorId: Snowflake | undefined;
  authorIsBot: boolean;
  content: string | undefined;
  editedTimestampMs: number | undefined;
  /**
   * Resolved mentions, for Slice 4's `mention_spam`. Empty for a partial
   * message, where nothing is known — which every predicate must read as "do
   * not match", the same way `content: undefined` is read today.
   */
  mentionedUserIds: readonly Snowflake[];
  mentionedRoleIds: readonly Snowflake[];
  mentionsEveryone: boolean;
  /** For Slice 5's `attachment_type`. Metadata only; no bytes are fetched. */
  attachments: readonly MessageAttachment[];
}
```

Keep the existing doc comments on `authorIsBot` and `content` verbatim.

- [ ] **Step 4: Populate them in the translator**

In `packages/discord/src/events.ts`, inside `toMessageEvent`:

```ts
  // A partial message carries ids and nothing else — the same reason `content`
  // is `undefined` above. Reading `.mentions` off one yields empty collections
  // at best and throws at worst, and "no mentions known" must not be reported
  // as "no mentions present", so the partial case is branched explicitly.
  const mentions = message.partial ? undefined : message.mentions;

  return {
    // … existing fields unchanged …
    mentionedUserIds: mentions ? [...mentions.users.keys()] : [],
    mentionedRoleIds: mentions ? [...mentions.roles.keys()] : [],
    mentionsEveryone: mentions?.everyone ?? false,
    attachments: message.partial
      ? []
      : [...message.attachments.values()].map((a) => ({
          fileName: a.name,
          contentType: a.contentType ?? undefined,
          sizeBytes: a.size,
        })),
  };
```

**Verify against `node_modules`, not memory** (CLAUDE.md working style): open
`node_modules/discord.js/typings/index.d.ts` and confirm the property names on
`MessageMentions` (`users`, `roles`, `everyone`) and on `Attachment` (`name`,
`contentType`, `size`), and confirm whether `PartialMessage` declares
`mentions` and `attachments` at all. If any name differs, use the real one and
say so in your report.

- [ ] **Step 5: Run the tests**

Run: `npx vitest run packages/discord`
Expected: PASS. Other tests constructing a `MessageEvent` literal will now fail
to typecheck; add the four fields to those literals. There is likely a shared
test factory — prefer fixing it once there over editing many call sites.

- [ ] **Step 6: Run the full gates and commit**

```bash
npm run typecheck && npm run lint && npm run test
git add -A
git commit -m "discord: message events carry mentions and attachment metadata"
```

---

### Task 3: The predicate interface, the registry, and `keyword_filter`

**Files:**
- Create: `packages/core/src/automod/predicates/types.ts`
- Create: `packages/core/src/automod/predicates/keyword-filter.ts`
- Create: `packages/core/src/automod/predicates/registry.ts`
- Test: `packages/core/src/automod/predicates/keyword-filter.test.ts`
- Test: `packages/core/src/automod/predicates/registry.test.ts`

**Interfaces:**
- Consumes: `StoredAutomodRule`'s shape from Task 1 (re-declared in core, not
  imported — ADR 0014); `MessageAttachment` from Task 2.
- Produces: everything below, exported from `packages/core/src/index.ts`.

- [ ] **Step 1: Write `types.ts`**

There is no test-first step for a file of pure type declarations; the tests in
Steps 3 and 5 exercise them. Write it first because the next two files need it.

```ts
import type { MessageAttachment } from '../../discord/events.js';

/**
 * The ten predicate kinds `mod_rules_kind` permits (ADR 0040).
 *
 * Mirrors `packages/storage/src/repos/automod-rules.ts`'s `RuleKind` field for
 * field. Declared again here rather than imported, per ADR 0014 — `core`
 * depends on the shape, not on `@bananasaurs/storage`. The same arrangement
 * `RuleWithWordList` used before this slice.
 */
export const RULE_KINDS = [
  'keyword_filter', 'regex', 'invite', 'link_domain', 'mention_spam',
  'rapid_spam', 'duplicate_message', 'caps', 'attachment_type', 'emoji',
] as const;

export type RuleKind = (typeof RULE_KINDS)[number];

export const isRuleKind = (value: string): value is RuleKind =>
  (RULE_KINDS as readonly string[]).includes(value);

/**
 * One enabled rule as the subscriber sees it, kind-agnostic.
 *
 * Replaces ADR 0035's `RuleWithWordList`, which named `keyword_filter`'s
 * relational data in a type every predicate has to satisfy. `terms` and
 * `allowlist` are empty for every other kind (ADR 0040's split: scalar config
 * in JSON, list-shaped data in tables).
 */
export interface AutomodRule {
  readonly ruleId: string;
  readonly kind: string;
  readonly mode: 'test' | 'observe' | 'enforce';
  /** Raw JSON text from `mod_rules.config`. Untrusted until parsed. */
  readonly config: string;
  readonly terms: readonly { text: string; categoryId: string }[];
  readonly allowlist: readonly string[];
}

/**
 * One message, as a predicate sees it.
 *
 * Deliberately not the `MessageEvent` itself: a predicate gets facts about a
 * message and nothing else — no `DiscordPort`, no database handle, no clock it
 * did not receive here. That is what makes Slice 2's invariant (the dry-run
 * evaluator and the live subscriber run the same code) achievable, because a
 * fixture can construct one of these completely.
 */
export interface PredicateInput {
  readonly guildId: string;
  readonly channelId: string;
  readonly messageId: string;
  readonly authorId: string;
  /** Zero-width stripped (`stripZeroWidth`). What content predicates match. */
  readonly content: string;
  /** Exactly as Discord delivered it, for traces that must quote the original. */
  readonly rawContent: string;
  readonly mentionedUserIds: readonly string[];
  readonly mentionedRoleIds: readonly string[];
  readonly mentionsEveryone: boolean;
  readonly attachments: readonly MessageAttachment[];
  /**
   * When the adapter observed the message (`MessageEvent.receivedAtMs`), not
   * Discord's own timestamp. The window tier's clock (Slice 4) — passed in
   * rather than read from `Date.now()` so a fixture can drive it.
   */
  readonly atMs: number;
}

/**
 * Why a rule matched, in enough detail for a human to agree or disagree.
 *
 * Carried from Slice 1 even though only Slice 2 renders it: retrofitting a
 * trace into ten predicates afterwards is exactly the cost Slice 2 is
 * sequenced early to avoid (ADR 0040, Consequences).
 */
export interface MatchTrace {
  readonly kind: RuleKind;
  /** The configured thing that matched: a term, a pattern, a domain, a threshold. */
  readonly matchedOn: string;
  /**
   * Half-open `[start, end)` into `PredicateInput.content`. `undefined` for a
   * predicate whose match is a property of the whole message rather than a
   * span of it — a mention count, a message rate.
   */
  readonly span: readonly [number, number] | undefined;
  /**
   * Which normalisations were applied to the input before matching, in the
   * order they ran. A reviewer looking at a surprising match needs to know
   * that `s0me` was folded to `some` before they can judge it.
   */
  readonly normalisations: readonly string[];
  /** Predicate-specific detail, rendered as `key: value` lines. */
  readonly detail: Readonly<Record<string, string | number | boolean>>;
}

export interface PredicateMatch {
  /**
   * What goes into `mod_case_events.matched_category`. `keyword_filter` uses
   * the word category's id; a predicate with no categories uses its own kind.
   */
  readonly categoryId: string;
  /** What goes into `mod_case_events.matched_snippet`. */
  readonly snippet: string;
  readonly trace: MatchTrace;
}

/** A rule compiled once, then evaluated against many messages. */
export interface CompiledPredicate {
  /** Synchronous and side-effect free with respect to Discord. */
  evaluate(input: PredicateInput): PredicateMatch | undefined;
}

/** Just enough of a Zod schema to validate a config, without depending on it. */
export interface ConfigSchema<T> {
  parse(input: unknown): T;
}

export interface Predicate<T = unknown> {
  readonly kind: RuleKind;
  readonly config: ConfigSchema<T>;
  /**
   * Turns a rule into a reusable artifact: the `obscenity` matcher for
   * `keyword_filter`, a compiled `RegExp` for `regex`, a ring buffer for the
   * window tier. Called on a rule change, not per message — the subscriber's
   * fingerprinted cache decides when.
   *
   * May throw. A rule whose configuration compiles to nothing usable (an
   * invalid regex, a word list `obscenity` rejects) is reported by
   * `compileRule` below rather than crashing the subscriber.
   */
  compile(rule: AutomodRule, config: T): CompiledPredicate;
}

/**
 * The type a *collection* of predicates takes.
 *
 * `Predicate<never>` looks like the right existential and is not, for exactly
 * the reason `packages/core/src/jobs/worker.ts` records for `AnyJobHandler`:
 * `config` is `ConfigSchema<T>` whose `parse` returns `T`, which is covariant.
 * `unknown` works in both positions — the return type widens, and `compile` is
 * declared as a method, so its parameter is bivariant.
 */
export type AnyPredicate = Predicate<unknown>;
```

- [ ] **Step 2: Write the failing `keyword_filter` tests**

`packages/core/src/automod/predicates/keyword-filter.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { keywordFilterPredicate } from './keyword-filter.js';
import type { AutomodRule, PredicateInput } from './types.js';

const rule = (over: Partial<AutomodRule> = {}): AutomodRule => ({
  ruleId: 'r1',
  kind: 'keyword_filter',
  mode: 'enforce',
  config: '{}',
  terms: [{ text: 'badword', categoryId: 'slurs' }],
  allowlist: [],
  ...over,
});

const message = (content: string): PredicateInput => ({
  guildId: '111111111111111111',
  channelId: '222222222222222222',
  messageId: '333333333333333333',
  authorId: '444444444444444444',
  content,
  rawContent: content,
  mentionedUserIds: [],
  mentionedRoleIds: [],
  mentionsEveryone: false,
  attachments: [],
  atMs: 1_000,
});

const compile = (r: AutomodRule = rule()) =>
  keywordFilterPredicate.compile(r, keywordFilterPredicate.config.parse(JSON.parse(r.config)));

describe('keywordFilterPredicate', () => {
  it('accepts an empty config object', () => {
    expect(keywordFilterPredicate.config.parse({})).toEqual({});
  });

  it('rejects a config with unknown keys, so a typo is not silently ignored', () => {
    expect(() => keywordFilterPredicate.config.parse({ ratio: 0.7 })).toThrow();
  });

  it('matches a configured term and reports its category', () => {
    const match = compile().evaluate(message('this is a badword here'));
    expect(match?.categoryId).toBe('slurs');
    expect(match?.snippet).toBe('badword');
  });

  it('returns undefined when nothing matches', () => {
    expect(compile().evaluate(message('perfectly fine'))).toBeUndefined();
  });

  it('honours the allowlist', () => {
    const compiled = compile(rule({ allowlist: ['a badword phrase'] }));
    expect(compiled.evaluate(message('this is a badword phrase here'))).toBeUndefined();
  });

  it('still matches a term with a doubled letter outside obscenity’s six (ADR 0039)', () => {
    // The regression ADR 0039 fixed. `m` is not one of obscenity's six
    // custom-thresholded letters, so before that fix `spammer` could not match
    // even its own exact spelling.
    const compiled = compile(rule({ terms: [{ text: 'spammer', categoryId: 'spam' }] }));
    expect(compiled.evaluate(message('you are a spammer'))?.snippet).toBe('spammer');
  });

  it('produces a trace naming the matched term and its span', () => {
    const match = compile().evaluate(message('this is a badword here'));
    expect(match?.trace.kind).toBe('keyword_filter');
    expect(match?.trace.matchedOn).toBe('badword');
    expect(match?.trace.span).toEqual([10, 17]);
    expect(match?.trace.normalisations).toContain('zero-width stripped');
    expect(match?.trace.detail).toMatchObject({ categoryId: 'slurs' });
  });

  it('reports a span that actually indexes the matched snippet', () => {
    // A span nobody can slice with is a decorative trace. This is the guard
    // that makes the Slice 9 review screen's highlight trustworthy.
    const content = 'this is a badword here';
    const match = compile().evaluate(message(content));
    const [start, end] = match!.trace.span!;
    expect(content.slice(start, end)).toBe(match!.snippet);
  });
});
```

- [ ] **Step 3: Run to verify they fail**

Run: `npx vitest run packages/core/src/automod/predicates/keyword-filter.test.ts`
Expected: FAIL — the module does not exist.

- [ ] **Step 4: Write `keyword-filter.ts`**

```ts
import { z } from 'zod';
import { buildMatcher, stripZeroWidth } from '../matcher.js';
import type { AutomodRule, CompiledPredicate, Predicate } from './types.js';

/**
 * `keyword_filter` has no scalar configuration, and ADR 0040 says it stays
 * that way: a word list is list-shaped data an operator edits item by item,
 * which is what `word_categories` / `word_terms` / `word_allowlist` are for.
 * The false-positive workflow (Slice 9) allowlists an *individual term*, and
 * rows are the right shape for that where a JSON array is not.
 *
 * `.strict()` rather than a bare object, so a config written against the wrong
 * kind — `{"ratio":0.7}` on a keyword filter — is a validation error the
 * operator sees rather than a field silently ignored.
 */
export const keywordFilterConfig = z.object({}).strict();
export type KeywordFilterConfig = z.infer<typeof keywordFilterConfig>;

/**
 * The first `Predicate` (ADR 0040). Behaviour is unchanged from the subscriber's
 * inline matching — `buildMatcher` moved behind `compile`, `match` behind
 * `evaluate` — and `matcher.test.ts` plus `subscriber.test.ts` staying green,
 * unmodified, is the proof.
 */
export const keywordFilterPredicate: Predicate<KeywordFilterConfig> = {
  kind: 'keyword_filter',
  config: keywordFilterConfig,
  compile(rule: AutomodRule): CompiledPredicate {
    const matcher = buildMatcher(rule.terms, rule.allowlist);
    return {
      evaluate(input) {
        // `match()` strips zero-width characters itself; `input.content` has
        // already been stripped by the subscriber. Both, deliberately — the
        // matcher's own doc comment records that its behaviour must not depend
        // on the caller remembering.
        const hit = matcher.match(input.content);
        if (hit === undefined) return undefined;

        // Recovered rather than returned by `match()`, because `AutomodMatcher`
        // is also used directly by `matcher.test.ts` and widening its return
        // type would churn that. `indexOf` on the already-normalised content
        // is exact here: `snippet` was produced by slicing that same string.
        const start = input.content.indexOf(hit.snippet);
        const span: readonly [number, number] | undefined =
          start === -1 ? undefined : [start, start + hit.snippet.length];

        return {
          categoryId: hit.categoryId,
          snippet: hit.snippet,
          trace: {
            kind: 'keyword_filter',
            matchedOn: hit.snippet,
            span,
            normalisations: [
              'zero-width stripped',
              'confusables resolved',
              'leetspeak resolved',
              'lowercased',
              'duplicate letters collapsed (thresholds from the word list, ADR 0039)',
            ],
            detail: {
              categoryId: hit.categoryId,
              termCount: rule.terms.length,
              allowlistSize: rule.allowlist.length,
            },
          },
        };
      },
    };
  },
};
```

Note `matchedOn` is the matched **snippet**, not the configured term: `buildMatcher`
does not report which term id won, and widening `AutomodMatcher` to say so is a
Slice 2 concern (the trace format is Slice 2's deliverable). Record this in your
report as a known limitation so the coordinator can rule on it.

- [ ] **Step 5: Write the failing registry tests**

`packages/core/src/automod/predicates/registry.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { compileRule, predicateFor } from './registry.js';
import type { AutomodRule } from './types.js';

const rule = (over: Partial<AutomodRule> = {}): AutomodRule => ({
  ruleId: 'r1', kind: 'keyword_filter', mode: 'enforce', config: '{}',
  terms: [{ text: 'badword', categoryId: 'slurs' }], allowlist: [], ...over,
});

describe('predicateFor', () => {
  it('finds the keyword_filter predicate', () => {
    expect(predicateFor('keyword_filter')?.kind).toBe('keyword_filter');
  });

  it('returns undefined for a kind whose predicate has not shipped yet', () => {
    // The `kind` CHECK permits ten values from Slice 1; nine of them have no
    // predicate until Slices 3-5. That gap is handled, not prevented.
    expect(predicateFor('caps')).toBeUndefined();
  });
});

describe('compileRule', () => {
  it('compiles a valid rule', () => {
    const result = compileRule(rule());
    expect(result.ok).toBe(true);
  });

  it('reports an unknown kind rather than throwing', () => {
    const result = compileRule(rule({ kind: 'telepathy' }));
    expect(result).toEqual({ ok: false, reason: 'unknown-kind', detail: 'telepathy' });
  });

  it('reports a kind with no predicate registered yet', () => {
    const result = compileRule(rule({ kind: 'caps', terms: [], config: '{}' }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('no-predicate');
  });

  it('reports malformed JSON rather than throwing', () => {
    const result = compileRule(rule({ config: '{not json' }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('invalid-config');
  });

  it('reports a config that fails its kind’s schema', () => {
    const result = compileRule(rule({ config: '{"ratio":0.7}' }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('invalid-config');
      // The operator has to be able to see *what* was wrong, not just that
      // something was. ADR 0040 §4: inert and loud.
      expect(result.detail.length).toBeGreaterThan(0);
    }
  });

  it('reports a predicate whose compile step throws', () => {
    // A word list obscenity cannot parse. An empty pattern is the cheapest
    // case that reaches `parseRawPattern`'s own error path; if it does not
    // throw, find one that does rather than deleting this test.
    const result = compileRule(rule({ terms: [{ text: '', categoryId: 'c' }] }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('compile-failed');
  });
});
```

- [ ] **Step 6: Run to verify they fail**

Run: `npx vitest run packages/core/src/automod/predicates/registry.test.ts`
Expected: FAIL — the module does not exist.

- [ ] **Step 7: Write `registry.ts`**

```ts
import { keywordFilterPredicate } from './keyword-filter.js';
import { isRuleKind, type AnyPredicate, type AutomodRule, type CompiledPredicate, type RuleKind } from './types.js';

/**
 * kind → predicate. Slices 3-5 each add an entry and change nothing else —
 * which is what ADR 0035 promised and ADR 0040 actually delivers.
 *
 * Nine of the ten kinds `mod_rules_kind` permits are absent until their slice
 * ships. A rule naming one of them is inert, and `compileRule` reports
 * `'no-predicate'` so `doctor` can say so out loud rather than the rule
 * quietly never firing (ADR 0040 §4 — the ADR 0039 failure mode).
 */
const PREDICATES: Partial<Record<RuleKind, AnyPredicate>> = {
  keyword_filter: keywordFilterPredicate as AnyPredicate,
};

export const predicateFor = (kind: string): AnyPredicate | undefined =>
  isRuleKind(kind) ? PREDICATES[kind] : undefined;

export type CompileFailure =
  /** A `kind` the CHECK should have rejected — a hand-edited row, or a schema drift. */
  | 'unknown-kind'
  /** A permitted kind whose predicate has not shipped yet. */
  | 'no-predicate'
  /** `config` is not JSON, or fails its kind's Zod schema. */
  | 'invalid-config'
  /** The predicate's own `compile` threw — an invalid regex, an unparseable term. */
  | 'compile-failed';

export type CompileResult =
  | { readonly ok: true; readonly compiled: CompiledPredicate }
  | { readonly ok: false; readonly reason: CompileFailure; readonly detail: string };

/**
 * Validates a rule's config against its kind's schema and compiles it, or says
 * exactly why it could not.
 *
 * Never throws. A rule that cannot be compiled must not take down the
 * subscriber, because that would stop every *other* rule in the guild from
 * matching — but it must not be silent either. The caller logs it once per
 * fingerprint and `doctor` reports it (ADR 0040 §4).
 */
export const compileRule = (rule: AutomodRule): CompileResult => {
  if (!isRuleKind(rule.kind)) {
    return { ok: false, reason: 'unknown-kind', detail: rule.kind };
  }
  const predicate = PREDICATES[rule.kind];
  if (predicate === undefined) {
    return { ok: false, reason: 'no-predicate', detail: rule.kind };
  }

  let config: unknown;
  try {
    // Parsed and validated on the way *out* of the database, not only on the
    // way in (CLAUDE.md rule 3, ADR 0037's `jobs.payload` precedent): a row
    // written by an older schema version, or by hand in `sqlite3`, is exactly
    // what this catches.
    config = predicate.config.parse(JSON.parse(rule.config));
  } catch (err) {
    return {
      ok: false,
      reason: 'invalid-config',
      detail: err instanceof Error ? err.message : String(err),
    };
  }

  try {
    return { ok: true, compiled: predicate.compile(rule, config) };
  } catch (err) {
    return {
      ok: false,
      reason: 'compile-failed',
      detail: err instanceof Error ? err.message : String(err),
    };
  }
};
```

- [ ] **Step 8: Run the tests, then the full gates, then commit**

```bash
npx vitest run packages/core/src/automod
npm run typecheck && npm run lint && npm run test
git add -A
git commit -m "automod: the Predicate interface, the kind registry, and keyword_filter (ADR 0040)"
```

If the `'compile-failed'` test does not actually throw with an empty term,
find an input that does — read `node_modules/obscenity/dist/pattern/Parser.js`
for what `parseRawPattern` rejects — and use that. **Do not delete the test:**
a guard that has never been watched failing is not a guard (docs/22).

---

### Task 4: The rule fingerprint

**Files:**
- Create: `packages/core/src/automod/fingerprint.ts`
- Test: `packages/core/src/automod/fingerprint.test.ts`

**Interfaces:**
- Consumes: `AutomodRule` from Task 3.
- Produces: `ruleFingerprint(rule: AutomodRule): string` — a 64-char lowercase
  hex SHA-256 digest.

- [ ] **Step 1: Write the failing tests**

```ts
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { ruleFingerprint } from './fingerprint.js';
import type { AutomodRule } from './predicates/types.js';

const rule = (over: Partial<AutomodRule> = {}): AutomodRule => ({
  ruleId: 'r1', kind: 'keyword_filter', mode: 'enforce', config: '{}',
  terms: [{ text: 'badword', categoryId: 'slurs' }], allowlist: ['fine phrase'],
  ...over,
});

describe('ruleFingerprint', () => {
  it('is stable for an unchanged rule', () => {
    expect(ruleFingerprint(rule())).toBe(ruleFingerprint(rule()));
  });

  it('ignores the order terms and allowlist entries arrive in', () => {
    // `hydrate` queries per category, so term order tracks category order,
    // which no caller controls. An order change is not a rule change and must
    // not force a recompile.
    const a = rule({ terms: [{ text: 'a', categoryId: 'c1' }, { text: 'b', categoryId: 'c2' }] });
    const b = rule({ terms: [{ text: 'b', categoryId: 'c2' }, { text: 'a', categoryId: 'c1' }] });
    expect(ruleFingerprint(a)).toBe(ruleFingerprint(b));
  });

  it('changes when a term is added', () => {
    const more = rule({
      terms: [{ text: 'badword', categoryId: 'slurs' }, { text: 'spammer', categoryId: 'spam' }],
    });
    expect(ruleFingerprint(more)).not.toBe(ruleFingerprint(rule()));
  });

  it('changes when a term is removed', () => {
    expect(ruleFingerprint(rule({ terms: [] }))).not.toBe(ruleFingerprint(rule()));
  });

  it('changes when a term moves category', () => {
    const moved = rule({ terms: [{ text: 'badword', categoryId: 'other' }] });
    expect(ruleFingerprint(moved)).not.toBe(ruleFingerprint(rule()));
  });

  it('changes when the allowlist changes', () => {
    expect(ruleFingerprint(rule({ allowlist: [] }))).not.toBe(ruleFingerprint(rule()));
  });

  it('changes when the config changes', () => {
    expect(ruleFingerprint(rule({ config: '{"ratio":0.5}' }))).not.toBe(ruleFingerprint(rule()));
  });

  it('changes when the kind changes', () => {
    expect(ruleFingerprint(rule({ kind: 'caps' }))).not.toBe(ruleFingerprint(rule()));
  });

  it('does NOT change when only the mode changes', () => {
    // Mode decides what the subscriber *does* with a match, not what the
    // predicate matches. A mode flip must not throw away a compiled matcher —
    // flip day flips every rule at once, and rebuilding every matcher in the
    // guild at that moment is exactly the wrong time to do it.
    expect(ruleFingerprint(rule({ mode: 'observe' }))).toBe(ruleFingerprint(rule()));
  });

  it('cannot be confused by a separator appearing inside a term', () => {
    // The failure a naive `join(' ')` has: two different rules hashing to
    // the same digest because a term contains the separator. docs/22 records a
    // test that could not detect what it guarded; this one can.
    const a = rule({ terms: [{ text: 'ab', categoryId: 'c' }, { text: 'cd', categoryId: 'c' }] });
    const b = rule({ terms: [{ text: 'ab cd', categoryId: 'c' }] });
    expect(ruleFingerprint(a)).not.toBe(ruleFingerprint(b));
  });

  it('is a 64-character lowercase hex digest', () => {
    expect(ruleFingerprint(rule())).toMatch(/^[0-9a-f]{64}$/);
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run packages/core/src/automod/fingerprint.test.ts`
Expected: FAIL — the module does not exist.

- [ ] **Step 3: Implement**

```ts
import { createHash } from 'node:crypto';
import type { AutomodRule } from './predicates/types.js';

/**
 * A digest of everything `Predicate.compile` reads, and nothing else (ADR 0040 §5).
 *
 * The subscriber caches a compiled artifact beside this digest and recompiles
 * when it changes. That is what makes a term edit take effect on the next
 * message instead of on the next daemon restart — the gap `subscriber.ts` has
 * carried since ADR 0035, which ADR 0039 made sharper by deriving the
 * matcher's collapse thresholds from the word list too.
 *
 * `mode` is deliberately excluded: it decides what the subscriber does with a
 * match, not what the predicate matches.
 *
 * **Serialisation.** `JSON.stringify` over a canonical structure, not a
 * delimiter join. A join needs a separator that cannot appear in the data, and
 * no such character exists in a user-supplied term — `docs/22` records a test
 * in this repository that existed to guard a separator and could not detect
 * its own failure. `JSON.stringify` escapes its own delimiters, so
 * `["ab","cd"]` and `["ab cd"]` are different strings by construction,
 * and a test above pins that.
 *
 * Sorted because `hydrate` queries terms per category: their order tracks
 * category order, which no caller controls, and an order change is not a rule
 * change.
 */
export const ruleFingerprint = (rule: AutomodRule): string => {
  const terms = rule.terms
    .map((term) => [term.categoryId, term.text] as const)
    .sort((a, b) => (a[0] === b[0] ? a[1].localeCompare(b[1]) : a[0].localeCompare(b[0])));
  const allowlist = [...rule.allowlist].sort((a, b) => a.localeCompare(b));

  return createHash('sha256')
    .update(JSON.stringify({ kind: rule.kind, config: rule.config, terms, allowlist }))
    .digest('hex');
};
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run packages/core/src/automod/fingerprint.test.ts`
Expected: PASS, all eleven.

- [ ] **Step 5: Watch the guard fail**

Do not skip this. Temporarily change the implementation to
`.update([...rule.terms.map((t) => t.text), ...rule.allowlist].join(' '))`
and re-run. The separator test **must** go red. Restore the real
implementation, re-run, confirm green. Report both observations — "I watched it
fail" is the claim, not "it looks right" (docs/22).

- [ ] **Step 6: Full gates and commit**

```bash
npm run typecheck && npm run lint && npm run test
git add -A
git commit -m "automod: content fingerprint over everything Predicate.compile reads"
```

---

### Task 5: Rewrite the subscriber onto the registry and the fingerprinted cache

**Files:**
- Modify: `packages/core/src/automod/subscriber.ts`
- Test: `packages/core/src/automod/subscriber.test.ts`

**Interfaces:**
- Consumes: `AutomodRule`, `PredicateInput`, `MatchTrace` (Task 3);
  `compileRule` (Task 3); `ruleFingerprint` (Task 4); the extended
  `MessageEvent` (Task 2).
- Produces:
  - `AutomodSubscriberDeps.listRules(): readonly AutomodRule[]` (was
    `readonly RuleWithWordList[]`).
  - `AutomodSubscriberDeps.recordCaseEvent` gains `trace: MatchTrace` on its
    input.
  - `resetPredicateCacheForTests(): void` — exported for tests only.
  - `RuleWithWordList` is deleted from this module.

**The behaviour that must not change.** Everything from "is this author a bot"
down through safety state, deletion, escalation and `mod_case_events` is
untouched. The existing `subscriber.test.ts` cases are the contract: they may
need their `listRules` fakes reshaped (adding `kind`/`config`), but **no
assertion about an outcome may be weakened or deleted.** If one genuinely
cannot hold any more, stop and report rather than editing it.

- [ ] **Step 1: Write the failing cache-invalidation tests**

Append to `packages/core/src/automod/subscriber.test.ts`, reusing that file's
existing deps-builder rather than writing a second one.

Two mechanical notes before you copy these in:

- `subscriber.handle` is `async`, so **every `it` below that awaits must be
  declared `async`** even where the snippet elides it. Fix it as you go rather
  than shipping a test whose promise nobody awaits — a test that never awaits
  its assertion passes unconditionally, which is precisely the decorative-guard
  failure `docs/22` records.
- The `vi.spyOn(registry, 'compileRule')` line needs the subscriber to reach
  `compileRule` through a module namespace for the spy to take effect under
  ESM. If a plain `spyOn` does not intercept, use
  `vi.mock('./predicates/registry.js', async (orig) => …)` with a counting
  wrapper instead. If neither works cleanly, count compiles by giving the test
  a rule whose `terms` array is a getter that increments a counter, and assert
  the counter — but say in your report which route you took and why.

```ts
describe('the compiled-predicate cache', () => {
  beforeEach(() => {
    resetPredicateCacheForTests();
  });

  it('picks up an added term on the very next message, with no restart', () => {
    // The gap ADR 0035 left and ADR 0039 made sharper: the operator adds a
    // term through the dashboard, sees it listed, and it never matches.
    let terms = [{ text: 'badword', categoryId: 'c' }];
    const deps = makeDeps({ listRules: () => [ruleWith(terms)] });
    const subscriber = createAutomodSubscriber(deps);

    await subscriber.handle(messageEvent({ content: 'spammer here' }));
    expect(deps.recorded).toHaveLength(0);

    terms = [
      { text: 'badword', categoryId: 'c' },
      { text: 'spammer', categoryId: 'c' },
    ];
    await subscriber.handle(messageEvent({ content: 'spammer here' }));
    expect(deps.recorded).toHaveLength(1);
  });

  it('picks up a removed term on the very next message', () => {
    let terms = [{ text: 'badword', categoryId: 'c' }];
    const deps = makeDeps({ listRules: () => [ruleWith(terms)] });
    const subscriber = createAutomodSubscriber(deps);

    await subscriber.handle(messageEvent({ content: 'badword here' }));
    expect(deps.recorded).toHaveLength(1);

    terms = [];
    await subscriber.handle(messageEvent({ content: 'badword here' }));
    expect(deps.recorded).toHaveLength(1); // no second record
  });

  it('picks up a changed allowlist on the very next message', () => {
    let allowlist: string[] = [];
    const deps = makeDeps({
      listRules: () => [ruleWith([{ text: 'badword', categoryId: 'c' }], allowlist)],
    });
    const subscriber = createAutomodSubscriber(deps);

    await subscriber.handle(messageEvent({ content: 'a badword phrase' }));
    expect(deps.recorded).toHaveLength(1);

    allowlist = ['a badword phrase'];
    await subscriber.handle(messageEvent({ content: 'a badword phrase' }));
    expect(deps.recorded).toHaveLength(1);
  });

  it('does not recompile when nothing changed', async () => {
    // The cache still has to be a cache, or this task has replaced a
    // correctness bug with a performance one. `obscenity` compilation is the
    // cost being avoided, so the assertion is on the number of compiles.
    const spy = vi.spyOn(registry, 'compileRule');
    const deps = makeDeps({
      listRules: () => [ruleWith([{ text: 'badword', categoryId: 'c' }])],
    });
    const subscriber = createAutomodSubscriber(deps);
    await subscriber.handle(messageEvent({ content: 'badword one' }));
    await subscriber.handle(messageEvent({ content: 'badword two' }));
    await subscriber.handle(messageEvent({ content: 'badword three' }));
    expect(spy).toHaveBeenCalledTimes(1);
    expect(deps.recorded).toHaveLength(3);
    spy.mockRestore();
  });

  it('keeps two guilds’ rules apart even when they share a rule id', () => {
    // `daemon.ts` seeds every guild's default rule as `'default-word-filter'`.
    // A bare rule-id key let whichever guild spoke first decide what every
    // other guild matched against (CLAUDE.md rule 2 names cache keys).
    const a = makeDeps({ guildId: '111111111111111111', listRules: () => [ruleWith([{ text: 'alpha', categoryId: 'c' }])] });
    const b = makeDeps({ guildId: '222222222222222222', listRules: () => [ruleWith([{ text: 'beta', categoryId: 'c' }])] });
    await createAutomodSubscriber(a).handle(messageEvent({ guildId: '111111111111111111', content: 'alpha' }));
    await createAutomodSubscriber(b).handle(messageEvent({ guildId: '222222222222222222', content: 'alpha' }));
    expect(a.recorded).toHaveLength(1);
    expect(b.recorded).toHaveLength(0);
  });
});

describe('a rule that cannot be compiled', () => {
  it('is skipped, and every other rule still runs', () => {
    const deps = makeDeps({
      listRules: () => [
        { ...ruleWith([]), ruleId: 'broken', kind: 'caps', config: '{not json' },
        { ...ruleWith([{ text: 'badword', categoryId: 'c' }]), ruleId: 'working' },
      ],
    });
    await createAutomodSubscriber(deps).handle(messageEvent({ content: 'badword' }));
    expect(deps.recorded.map((r) => r.ruleId)).toEqual(['working']);
  });

  it('logs it once per rule, not once per message', () => {
    const deps = makeDeps({
      listRules: () => [{ ...ruleWith([]), ruleId: 'broken', kind: 'caps', config: '{not json' }],
    });
    const subscriber = createAutomodSubscriber(deps);
    await subscriber.handle(messageEvent({ content: 'one' }));
    await subscriber.handle(messageEvent({ content: 'two' }));
    await subscriber.handle(messageEvent({ content: 'three' }));
    expect(deps.logger.errors).toHaveLength(1);
  });

  it('logs again after the config changes, because the operator may have fixed it', () => {
    let config = '{not json';
    const deps = makeDeps({
      listRules: () => [{ ...ruleWith([]), ruleId: 'broken', kind: 'caps', config }],
    });
    const subscriber = createAutomodSubscriber(deps);
    await subscriber.handle(messageEvent({ content: 'one' }));
    config = '{"still":"wrong"}';
    await subscriber.handle(messageEvent({ content: 'two' }));
    expect(deps.logger.errors).toHaveLength(2);
  });
});
```

Adapt `makeDeps` / `ruleWith` / `messageEvent` to whatever `subscriber.test.ts`
already provides — read it first and extend its helpers rather than adding
parallel ones. If its fake logger does not capture `error` calls, extend it.

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run packages/core/src/automod/subscriber.test.ts`
Expected: FAIL.

- [ ] **Step 3: Rewrite the cache and the match step**

Replace the `matcherCache` block in `subscriber.ts` with:

```ts
/**
 * One compiled predicate per `(guildId, ruleId)`, held beside a fingerprint of
 * the rule it was compiled from (ADR 0040 §5).
 *
 * Module-level, so shared by every guild in the process — which is exactly why
 * the key carries the guild id (CLAUDE.md rule 2 names cache keys explicitly):
 * `daemon.ts` seeds every guild's default rule under the same id
 * (`'default-word-filter'`), so with a bare key whichever guild spoke first
 * decided what every other guild was matched against.
 *
 * **This replaces the cache that had no invalidation.** Before ADR 0040, a
 * rule whose word list changed kept matching the stale list until the daemon
 * restarted, and ADR 0039 widened that: the matcher's collapse-duplicate
 * thresholds are now derived from the word list, so a term edit changes
 * matching for terms it did not touch. Both are gone — the fingerprint covers
 * everything `compile` reads, so a mismatch recompiles on the next message.
 *
 * The fingerprint lives *beside* the entry rather than *in* the key
 * deliberately: in the key, the map would grow one entry per edit for the life
 * of the process. Here it stays bounded by the number of rules.
 *
 * Costs nothing new: `listRules()` already runs per message and already
 * hydrates the full word list from three tables. The cache never saved that
 * read — it saved the `obscenity` compilation — so fingerprinting data already
 * in hand adds a hash over a few hundred bytes.
 */
interface CacheEntry {
  readonly fingerprint: string;
  /** `undefined` when the rule could not be compiled; the reason was logged. */
  readonly compiled: CompiledPredicate | undefined;
}
const predicateCache = new Map<string, CacheEntry>();

/** Tests only. The cache is module state and would otherwise leak across cases. */
export const resetPredicateCacheForTests = (): void => {
  predicateCache.clear();
};
```

And inside the per-rule loop, replace the `buildMatcher` block:

```ts
      const cacheKey = `${event.guildId}:${rule.ruleId}`;
      const fingerprint = ruleFingerprint(rule);
      let entry = predicateCache.get(cacheKey);
      if (entry === undefined || entry.fingerprint !== fingerprint) {
        const result = compileRule(rule);
        if (result.ok) {
          entry = { fingerprint, compiled: result.compiled };
        } else {
          entry = { fingerprint, compiled: undefined };
          // Logged here — inside the fingerprint check — so it is emitted once
          // per broken configuration rather than once per message, and again
          // if the operator edits the rule (ADR 0040 §4). `doctor` reports the
          // same rules as a failing check, because a log line nobody is
          // watching is how ADR 0039's silent non-matching survived to
          // production.
          deps.logger.error(
            safeLogFields({
              component: 'automod',
              guildId: event.guildId,
              ruleId: rule.ruleId,
              outcome: result.reason,
              detail: result.detail,
            }),
            'the rule could not be compiled; it will not match until it is fixed',
          );
        }
        predicateCache.set(cacheKey, entry);
      }
      if (entry.compiled === undefined) continue;

      // Wrapped for the same reason the old `buildMatcher` call was: a
      // predicate that throws mid-evaluation is logged and skipped, and every
      // other rule still runs for this message.
      let hit: PredicateMatch | undefined;
      try {
        hit = entry.compiled.evaluate({
          guildId: event.guildId,
          channelId: event.channelId,
          messageId: event.messageId,
          authorId,
          content: normalized,
          rawContent: event.content,
          mentionedUserIds: event.mentionedUserIds,
          mentionedRoleIds: event.mentionedRoleIds,
          mentionsEveryone: event.mentionsEveryone,
          attachments: event.attachments,
          atMs: event.receivedAtMs,
        });
      } catch (err) {
        deps.logger.error(
          safeLogFields({ component: 'automod', guildId: event.guildId, ruleId: rule.ruleId, err }),
          'the predicate threw; message left unmatched for this rule',
        );
        continue;
      }
      if (hit === undefined) continue;
```

`record` then passes `hit.categoryId`, `hit.snippet` and `trace: hit.trace`
through unchanged. **The rest of `handle` — safety state, deletion, escalation,
every `record(...)` call — is untouched.**

Add `trace: MatchTrace` to `recordCaseEvent`'s input interface. Task 6 decides
what the composition root does with it; for this task it is threaded through
and the wiring may ignore it (document that in the interface's doc comment so
the next reader knows it is deliberate, not dropped).

Delete the `RuleWithWordList` interface and the `buildMatcher`/`stripZeroWidth`
import of `buildMatcher` — `stripZeroWidth` is still used for `normalized`.

- [ ] **Step 4: Reshape the existing test fakes**

`subscriber.test.ts`'s `listRules` fakes now return `AutomodRule`, so each
needs `kind: 'keyword_filter'` and `config: '{}'`. Add
`resetPredicateCacheForTests()` to the file's top-level `beforeEach` — without
it, a matcher cached by one case leaks into the next.

- [ ] **Step 5: Run the tests**

Run: `npx vitest run packages/core`
Expected: PASS, including every pre-existing `subscriber.test.ts` case
unmodified in its assertions.

- [ ] **Step 6: Watch the invalidation guard fail**

Temporarily pin the fingerprint to a constant (`const fingerprint = 'x';`) and
re-run. The three "picks up a … on the very next message" tests **must** go
red. Restore, re-run, confirm green. Report the observation.

- [ ] **Step 7: Full gates and commit**

```bash
npm run typecheck && npm run lint && npm run test
git add -A
git commit -m "automod: subscriber evaluates registered predicates behind a fingerprinted cache (ADR 0040)"
```

---

### Task 6: `doctor` reports rules that cannot be compiled

**Files:**
- Modify: `packages/core/src/ops/ports.ts`
- Modify: `packages/core/src/ops/commands/reads.ts` (`doctorCommand`, ~line 37)
- Modify: `packages/core/src/ops/test-fixtures.ts`
- Test: `packages/core/src/ops/commands/reads.test.ts`

**Interfaces:**
- Consumes: `compileRule` (Task 3), `listEnabledRules` (Task 1).
- Produces: `OpsPorts.listUnusableAutomodRules(): readonly OpsUnusableAutomodRule[]`
  where `interface OpsUnusableAutomodRule { readonly ruleId: string; readonly kind: string; readonly reason: string; readonly detail: string }`.

**Why this is in Slice 1 and not deferred.** A rule that looks configured and
silently never fires is the exact failure ADR 0039 cost a slice to find. The
widened `kind` CHECK now permits nine kinds with no predicate behind them, so
this slice *creates* new ways to reach that state. `doctor` is where "configured
but not working" is supposed to surface.

- [ ] **Step 1: Write the failing tests**

In `packages/core/src/ops/commands/reads.test.ts`, following its existing
`doctor` cases (around lines 420 and 484):

```ts
it('reports a rule whose config cannot be compiled, and fails the check', () => {
  const result = runDoctor({
    listUnusableAutomodRules: () => [
      { ruleId: 'shouting', kind: 'caps', reason: 'no-predicate', detail: 'caps' },
    ],
  });
  expect(result.text).toContain('shouting');
  expect(result.text).toContain('no-predicate');
  expect(result.text).toContain('doctor: PROBLEMS FOUND');
  expect(result.data).toMatchObject({
    ok: false,
    unusableAutomodRules: [
      { ruleId: 'shouting', kind: 'caps', reason: 'no-predicate', detail: 'caps' },
    ],
  });
});

it('says so plainly when every rule compiles', () => {
  const result = runDoctor({ listUnusableAutomodRules: () => [] });
  expect(result.text).toContain('every enabled automod rule compiles');
});
```

Use the file's own helper for building a doctor context; if it constructs ports
inline, extend that inline object.

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run packages/core/src/ops/commands/reads.test.ts`
Expected: FAIL.

- [ ] **Step 3: Add the port**

In `packages/core/src/ops/ports.ts`, beside
`OpsKeywordFilterChannelMissingManageMessages`:

```ts
/**
 * An enabled rule the subscriber cannot compile, and therefore one that
 * silently never matches (ADR 0040 §4).
 *
 * Distinct from `listKeywordFilterRulesMissingManageMessages`, which is about
 * a rule that matches correctly and then cannot act. This is a rule that never
 * gets as far as matching.
 */
export interface OpsUnusableAutomodRule {
  readonly ruleId: string;
  readonly kind: string;
  /** `CompileFailure` widened to a string, so `ops` need not import the registry's union. */
  readonly reason: string;
  readonly detail: string;
}
```

and on the `OpsPorts` interface:

```ts
  listUnusableAutomodRules(): readonly OpsUnusableAutomodRule[];
```

Add the matching `unstubbed('listUnusableAutomodRules')` entry to
`packages/core/src/ops/test-fixtures.ts`, in the same style as
`listKeywordFilterRulesMissingManageMessages` at line 36.

- [ ] **Step 4: Extend `doctorCommand`**

```ts
    const unusable = ctx.ports.listUnusableAutomodRules();
    // …
    lines.push(
      unusable.length === 0
        ? 'automod    every enabled automod rule compiles'
        : `automod    ${String(unusable.length)} rule(s) cannot be compiled and will never match:\n` +
            unusable
              .map((r) => `            ${r.ruleId}  (${r.kind})  ${r.reason}: ${r.detail}`)
              .join('\n'),
    );
```

Add `unusable.length === 0` to the `ok` conjunction and
`unusableAutomodRules: unusable.map(…)` to `data`. Extend the comment above
`ok` — it currently says "the three guild-scoped findings here"; there are now
four.

- [ ] **Step 5: Run the tests, full gates, commit**

```bash
npx vitest run packages/core/src/ops
npm run typecheck && npm run lint && npm run test
git add -A
git commit -m "doctor: report enabled automod rules that cannot be compiled (ADR 0040)"
```

---

### Task 7: Wiring, seeding, and the integration test

**Files:**
- Modify: `apps/daemon/src/automod/wiring.ts`
- Modify: `apps/daemon/src/ops/wiring.ts`
- Modify: `apps/daemon/src/runtime/daemon.ts` (the first-run seeding call)
- Modify: `packages/core/src/automod/seed.ts` if it names `createRule`'s shape
- Modify: `packages/core/src/index.ts` (exports)
- Test: `apps/daemon/src/automod.integration.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 1–6.
- Produces: a green end-to-end path.

- [ ] **Step 1: Write the failing integration test**

Append to `apps/daemon/src/automod.integration.test.ts`, using that file's
existing real-database, fake-Discord harness:

```ts
it('applies a term added after the subscriber has already matched, with no restart', () => {
  // End-to-end proof of ADR 0040 §5 against a real database: the unit test in
  // subscriber.test.ts fakes `listRules`, so this is the one that shows the
  // repository, the fingerprint and the cache agreeing.
  // 1. seed a rule with one term; post a message using a *different* word;
  //    assert no mod_case_events row
  // 2. addTerm(...) that second word through automodRuleRepo
  // 3. post the same message again
  // 4. assert exactly one mod_case_events row, naming the new term's category
});

it('a rule whose kind has no predicate yet is inert and shows up in doctor', () => {
  // createRule(kind: 'caps'), then run the doctor command through the ops
  // dispatcher and assert the rule is listed and `ok` is false.
});
```

Write these out fully against the harness the file already has — read it first.

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run apps/daemon/src/automod.integration.test.ts`

- [ ] **Step 3: Rewire**

In `apps/daemon/src/automod/wiring.ts`, `automodPortsFor`:

```ts
    listRules: () => automodRuleRepo.listEnabledRules(scope),
```

`recordCaseEvent` now receives `trace`. **Do not persist it in this slice** —
`mod_case_events` has no column for it and adding one is Slice 2's deliverable
(the trace format is what Slice 2 designs). Destructure it away explicitly with
a comment saying so, rather than letting it fall through into a spread where a
future reader cannot tell whether it was dropped on purpose:

```ts
    // `trace` is threaded through the subscriber from Slice 1 so ten
    // predicates do not each need retrofitting later (ADR 0040), but
    // `mod_case_events` has nowhere to put it until Slice 2 adds the column
    // and the trace format. Dropped here, deliberately and visibly.
    recordCaseEvent: ({ trace: _trace, ...input }) => modCaseRepo.recordCaseEvent(scope, { … }),
```

In `apps/daemon/src/ops/wiring.ts`, add beside
`listKeywordFilterRulesMissingManageMessages`:

```ts
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
```

Note this compiles every rule on every `doctor` run, which is correct — `doctor`
is a human-invoked command, not a hot path, and compiling is exactly the check.

In `apps/daemon/src/runtime/daemon.ts` and `packages/core/src/automod/seed.ts`,
update `createRule` calls to pass `kind: 'keyword_filter'` and `config: '{}'`.

Export from `packages/core/src/index.ts`: `RULE_KINDS`, `isRuleKind`, and the
types `RuleKind`, `AutomodRule`, `PredicateInput`, `PredicateMatch`,
`MatchTrace`, `CompiledPredicate`, `Predicate`, `AnyPredicate`,
`CompileResult`, `CompileFailure`; and the functions `compileRule`,
`predicateFor`, `ruleFingerprint`, `resetPredicateCacheForTests`. Follow the
file's existing grouping and comment style.

- [ ] **Step 4: Run everything**

```bash
npm run typecheck && npm run lint && npm run test
```

Expected: all green, 1,953 tests plus the ones this slice adds. If the count
went *down*, a test was deleted — find out which and report it.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "automod: wire the predicate registry and the doctor check into the daemon"
```

---

## Slice completion checklist

Answer each line explicitly in your final report.

- [ ] Every new repository function takes `GuildScope` first (rule 2).
- [ ] Every cache key begins with the guild id, and a test proves two guilds
      sharing a rule id do not collide (rule 2).
- [ ] `mod_rules.config` is validated by a Zod schema on write **and** on read
      (rule 3).
- [ ] No new Discord side effect was introduced, so rule 6 is unchanged — say
      so rather than leaving it blank.
- [ ] No provider call anywhere; nothing here degrades with every provider
      unreachable (rule 1).
- [ ] Nothing new reaches a log that `safeLogFields`' allowlist does not
      already permit — check `component`, `guildId`, `ruleId`, `outcome`,
      `detail`, `err` against `LOGGABLE_FIELDS` and extend the allowlist
      explicitly if `detail` is not there (rule 4).
- [ ] No new dependency (rule 7).
- [ ] `npm run typecheck && npm run lint && npm run test` all pass, run by you,
      with the output in your report.
- [ ] The two guards were **watched failing**: the fingerprint separator test
      and the cache-invalidation tests.
