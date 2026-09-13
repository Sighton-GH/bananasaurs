# Slice 8 — Release 2 pages: implementation plan

> **For agentic workers:** executed with
> `opencode-delegate:opencode-driven-development`, one task per dispatch, a
> task review per task, an Opus whole-branch review at the end.

**Goal:** The dashboard shows and edits automod rules (list, detail, config,
exemptions, mode, dry-run against fixtures), shows cases and member history,
and shows the cutover board — every rule's `legacy_rule_ref`, `cutover_state`,
days observed and match count.

**Architecture:** Three layers, bottom up. (1) `packages/storage` gains one
new repository module, `automod-admin.ts`, with the guild-scoped queries the
pages need and no writes to `mod_rules` beyond what already exists; (2)
`OpsPorts` gains eleven members implemented in the daemon's wiring, in
`packages/http`'s test-support ports, and in core's fake; (3) `packages/http`
gains two route modules that map ports onto the session's guild scope with
the same guard/capability/audit pattern as `write.ts`; (4) the dashboard gains
six pages behind the Slice 7 shell. **`setRuleMode`, `setRuleConfig`,
`createRule` and the exemption writers are called as they are; none is
modified.**

**Tech Stack:** as Slice 7, plus Fastify routes and drizzle queries in the
existing style.

**Spec:** `docs/superpowers/specs/2026-09-01-release-2-completion-and-release-3-roadmap-design.md`
§3 Slice 8; ADR 0042 (the state machine the mode control drives); ADR 0043
(the shell). Rulings PR-44..PR-50 in `docs/reports/release2-slices-7-12-ledger.md`
bind every task.

## Global Constraints

- **Read `docs/reports/briefs/SANDBOX_RULES.md` before running any command.**
  Explicit paths on every `rg` and `git`; gates by exit code; `git restore`
  to undo experiments; never read `.env`, `data/**`, `backups/**`.
- **No new dependencies.**
- **Do not modify** `setRuleMode`, `setRuleConfig`, `createRule`,
  `addRoleExemption`, `addChannelExemption`, `enforcementEligibility`, the
  `mod_rules` schema, any migration, or `packages/core/src/effects/gateway.ts`.
  The observe window is running on two guilds; a change there restarts it.
  You may **add** functions to `automod-rules.ts` only where a task names one.
- **Guild scope (CLAUDE.md rule 2):** every new repository function takes
  `scope: GuildScope` first and filters with `scope.only(table, …)`; every
  new repository function has a two-guild test proving one guild cannot see
  the other's rows. Every route reads `session.scope` and never a guild id
  from the request.
- **Capabilities (PR-44):** rule reads need `config.read`; rule writes need
  `config.write`; case and member-history reads need `audit.read`. No new
  capability — the existing owner account was granted the current list at
  bootstrap and a new name would not reach it without a migration.
- **Re-auth (PR-45):** `POST /api/automod/rules` (create) and
  `POST /api/automod/rules/:ruleId/mode` use `guard.requireFresh`; every other
  write uses `guard.require`.
- **Validation (rule 3):** every request body passes a Zod schema; a rule
  `config` body is validated with core's `validateRuleConfig(kind, json)`
  before any write and a failure returns 400 with the issues. `ruleId`,
  `caseId`, `memberId` path params are validated too (`ruleId`: `/^[a-z0-9][a-z0-9-]{0,63}$/`;
  `memberId` and exemption ids: `snowflakeIdSchema` from `@bananasaurs/core`;
  `caseId`: `z.string().uuid()`).
- **Audit (rule 6 in spirit):** every write route records an audit row through
  `ports.recordAudit` with `dashboardAuditBase`, `before` and `after`.
- **Ports are implemented three times** and every task that adds a member
  adds it to all three: `apps/daemon/src/ops/wiring.ts` (production),
  `packages/http/src/test-support.ts` (real repos, for route tests), and
  `packages/core/src/ops/test-fixtures.ts` (`unstubbed(...)` entries).
- **Dashboard rules from Slice 7 carry over verbatim:** `*.test.tsx` files
  start with `// @vitest-environment jsdom`, import `cleanup` and call
  `afterEach(cleanup)`; tests stub fetch with `stubFetch` and assert URLs,
  bodies and roles, never class names; a `.ts` file never imports from a
  `.tsx`; optional props under `exactOptionalPropertyTypes` use a conditional
  spread; the hold colour is for state only; every page renders through
  `DataState`; every destructive or window-affecting action goes through
  `ConfirmDialog` with its exact scope stated.
- **Copy (ADR 0043 D4):** sentence case, buttons name their effect, toasts
  repeat the verb, empty states say what to do next.
- **Gates run alone, read by exit code:** `npm run typecheck`, `npm run lint`,
  `npm run test`.

---

## File structure

```
packages/storage/src/repos/automod-admin.ts          (Task 1)  listRules, findRule, listExemptions, removeExemption, countMatchesByRule, countReviewedByRule, listRecentCases, findCase
packages/storage/src/repos/automod-admin.test.ts     (Task 1)
packages/storage/src/index.ts                        (Task 1)  export * as automodAdminRepo
packages/core/src/ops/ports.ts                       (Task 2)  eleven new members + types
packages/core/src/ops/test-fixtures.ts               (Task 2)
packages/http/src/test-support.ts                    (Task 2)
apps/daemon/src/ops/wiring.ts                        (Task 2)
packages/http/src/routes/automod.ts                  (Task 3)  registerAutomodRoutes
packages/http/src/routes/automod.test.ts             (Task 3)
packages/http/src/routes/cases.ts                    (Task 4)  registerCaseRoutes
packages/http/src/routes/cases.test.ts               (Task 4)
packages/http/src/index.ts                           (Task 3, 4) exports
apps/daemon/src/http/wiring.ts                       (Task 3, 4) registration
packages/dashboard/src/app/routes.ts                 (Task 5)  NAV rows
packages/dashboard/src/app/Shell.tsx                 (Task 5)  routes
packages/dashboard/src/app/session.tsx               (Task 5)  re-auth queue (carried from Slice 7)
packages/dashboard/src/api/automod.ts                (Task 5)  response types + fetchers
packages/dashboard/src/pages/automod-rules.tsx       (Task 5)  list + New rule
packages/dashboard/src/pages/cutover.tsx             (Task 5)  board
packages/dashboard/src/pages/automod-rule.tsx        (Task 6)  detail
packages/dashboard/src/pages/cases.tsx               (Task 7)  list
packages/dashboard/src/pages/case.tsx                (Task 7)  detail
packages/dashboard/src/pages/member.tsx              (Task 7)  history
```

---

### Task 1: Storage — the admin queries (tests first)

**Files:**
- Create: `packages/storage/src/repos/automod-admin.ts`
- Create: `packages/storage/src/repos/automod-admin.test.ts`
- Modify: `packages/storage/src/index.ts` (add `export * as automodAdminRepo from './repos/automod-admin.js';` next to `automodRuleRepo`)

**Interfaces — Produces:**

```ts
import type { CutoverState, RuleKind, RuleMode } from './automod-rules.js';
import type { ModCase, ModCaseEvent } from './mod-cases.js';

export interface AdminRule {
  readonly ruleId: string;
  readonly kind: RuleKind;
  readonly name: string;
  readonly mode: RuleMode;
  readonly enabled: boolean;
  readonly config: string;
  readonly cutoverState: CutoverState;
  readonly observeStartedAt: number | null;
  readonly legacyRuleRef: string | null;
  readonly countsAsViolation: boolean;
  readonly maxFalsePositiveRate: number;
  readonly minReviewedMatches: number;
  readonly enforceSignedOffBy: string | null;
  readonly enforceSignedOffAt: number | null;
  readonly createdAt: number;
  readonly updatedAt: number;
}
export const listRules = (scope: GuildScope): readonly AdminRule[];            // ordered by ruleId, enabled and disabled alike
export const findRule = (scope: GuildScope, ruleId: string): AdminRule | undefined;

export interface RuleExemption { readonly exemptType: 'role' | 'channel'; readonly exemptId: string }
export const listExemptions = (scope: GuildScope, ruleId: string): readonly RuleExemption[];   // ordered by type then id
export const removeExemption = (scope: GuildScope, input: { readonly ruleId: string; readonly exemptType: 'role' | 'channel'; readonly exemptId: string }): boolean;  // true if a row was deleted

/** `mod_case_events` rows per rule_id — every event, whatever its action_taken. */
export const countMatchesByRule = (scope: GuildScope): Readonly<Record<string, number>>;
/** `mod_match_reviews` rows per rule, attributed through the event they name (the same join enforcement-gate.ts uses). */
export const countReviewedByRule = (scope: GuildScope): Readonly<Record<string, number>>;

export const listRecentCases = (scope: GuildScope, query: { readonly limit: number }): readonly ModCase[];   // newest opened first, rowid DESC tiebreak
export const findCase = (scope: GuildScope, caseId: string): ModCase | undefined;
```

`ModCase` and `ModCaseEvent` already exist in `mod-cases.ts`; `listCaseEvents`
and `listCasesForMember` already exist there too and are not duplicated.

- [ ] **Step 1: Write the failing tests**

`automod-admin.test.ts` — follow the shape of `automod-rules.test.ts`
(how it opens a migrated test database, seeds a guild, creates a rule). Use
`openMigratedTestDatabase` from `../test-support.js`, two guilds
`'111111111111111111'` and `'222222222222222222'`, and the existing writers
(`automodRuleRepo.createRule`, `addRoleExemption`, `addChannelExemption`,
`modCaseRepo.openOrResolveCase`, `recordCaseEvent`, `modMatchReviewRepo.recordVerdict`)
to seed. Cases to cover, one `it` each:

1. `listRules` returns enabled and disabled rules ordered by `ruleId`, with
   `enabled` as a boolean and every ADR 0042 column present; it returns
   nothing from the other guild.
2. `findRule` returns the row for its guild and `undefined` for the same
   `ruleId` under the other guild.
3. `listExemptions` returns role and channel exemptions ordered by type then
   id; `removeExemption` returns `true` once and `false` on a repeat; the
   other guild's identical exemption is untouched (assert it is still listed
   there).
4. `countMatchesByRule` counts events per `ruleId` for this guild only (seed
   two events for rule A and one for rule B here, one for rule A in the other
   guild; expect `{ A: 2, B: 1 }`).
5. `countReviewedByRule` counts only events that have a verdict, attributed
   to the event's rule (seed three events, verdicts on two of them for rule A
   and none for B; expect `{ A: 2 }` with no key for B).
6. `listRecentCases` orders newest `openedAt` first and honours `limit`;
   `findCase` finds by id in its guild and returns `undefined` from the other.

Run: `npx vitest run packages/storage/src/repos/automod-admin.test.ts` —
expected: fails to import the module.

- [ ] **Step 2: Implement**

`automod-admin.ts`:

```ts
import { and, asc, desc, eq, sql } from 'drizzle-orm';
import { modCaseEvents, modCases, modMatchReviews, modRuleExemptions, modRules } from '../schema.js';
import type { GuildScope } from '../scope.js';
import { read, write } from '../db.js';
import type { CutoverState, RuleKind, RuleMode } from './automod-rules.js';
import type { ModCase } from './mod-cases.js';

/**
 * Read-mostly queries for the dashboard's automod pages (Slice 8). Kept out
 * of `automod-rules.ts` deliberately: that module owns the state machine
 * (`setRuleMode`) and the subscriber's hot path, and the observe window is
 * running — nothing here changes what a rule does, only what an operator can
 * see about it. The one write, `removeExemption`, is the inverse of two
 * writers that already live there.
 */

export interface AdminRule { /* as in Interfaces */ }

const RULE_COLUMNS = {
  ruleId: modRules.ruleId,
  kind: modRules.kind,
  name: modRules.name,
  mode: modRules.mode,
  enabled: modRules.enabled,
  config: modRules.config,
  cutoverState: modRules.cutoverState,
  observeStartedAt: modRules.observeStartedAt,
  legacyRuleRef: modRules.legacyRuleRef,
  countsAsViolation: modRules.countsAsViolation,
  maxFalsePositiveRate: modRules.maxFalsePositiveRate,
  minReviewedMatches: modRules.minReviewedMatches,
  enforceSignedOffBy: modRules.enforceSignedOffBy,
  enforceSignedOffAt: modRules.enforceSignedOffAt,
  createdAt: modRules.createdAt,
  updatedAt: modRules.updatedAt,
};

const toAdminRule = (row: {
  ruleId: string; kind: string; name: string; mode: string; enabled: number; config: string;
  cutoverState: string; observeStartedAt: number | null; legacyRuleRef: string | null;
  countsAsViolation: number; maxFalsePositiveRate: number; minReviewedMatches: number;
  enforceSignedOffBy: string | null; enforceSignedOffAt: number | null; createdAt: number; updatedAt: number;
}): AdminRule => ({
  ...row,
  kind: row.kind as RuleKind,
  mode: row.mode as RuleMode,
  enabled: row.enabled === 1,
  cutoverState: row.cutoverState as CutoverState,
  countsAsViolation: row.countsAsViolation === 1,
});

export const listRules = (scope: GuildScope): readonly AdminRule[] =>
  read(scope, (db) =>
    db.select(RULE_COLUMNS).from(modRules).where(scope.only(modRules)).orderBy(asc(modRules.ruleId)).all().map(toAdminRule),
  );

export const findRule = (scope: GuildScope, ruleId: string): AdminRule | undefined =>
  read(scope, (db) => {
    const row = db.select(RULE_COLUMNS).from(modRules).where(scope.only(modRules, eq(modRules.ruleId, ruleId))).get();
    return row === undefined ? undefined : toAdminRule(row);
  });

export interface RuleExemption { readonly exemptType: 'role' | 'channel'; readonly exemptId: string }

export const listExemptions = (scope: GuildScope, ruleId: string): readonly RuleExemption[] =>
  read(scope, (db) =>
    db
      .select({ exemptType: modRuleExemptions.exemptType, exemptId: modRuleExemptions.exemptId })
      .from(modRuleExemptions)
      .where(scope.only(modRuleExemptions, eq(modRuleExemptions.ruleId, ruleId)))
      .orderBy(asc(modRuleExemptions.exemptType), asc(modRuleExemptions.exemptId))
      .all()
      .map((r) => ({ exemptType: r.exemptType as 'role' | 'channel', exemptId: r.exemptId })),
  );

export const removeExemption = (
  scope: GuildScope,
  input: { readonly ruleId: string; readonly exemptType: 'role' | 'channel'; readonly exemptId: string },
): boolean =>
  write(scope, ({ db }) => {
    const result = db
      .delete(modRuleExemptions)
      .where(
        scope.only(
          modRuleExemptions,
          and(
            eq(modRuleExemptions.ruleId, input.ruleId),
            eq(modRuleExemptions.exemptType, input.exemptType),
            eq(modRuleExemptions.exemptId, input.exemptId),
          ),
        ),
      )
      .run();
    return result.changes > 0;
  });

export const countMatchesByRule = (scope: GuildScope): Readonly<Record<string, number>> =>
  read(scope, (db) =>
    Object.fromEntries(
      db
        .select({ ruleId: modCaseEvents.ruleId, n: sql<number>`count(*)` })
        .from(modCaseEvents)
        .where(scope.only(modCaseEvents))
        .groupBy(modCaseEvents.ruleId)
        .all()
        .map((r) => [r.ruleId, Number(r.n)]),
    ),
  );

export const countReviewedByRule = (scope: GuildScope): Readonly<Record<string, number>> =>
  read(scope, (db) =>
    Object.fromEntries(
      db
        .select({ ruleId: modCaseEvents.ruleId, n: sql<number>`count(*)` })
        .from(modMatchReviews)
        .innerJoin(
          modCaseEvents,
          and(eq(modMatchReviews.guildId, modCaseEvents.guildId), eq(modMatchReviews.eventId, modCaseEvents.eventId)),
        )
        .where(scope.only(modMatchReviews))
        .groupBy(modCaseEvents.ruleId)
        .all()
        .map((r) => [r.ruleId, Number(r.n)]),
    ),
  );

export const listRecentCases = (scope: GuildScope, query: { readonly limit: number }): readonly ModCase[] =>
  read(scope, (db) =>
    db
      .select()
      .from(modCases)
      .where(scope.only(modCases))
      .orderBy(desc(modCases.openedAt), sql`rowid DESC`)
      .limit(query.limit)
      .all()
      .map((row) => ({
        caseId: row.caseId, memberId: row.memberId, openedAt: row.openedAt,
        violationCount: row.violationCount, escalationTier: row.escalationTier,
        status: row.status as ModCase['status'],
      })),
  );

export const findCase = (scope: GuildScope, caseId: string): ModCase | undefined =>
  read(scope, (db) => {
    const row = db.select().from(modCases).where(scope.only(modCases, eq(modCases.caseId, caseId))).get();
    return row === undefined ? undefined : {
      caseId: row.caseId, memberId: row.memberId, openedAt: row.openedAt,
      violationCount: row.violationCount, escalationTier: row.escalationTier,
      status: row.status as ModCase['status'],
    };
  });
```

Check `scope.only`'s signature in `packages/storage/src/scope.ts` before
writing — if it requires a second argument, pass `sql\`1=1\`` where no extra
filter is needed, or use whatever idiom `listEnabledRules`'s neighbours use
for "this guild, no other filter" (`rg -n "scope.only\(" packages/storage/src/repos/mod-cases.ts`).
Check `read`/`write`'s import path (`rg -n "^import .* from '\.\./db" packages/storage/src/repos/mod-cases.ts`)
and the `modMatchReviews.guildId` column name in `schema.ts`.

- [ ] **Step 3: Run the tests, then the gates, then commit**

```bash
git add packages/storage/src/repos/automod-admin.ts packages/storage/src/repos/automod-admin.test.ts packages/storage/src/index.ts
git commit -m "feat(storage): automod admin queries for the dashboard (Slice 8 task 1)"
```

---

### Task 2: The port surface, three times

**Files:**
- Modify: `packages/core/src/ops/ports.ts`
- Modify: `packages/core/src/ops/test-fixtures.ts`
- Modify: `packages/http/src/test-support.ts`
- Modify: `apps/daemon/src/ops/wiring.ts`
- Modify: `packages/storage/src/repos/automod-rules.ts` — **add one read
  function only**, `findRuleIncludingDisabled`, next to `listEnabledRules`,
  reusing the module-private `hydrate` (the same select as `listEnabledRules`
  with `eq(modRules.ruleId, ruleId)` instead of the enabled filter). Nothing
  else in that file changes.
- Test: `packages/storage/src/repos/automod-rules.test.ts` — one added `it`:
  `findRuleIncludingDisabled` returns a disabled rule and `undefined` for the
  other guild.

**Interfaces — Produces (add to `OpsPorts`, with doc comments in the file's style):**

```ts
export interface OpsAutomodRuleSummary extends AdminRule {   // import type { AdminRule } from '@bananasaurs/storage'
  readonly matchCount: number;
  readonly reviewedCount: number;
}
export interface OpsAutomodRuleDetail extends OpsAutomodRuleSummary {
  readonly exemptions: readonly { readonly exemptType: 'role' | 'channel'; readonly exemptId: string }[];
  readonly terms: readonly { readonly text: string; readonly categoryId: string }[];
  readonly allowlist: readonly string[];
  readonly inviteAllowlist: readonly { readonly code: string; readonly label: string }[];
  readonly linkDomains: readonly { readonly domain: string; readonly listType: 'allow' | 'deny' }[];
  readonly eligibility: EnforcementEligibility;                 // from @bananasaurs/storage
}
export interface OpsCaseDetail { readonly case: ModCase; readonly events: readonly ModCaseEvent[] }   // types from @bananasaurs/storage

// members:
listAutomodRules(): readonly OpsAutomodRuleSummary[];
findAutomodRuleDetail(ruleId: string): OpsAutomodRuleDetail | undefined;
createAutomodRule(input: { readonly ruleId: string; readonly kind: RuleKind; readonly name: string; readonly config: string }): 'created' | 'exists';
setAutomodRuleConfig(input: { readonly ruleId: string; readonly config: string }): 'ok' | 'no-such-rule';
setAutomodRuleMode(input: { readonly ruleId: string; readonly mode?: RuleMode; readonly enabled?: boolean }): EnforcementEligibility | 'no-such-rule';
addAutomodExemption(input: { readonly ruleId: string; readonly exemptType: 'role' | 'channel'; readonly exemptId: string }): 'added' | 'already-present' | 'no-such-rule';
removeAutomodExemption(input: { readonly ruleId: string; readonly exemptType: 'role' | 'channel'; readonly exemptId: string }): 'removed' | 'not-present';
runAutomodDryRun(ruleId: string): DryRunReport | 'no-such-rule';     // DryRunReport from '../automod/dry-run.js'
listRecentCases(query: { readonly limit: number }): readonly ModCase[];
findCaseDetail(caseId: string): OpsCaseDetail | undefined;
listCasesForMember(memberId: string): readonly ModCase[];
```

- [ ] **Step 1: Types and members in `ports.ts`**, each with a doc comment
  saying which page consumes it. `createAutomodRule` checks `ruleExists`
  first and returns `'exists'`; `setAutomodRuleConfig` and
  `setAutomodRuleMode` check `ruleExists` and return `'no-such-rule'`;
  `addAutomodExemption` catches the primary-key conflict and returns
  `'already-present'` (look at how `addInviteAllowlistEntry` in
  `wiring.ts` handles its `already-present` case and do the same).
  `runAutomodDryRun` uses `findRuleIncludingDisabled` → `toAutomodRule` →
  `runDryRun({ guildId, rule, fixtures: listFixtures(scope, {}) })` — a
  disabled rule **may** be dry-run from the dashboard (PR-47: an operator
  edits a disabled rule, dry-runs it, then enables it; the CLI's
  enabled-only `findAutomodRule` is unchanged).
- [ ] **Step 2: `apps/daemon/src/ops/wiring.ts`** — implement all eleven
  against `automodAdminRepo`, `automodRuleRepo`, `modCaseRepo`,
  `automodFixtureRepo`, `enforcementGateRepo.enforcementEligibility`. `now`
  comes from the closure the existing members use.
- [ ] **Step 3: `packages/http/src/test-support.ts`** — the same, except
  `runAutomodDryRun` returns `'no-such-rule'` when
  `automodRuleRepo.ruleExists` is false and otherwise a canned report
  `{ ruleId, kind: rule.kind, usable: true, failure: undefined, threwCount: 0, abandoned: false, fixtures: [], matched: 0, agreed: 0, disagreed: 0, unlabelled: 0 }` —
  read `DryRunReport`'s actual field list from `dry-run.ts` and fill every
  field; the route test only asserts pass-through (`toAutomodRule` lives in
  `apps/daemon` and this package may not import it).
- [ ] **Step 4: `packages/core/src/ops/test-fixtures.ts`** — eleven
  `unstubbed('…')` entries.
- [ ] **Step 5: Typecheck, then the existing ops integration test**

Run `npm run typecheck` (exit 0) and
`npx vitest run apps/daemon/src/ops/ops.integration.test.ts packages/storage/src/repos/automod-rules.test.ts`.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/ops/ports.ts packages/core/src/ops/test-fixtures.ts packages/http/src/test-support.ts apps/daemon/src/ops/wiring.ts packages/storage/src/repos/automod-rules.ts packages/storage/src/repos/automod-rules.test.ts
git commit -m "feat(ops): automod admin and case ports, three implementations (Slice 8 task 2)"
```

---

### Task 3: Automod routes

**Files:**
- Create: `packages/http/src/routes/automod.ts`
- Create: `packages/http/src/routes/automod.test.ts`
- Modify: `packages/http/src/index.ts` (export `registerAutomodRoutes`)
- Modify: `apps/daemon/src/http/wiring.ts` (register it after `registerWriteRoutes`)

**Interfaces — Produces:** `registerAutomodRoutes(app, guard, deps)` with:

| Method | Path | Guard | Capability | Body (Zod) | 200 body |
| --- | --- | --- | --- | --- | --- |
| GET | `/api/automod/rules` | require | config.read | — | `{ rules: OpsAutomodRuleSummary[] }` |
| GET | `/api/automod/rules/:ruleId` | require | config.read | — | `OpsAutomodRuleDetail` with `config` parsed to an object as `configObject` alongside the raw string |
| POST | `/api/automod/rules` | requireFresh | config.write | `{ ruleId, kind: z.enum(RULE_KINDS), name: z.string().min(1).max(80), config: z.record(z.unknown()) }` | `{ ok: true }`; 409 `{ error: 'exists' }`; 400 `{ error: 'invalid-config', issues }` |
| PUT | `/api/automod/rules/:ruleId/config` | require | config.write | `{ config: z.record(z.unknown()) }` | `{ ok: true }`; 404; 400 `invalid-config` |
| POST | `/api/automod/rules/:ruleId/mode` | requireFresh | config.write | `{ mode?: z.enum(['test','observe','enforce']), enabled?: z.boolean() }` (at least one, `.refine`) | `{ ok: true }`; 404; 409 `{ error: 'not-eligible', refusal }` when eligibility `ok: false` |
| POST | `/api/automod/rules/:ruleId/exemptions` | require | config.write | `{ exemptType: z.enum(['role','channel']), exemptId: snowflakeIdSchema }` | `{ ok: true, outcome: 'added' \| 'already-present' }`; 404 |
| DELETE | `/api/automod/rules/:ruleId/exemptions/:exemptType/:exemptId` | require | config.write | — | `{ ok: true, outcome: 'removed' \| 'not-present' }` |
| POST | `/api/automod/rules/:ruleId/dry-run` | require | config.read | — | the `DryRunReport`; 404 |

`RULE_KINDS`: find the exported list of the ten kinds in core
(`rg -n "RULE_KINDS|as const" packages/core/src/automod/predicates/registry.ts packages/storage/src/repos/automod-rules.ts`)
and import it rather than retyping. `validateRuleConfig(kind, JSON.stringify(config))`
from `@bananasaurs/core` gates create and config; on `{ ok: false }` reply
400 with `{ error: 'invalid-config', issues }` where `issues` is whatever the
result carries (read `ConfigValidationResult`).

Audit rows: `automod_rule.created`, `automod_rule.config_set` (before: old
config string; after: new), `automod_rule.mode_set` (before: `{ mode, enabled }`;
after: the request), `automod_rule.exemption_added`, `automod_rule.exemption_removed`;
`subjectType: 'automod_rule'`, `subjectId: ruleId`. A 409/404 records no
audit row.

- [ ] **Step 1: Tests first** — `automod.test.ts` in the shape of
  `write.test.ts` (real migrated database, `testPortsFor`, a session cookie
  from a real login; copy its `beforeEach`, `grant`, and login helpers). One
  `it` per row of the table plus: capability refused → 403; the fresh-session
  routes return 401 `reauth-required` when the session is stale (see how
  `write.test.ts` ages the session for the killswitch-off case); a config that
  fails the kind's schema → 400 with issues and **no** change to the stored
  config; `mode: 'enforce'` on a `not_started` rule → 409 with
  `refusal.reason === 'cutover-state'` and the row unchanged; the two-guild
  case: a rule created under guild A is 404 under a session for guild B.
- [ ] **Step 2: Implement `automod.ts`**, following `write.ts`'s structure
  and its `dashboardAuditBase` (copy that helper into a shared
  `routes/audit-base.ts` and have `write.ts` import it — one function, two
  callers).
- [ ] **Step 3: Register** in `apps/daemon/src/http/wiring.ts` and export from
  `index.ts`.
- [ ] **Step 4: Run tests, gates, commit**

```bash
git commit -m "feat(http): automod rule routes (Slice 8 task 3)"
```

---

### Task 4: Case routes

**Files:**
- Create: `packages/http/src/routes/cases.ts`
- Create: `packages/http/src/routes/cases.test.ts`
- Modify: `packages/http/src/index.ts`, `apps/daemon/src/http/wiring.ts`

| Method | Path | Capability | Query/params | 200 body |
| --- | --- | --- | --- | --- |
| GET | `/api/mod/cases` | audit.read | `limit` (coerce int, 1..200, default 50) | `{ cases: ModCase[] }` |
| GET | `/api/mod/cases/:caseId` | audit.read | `caseId` uuid | `OpsCaseDetail`; 404 |
| GET | `/api/mod/members/:memberId/cases` | audit.read | `memberId` snowflake | `{ cases: ModCase[] }` |

All `guard.require`. Tests: each route; 403 without `audit.read`; 404 for a
case in the other guild; `limit=0` and `limit=abc` → 400.

```bash
git commit -m "feat(http): case and member-history routes (Slice 8 task 4)"
```

---

### Task 5: Dashboard — API types, navigation, the rules list, the cutover board, and the re-auth queue

**Files:**
- Create: `packages/dashboard/src/api/automod.ts`
- Create: `packages/dashboard/src/pages/automod-rules.tsx`
- Create: `packages/dashboard/src/pages/cutover.tsx`
- Create: `packages/dashboard/src/pages/automod-rules.test.tsx`
- Create: `packages/dashboard/src/pages/cutover.test.tsx`
- Modify: `packages/dashboard/src/app/routes.ts`
- Modify: `packages/dashboard/src/app/Shell.tsx`
- Modify: `packages/dashboard/src/app/Shell.test.tsx`
- Modify: `packages/dashboard/src/app/session.tsx`
- Modify: `packages/dashboard/src/app/session.test.tsx`

**Interfaces — Produces:**

```ts
// api/automod.ts — the response shapes, mirrored by hand (the dashboard may not import server packages)
export type RuleKind = 'keyword_filter' | 'regex' | 'invite' | 'link_domain' | 'caps' | 'emoji' | 'attachment_type' | 'mention_spam' | 'rapid_spam' | 'duplicate_message';
export type RuleMode = 'test' | 'observe' | 'enforce';
export type CutoverState = 'not_started' | 'observing' | 'ready' | 'cutover' | 'rolled_back';
export interface RuleSummary { /* every AdminRule field + matchCount + reviewedCount */ }
export interface RuleDetail extends RuleSummary { configObject: Record<string, unknown>; exemptions: …; terms: …; allowlist: …; inviteAllowlist: …; linkDomains: …; eligibility: { ok: true } | { ok: false; refusal: { reason: string; [k: string]: unknown } } }
export interface DryRunReport { /* mirror dry-run.ts's exported interface field by field */ }
export const daysObserved = (observeStartedAt: number | null, now: number): number | null;   // floor((now - start) / 86_400_000), null when not started
export const OBSERVE_FLOOR_DAYS = 14;
```

- [ ] **Step 1: The re-auth queue (carried from Slice 7).** In
  `session.tsx`, `requireReauth` chains: keep `const chain = useRef(Promise.resolve())`
  and make each call `chain.current = chain.current.then(() => new Promise(...prompt...))`,
  returning that promise, so two writes that both hit 401 prompt one after
  the other instead of the second overwriting the first's resolver. Test in
  `session.test.tsx`: a `Probe` with two buttons that each `write` to a
  different URL, both stubbed to 401 `reauth-required` then 200; click both
  inside one `act`; assert one dialog is open, confirm it, assert a second
  dialog opens, confirm it, and both writes were retried exactly once each.
- [ ] **Step 2: NAV rows.** Append to `NAV`: `{ path: '/automod', label: 'Automod', status: 'built' }`,
  `{ path: '/cases', label: 'Cases', status: 'built' }`,
  `{ path: '/cutover', label: 'Cutover', status: 'built' }`. Add the routes in
  `Shell.tsx`'s `<Switch>`: `/automod` → `AutomodRulesPage`, `/automod/:ruleId`
  → `AutomodRulePage` (Task 6 — create a placeholder component in this task
  that renders `<PageHeader title="Rule" purpose="…" />` and Task 6 replaces
  it), `/cases` → `CasesPage`, `/cases/:caseId` → `CasePage`,
  `/members/:memberId` → `MemberPage`, `/cutover` → `CutoverPage` (Task 7
  placeholders likewise). Extend `Shell.test.tsx`'s `it.each` with the three
  new rail entries.
- [ ] **Step 3: Rules list page** (`/automod`). `PageHeader` title "Automod",
  purpose "Every rule, what mode it is in, and how far through its observe
  window it is." `DataTable` columns: Rule (link to `/automod/:ruleId`), Kind,
  Enabled (Badge neutral "on"/"off"), Mode (Badge: `observe` → `hold`,
  `enforce` → `danger`, `test` → neutral), Cutover state, Observed (days, or
  "—"), Matches (numeric), Reviewed (numeric). Empty state: "No rules yet.
  Create one below." Beneath the table, a "New rule" form: `ruleId` (Input,
  hint "lowercase, digits and dashes"), name, kind (`<select>` — the native
  element is acceptable here, PR-49: the Radix Select is for Slice 9's
  per-row verdicts), config (a `<textarea>` seeded with `{}`; hint "JSON;
  validated against the kind's schema when you save"). Submit → `POST
  /api/automod/rules`; 400 `invalid-config` renders the issues under the
  textarea via `Field`'s `error`; 409 → error "A rule with that id already
  exists."; success → toast "Rule created" and reload.
- [ ] **Step 4: Cutover board** (`/cutover`). Purpose: "Where each rule stands
  on its way from observe to enforce." Table: Rule, Legacy rule ref (or
  "—"), Cutover state (Badge: `observing` → hold, `cutover` → danger,
  `rolled_back` → danger, else neutral), Observed (days; when `observing` and
  days < 14, append " of 14"), Matches, Reviewed, Sign-off (by/at or "—").
  A one-line note above the table: "Enforcement is offered only by the
  release gate (ADR 0042); this board reports, it does not move anything."
- [ ] **Step 5: Tests.** `automod-rules.test.tsx`: renders rows from
  `GET /api/automod/rules`; posts the create body exactly; renders 400 issues
  as the field error; empty state text. `cutover.test.tsx`: days observed
  computed from a fixed `now` (stub `Date.now` with `vi.setSystemTime`),
  "of 14" appears only for an observing rule under the floor, sign-off
  column shows by/at.
- [ ] **Step 6: Gates, commit**

```bash
git commit -m "feat(dashboard): automod rules list, cutover board, re-auth queue (Slice 8 task 5)"
```

---

### Task 6: Dashboard — the rule detail page

**Files:**
- Create: `packages/dashboard/src/pages/automod-rule.tsx` (replaces Task 5's placeholder)
- Create: `packages/dashboard/src/pages/automod-rule.test.tsx`

Route `/automod/:ruleId` (`useParams<{ ruleId: string }>()` from `wouter`).
Loads `GET /api/automod/rules/:ruleId` through `useResource`; 404 renders the
error state naming the rule. Sections, top to bottom, each an `<h2>`:

1. **Status** — a `<dl>`: kind, enabled, mode, cutover state, observed since
   (date) and days, matches, reviewed, sign-off. Beneath it the eligibility
   line: `ok: true` → "Enforcement is offerable."; otherwise one sentence per
   `refusal.reason`: `cutover-state` → "Not offerable: cutover state is
   {state}."; `low-volume-unsigned` → "Not offerable: {reviewed} of {required}
   matches reviewed and no sign-off."; `false-positive` → "Not offerable:
   {falsePositives} false-positive or unclear verdicts among {reviewed}
   reviewed."; `rate-too-high` → "Not offerable: false-positive rate {rate}
   exceeds {threshold}."
2. **Mode** — three radio buttons (test / observe / enforce; `enforce`
   disabled with a tooltip-free inline reason when `eligibility.ok` is false)
   and an Enabled checkbox, with one "Apply mode" button. Clicking opens
   `ConfirmDialog` whose `scope` states, in full sentences, exactly what the
   change does to the state machine, computed client-side from the current
   `cutoverState` and the request (PR-48): `not_started`/`rolled_back` +
   observe → "Starts this rule's observe window now. The two-week floor
   elapses on {date}."; `observing` + test → "Stops this rule evaluating
   for real while its observe clock keeps running; the window will elapse
   without evidence."; `cutover` + any non-enforce mode → "Rolls this rule
   back from enforcement and withdraws its sign-off; it must observe again
   before it can enforce."; enabled → false → "Disables the rule. Its cutover
   state and clock are unchanged."; anything else → "Changes mode from {a} to
   {b}; cutover state stays {state}." Confirm → `POST …/mode`; 409 → danger
   toast with the refusal sentence; success → toast "Mode applied", reload.
3. **Configuration** — a `<textarea>` seeded with
   `JSON.stringify(configObject, null, 2)`; "Save configuration" opens
   `ConfirmDialog` with scope "Replaces this rule's configuration. Any
   enforcement sign-off is withdrawn; the observe window and its clock are
   unchanged, so matches recorded before now were produced by the old
   configuration." Invalid JSON is caught client-side (`Field` error "Not
   valid JSON"); a 400 renders the server's issues. Success → toast
   "Configuration saved", reload.
4. **Exemptions** — a table of role/channel exemptions each with a "Remove"
   button (`DELETE …/exemptions/:type/:id`, no dialog: an exemption removal
   widens the rule, which is not destructive of evidence), and an add form
   (type select + snowflake input) → `POST …/exemptions`; `already-present`
   → neutral toast "Already exempt".
5. **Lists** (read-only in Slice 8; the CLI edits them): for
   `keyword_filter`, terms grouped by category and the allowlist; for
   `invite`, the code allowlist; for `link_domain`, the domains with their
   list type. Rendered only when non-empty; a one-line note names the CLI
   command that edits them (`automod term add`, `automod invite allow`,
   `automod domain add` — read `packages/core/src/ops/commands/automod.ts`
   for the real command names and use those).
6. **Dry run** — a "Run against fixtures" button → `POST …/dry-run`; result
   rendered as: usable/failure line; counts (fixtures, matched, agreed,
   disagreed, unlabelled, threw, abandoned); then a `DataTable` of fixtures
   with a `disagreed` outcome first (fixture id, label, matched, agreement).
   Empty corpus → "No fixtures yet. Matches recorded during the observe
   window become fixtures." The report is transient page state, not a
   resource.

Tests (`automod-rule.test.tsx`), each with a stubbed detail response: status
renders every field; the eligibility sentence for `cutover-state`; the mode
dialog's scope text for `observing` + `test`; applying mode posts exactly
`{ mode: 'test' }`; a 409 shows the refusal in the status region; config save
with invalid JSON never fetches; config save posts `{ config: {...} }` parsed
from the textarea; exemption remove calls `DELETE` with the right path;
dry-run posts and renders the counts.

```bash
git commit -m "feat(dashboard): automod rule detail — status, mode, config, exemptions, dry run (Slice 8 task 6)"
```

---

### Task 7: Dashboard — cases, case detail, member history

**Files:**
- Create: `packages/dashboard/src/pages/cases.tsx`, `case.tsx`, `member.tsx` (replace Task 5 placeholders)
- Create: `packages/dashboard/src/pages/cases.test.tsx`

- `/cases`: purpose "Open and recent moderation cases, newest first."; table:
  Case (link `/cases/:caseId`), Member (link `/members/:memberId`), Opened,
  Violations (numeric), Tier (numeric), Status (Badge: open → hold, closed →
  neutral). `GET /api/mod/cases?limit=50`. Empty: "No cases. Nothing has
  matched or been actioned yet."
- `/cases/:caseId`: a `<dl>` for the case, then the events table oldest
  first: When, Rule, Category, Snippet (in a `<code>`-free plain cell; ADR
  0043 forbids monospace for data), Action taken, Escalation, Refusal, Actor.
  The `trace` JSON is shown behind a `<details>` element per event (native,
  keyboard-operable, no dependency) labelled "Trace".
- `/members/:memberId`: purpose "Every case for this member, open first.";
  the same table as `/cases` without the Member column; `GET
  /api/mod/members/:memberId/cases`.
- **`degraded` gets its first producer (carried from Slice 7):** on `/cases`,
  when `useHealth()` is `ready` and `gateway.connected` is false, pass
  `degraded: 'Gateway disconnected: this list is served from the database
  and may be behind Discord.'` into the resource before rendering (compose
  the `Resource` in the page: `{ ...resource, degraded }` when ready).

Tests: rows render from the stub with the right links; the `degraded` line
appears only when the gateway is disconnected (two health stubs); case
detail renders events and the trace `<details>`; member history calls the
right URL.

```bash
git commit -m "feat(dashboard): cases, case detail, member history (Slice 8 task 7)"
```

---

## Self-review

- **Spec coverage.** Rules list/edit/exemptions/mode/dry-run (Tasks 3, 5, 6);
  cases and member history (Tasks 4, 7); the cutover board with
  `legacy_rule_ref`, `cutover_state`, days observed, match count (Task 5).
  Rule creation is included (`STATE.md`: "the creation surface arrives with
  the dashboard (Slice 8)").
- **Guild scope.** Every new repo function takes `scope` and has a two-guild
  test (Task 1); routes use `session.scope` only (Tasks 3–4 test the
  cross-guild 404).
- **Observe window.** No task modifies `setRuleMode`, `setRuleConfig`, the
  schema, or the gateway; the mode dialog states each transition's effect
  before it happens (Task 6).
- **Type consistency.** `AdminRule` (Task 1) → `OpsAutomodRuleSummary`
  (Task 2) → `RuleSummary` (Task 5, mirrored by hand — the dashboard cannot
  import it); `EnforcementEligibility`'s four refusal reasons are the four
  sentences in Task 6.
