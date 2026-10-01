# Automod Switch (Off / Watch / On) Implementation Plan (DRAFT)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace automod's staged rollout with one guild-wide Off / Watch / On switch, confirmed in the dashboard's automod tab, starting Off, with no trace of the testing stage left. Keep false-positive flagging and suppress for tuning.

**Architecture:** A new `guilds.automod_state` column is read with the existing safety state at the top of the automod subscriber. It replaces per-rule `mode` and the dead `automod_testing_mode`. A guild-scoped setter goes behind a new HTTP route that writes an audit row. The dashboard's `/automod` page gets a segmented control with `ConfirmDialog`. The work is additive first (Tasks 2–5): the switch works while the old machinery still compiles. The removals come after (Tasks 6–8), and the guards and docs are last (Tasks 9–10). Every task leaves `typecheck && lint && test` green.

**Tech Stack:** TypeScript strict, Node 22, better-sqlite3 + Drizzle + drizzle-kit 0.31.10, Fastify, Zod, React + Vite, Vitest.

**Spec:** `docs/superpowers/specs/2026-09-30-automod-switch-design.md` (approved by the owner 2026-09-30).

## Global Constraints

- Gates before every commit, from the repo root: `npm run typecheck && npm run lint && npm run test`. Never pipe a gate through `tail`.
- Shell rules: always give `rg`/`git` an explicit path (`rg -n foo packages apps`), never a bare `.`; no loops over shell variables.
- Guild scope is mandatory (CLAUDE.md rule 2): every new repo function takes `scope: GuildScope` first and filters with `scope.only(...)`.
- Model output and HTTP bodies pass Zod. The state enum is exactly `'off' | 'watch' | 'on'`.
- `guilds.automod_state` defaults to `'off'`. Every existing guild becomes `'off'` on migration.
- Guild `dry_run`, the kill switch, the breaker, and native AutoMod hit logging are **not** removed or changed.
- Matches recorded in Watch use `actionTaken: 'would_delete'` and `countsAsViolation: false` (ADR 0036). `would_delete` stays in the `mod_case_events` CHECK.
- Fresh-password asymmetry (ADR 0029, refining spec §5): a change toward *more* action (Off→Watch, Off→On, Watch→On) needs `guard.requireFresh`. A change toward less (→Off, On→Watch) needs only `guard.require`. Stopping must never be harder than starting.
- Capability for the switch: `config.write`, the same one the per-rule mode route uses today.
- drizzle-kit 0.31.10 emits an invalid rebuild when a column **and** its CHECK are added in one `db:generate` run (comment at `packages/storage/src/schema.ts:49-60`). Add the column in one generate run and the CHECK in a later one.
- Table rebuilds go through `runMigrations` (it guards R-5, a rebuild cascade-emptying child tables). Never call drizzle's `migrate()` directly.
- New migrations take the next numbers after `0053`. Expected: `0054` and `0055`. Run `ls drizzle` first; if another branch has landed, use the next free numbers and fix this plan's references.
- ADR number: `0121`.
- Build is a deploy on this box (`npm run build` rewrites the live `dist/`). Implementers run `typecheck`/`lint`/`test` only, never `build`, `start`, or `db:migrate` against `data/`.
- Copy is plain language (ADR 0059). User-facing text never says "observe window", "cutover", "sign-off", "legacy ref", "fixture", "graduate" or "enforce mode".

## Review Focus

1. **Off really stops everything we do.** With the state Off, a matching message must produce no `mod_case_events` row, no `mod_cases` row, no fixture, no Discord call, and no member fetch. Pinned in Task 3 (the subscriber matrix asserts `listRules` and `authorRoleIds` are never called).
2. **The switch is guild-scoped.** Setting guild A to On must leave guild B Off. That applies to the repo (Task 2), the route (Task 4), and the subscriber, which reads its own guild's state (Task 3).
3. **An unknown guild fails closed.** `readSafetyState` returns `undefined` for a guild with no row. The subscriber must treat that as Off and record nothing; today it records `delete_blocked_guild_unknown`. Pinned in Task 3.
4. **The upgrade keeps tuning data and rule content.** Upgrading a database at 0053 that holds an observing rule with word categories, terms, allowlist, exemptions, a recorded match and a false-positive flag must keep all of them except the fixtures. Pinned in Task 8 (R-5 cascade).
5. **Re-sending the current state is harmless.** `PUT` with the current state returns 200, writes no audit row, and needs no fresh password. Pinned in Task 4.

---

## File map

| Area | Files | Responsibility |
|---|---|---|
| Decision | `docs/decisions/0121-automod-switch-replaces-staged-rollout.md` (new) | Records the owner decision and what it supersedes |
| Storage | `packages/storage/src/schema.ts`, `drizzle/0054_*.sql`, `drizzle/0055_*.sql`, `drizzle/meta/*` | Column, CHECK, drops |
| Storage | `packages/storage/src/repos/guilds.ts` | `setAutomodState`, `readSafetyState().automodState` |
| Storage (removals) | `repos/automod-rules.ts`, `repos/enforcement-gate.ts` (delete), `repos/automod-fixtures.ts` (delete), `repos/automod-admin.ts`, `repos/mod-cases.ts`, `index.ts`, `test-support.ts` | Remove the staged-rollout functions |
| Core | `packages/core/src/automod/subscriber.ts` | State-driven decision path |
| Core (removals) | `automod/dry-run.ts` (delete), `automod/predicates/types.ts`, `ops/commands/automod.ts`, `ops/commands/reads.ts`, `ops/ports.ts`, `ops/registry.ts`, `ops/test-fixtures.ts`, `index.ts` | Drop modes, fixtures, ready/signoff/dryrun, staged doctor findings |
| HTTP | `packages/http/src/routes/automod-state.ts` (new), `server.ts`, `routes/automod.ts`, `routes/ops-write.ts`, `errors/catalog.ts`, `test-support.ts` | State routes; mode→enabled; removed routes |
| Daemon | `apps/daemon/src/automod/wiring.ts`, `apps/daemon/src/ops/wiring.ts`, `apps/daemon/src/http/wiring.ts`, `apps/daemon/src/runtime/daemon.ts` | Ports; drop fixture capture |
| Dashboard | `packages/dashboard/src/pages/automod-switch.tsx` (new), `pages/automod-rules.tsx`, `pages/automod-rule.tsx`, `pages/review.tsx`, `pages/overview-pulse.tsx`, `pages/docs.tsx`, `pages/cutover.tsx` (delete), `app/routes.ts`, `app/Shell.tsx`, `app/cli-parity.ts`, `api/automod.ts` | Switch card; removals |
| MCP | `packages/mcp/src/tools/health.ts` | `automodState` field |
| Guard | `packages/dashboard/src/app/no-staged-rollout.test.ts` (new) | Fails if testing-stage wording returns |
| Docs | `REVIEW.md`, `docs/08_ROADMAP.md`, `docs/17_OPERATOR_ACCESS.md`, `docs/SMOKE_TESTS.md`, `docs/reports/release2-gate-signoff.md`, `docs/STATE.md`, `PRIVACY.md` | Bring docs in line |

---

### Task 1: ADR 0121

**Files:**
- Create: `docs/decisions/0121-automod-switch-replaces-staged-rollout.md`

- [ ] **Step 1: Write the ADR.** Use this content, matching the house ADR format (look at `docs/decisions/0120-tavily-search-and-search-key-limits.md` for headings):

```markdown
# 0121 — One automod switch (Off / Watch / On) replaces the staged rollout

Status: Accepted (owner, 2026-09-30)
Supersedes: ADR 0042; ADR 0041 §§ on fixtures and the dry-run evaluator; ADR 0051's S11-D6 (CLI-only enforcement); REVIEW.md §A4 per-rule cutover tracking and §E's automod done-when clause.

## Context
Release 2 shipped automod behind a per-rule process: test/observe/enforce
modes, a five-state cutover machine, a 14-day observe floor, a tiered
false-positive gate, ready and owner sign-off, a legacy-rule reference and
attestation, and a corpus of saved member messages (fixtures) for dry-run
replay. The club ran 17 days of observation and the owner reviewed every
match. The owner wants one lever instead.

## Decision
1. `guilds.automod_state` ∈ {off, watch, on}, default off. Off: rules are not
   evaluated, nothing is recorded. Watch: matches recorded as `would_delete`,
   no Discord action. On: delete and escalate, still behind the kill switch,
   breaker and guild dry run.
2. Per-rule `mode`, `cutover_state`, the observe clock, sign-off, legacy ref,
   the false-positive gate thresholds, `automod_testing_mode`, fixtures and
   dry-run replay are removed — code, routes, CLI commands, `doctor`
   findings, dashboard UI and columns/tables.
3. Kept for tuning: match flags (`mod_match_reviews`) and suppress.
4. The switch is set from the dashboard's automod tab with a confirmation;
   moving toward more action needs a fresh password, toward less does not
   (ADR 0029's asymmetry). Audited as `automod.state_set`.
5. REVIEW §A4's no-overlapping-enforcement rule survives as a human check:
   the On confirmation tells the owner to turn off the matching Carl-bot /
   Dyno automod first.

## Consequences
- Dropping fixtures deletes stored copies of member messages (irreversible;
  owner accepted). Retention shrinks.
- Release 2's gate is amended: "automod reaches On via the switch, with an
  audit row", replacing the per-rule observe-floor and cutover rows.
- The unmerged Slice 11 branch (`worktree-slice-11-cutover`) is abandoned.
- AI remains outside the enforcement path (ADR 0002): nothing here involves a
  model.
```

- [ ] **Step 2: Commit.**

```bash
git add docs/decisions/0121-automod-switch-replaces-staged-rollout.md
git commit -m "docs: ADR 0121 — one automod switch replaces the staged rollout"
```

---

### Task 2: Storage, the state column and its guild-scoped setter (additive)

**Files:**
- Modify: `packages/storage/src/schema.ts` (`guilds` table, around lines 36–80)
- Create (generated): `drizzle/0054_<name>.sql`, `drizzle/meta/0054_snapshot.json`, `drizzle/meta/_journal.json` entry
- Modify: `packages/storage/src/repos/guilds.ts` (`SafetyState`, `readSafetyState`, new `setAutomodState`, new `AutomodState` type)
- Modify: `packages/storage/src/index.ts` (export the new names)
- Test: `packages/storage/src/repos/guilds.test.ts` (add a describe block; create the file if it does not exist, following `automod-rules.test.ts`'s setup through `test-support.ts`)

**Interfaces:**
- Produces: `export type AutomodState = 'off' | 'watch' | 'on';`, `export const AUTOMOD_STATES: readonly AutomodState[] = ['off', 'watch', 'on'];`, `setAutomodState(scope: GuildScope, state: AutomodState, now: number): void`, and `SafetyState.automodState: AutomodState`.

- [ ] **Step 1: Write the failing tests** in `guilds.test.ts`:

```ts
describe('automod state', () => {
  it('defaults to off for a newly seen guild', () => {
    const { scopeA } = setupTwoGuilds(); // use the existing two-guild helper in test-support.ts; if none, insert two guild rows the way automod-rules.test.ts does
    expect(readSafetyState(scopeA)?.automodState).toBe('off');
  });

  it('sets one guild without touching another', () => {
    const { scopeA, scopeB } = setupTwoGuilds();
    setAutomodState(scopeA, 'on', 1_000);
    expect(readSafetyState(scopeA)?.automodState).toBe('on');
    expect(readSafetyState(scopeB)?.automodState).toBe('off');
  });

  it('round-trips watch', () => {
    const { scopeA } = setupTwoGuilds();
    setAutomodState(scopeA, 'watch', 1_000);
    expect(readSafetyState(scopeA)?.automodState).toBe('watch');
  });
});
```

- [ ] **Step 2: Run, and see it fail.** Run: `npx vitest run packages/storage/src/repos/guilds.test.ts`. Expected: FAIL (`setAutomodState` is not exported, or `automodState` is undefined).

- [ ] **Step 3: Add the column, unconstrained.** In `schema.ts`'s `guilds` columns, after `automodTestingMode` (which stays until Task 8):

```ts
    // ADR 0121: the guild-wide automod switch. Off by default; its CHECK
    // lands in a separate db:generate run (see automodTestingMode above).
    automodState: text('automod_state').notNull().default('off'),
```

Run `npm run db:generate`. Open the new `drizzle/0054_*.sql` and confirm it is a single `ALTER TABLE \`guilds\` ADD \`automod_state\` text DEFAULT 'off' NOT NULL;` with no table rebuild. If drizzle-kit produced a rebuild, stop and report.

- [ ] **Step 4: Repo.** In `guilds.ts`, add `automodState: string` to the row interface (mirroring the others), and add:

```ts
/** ADR 0121's three positions. Validated at the HTTP boundary by Zod. */
export type AutomodState = 'off' | 'watch' | 'on';
export const AUTOMOD_STATES: readonly AutomodState[] = ['off', 'watch', 'on'];

const toAutomodState = (raw: string): AutomodState =>
  // Fail closed: anything unrecognised reads as off. The CHECK in 0055 makes
  // this unreachable; until then it is the guard.
  raw === 'watch' || raw === 'on' ? raw : 'off';

/** Sets the guild's automod switch. Guild-scoped by signature (rule 2). */
export const setAutomodState = (scope: GuildScope, state: AutomodState, now: number): void =>
  write(scope, ({ db }) => {
    db.update(guilds).set({ automodState: state, updatedAt: now }).where(scope.only(guilds)).run();
  });
```

Use the same `write`/`scope.only` form `setKillswitch` (line 90) uses. If `scope.only(guilds)` needs a second argument there, copy that exact form. Add `automodState: AutomodState;` to `SafetyState` and `automodState: toAutomodState(row.automodState),` to `readSafetyState`. Export `setAutomodState`, `AutomodState` and `AUTOMOD_STATES` from `packages/storage/src/index.ts`, following how `setKillswitch` is exported.

- [ ] **Step 5: Run, and see it pass.** Run: `npx vitest run packages/storage/src/repos/guilds.test.ts`. Expected: PASS.

- [ ] **Step 6: Gates, then commit.**

```bash
npm run typecheck && npm run lint && npm run test
git add packages/storage drizzle
git commit -m "storage: guilds.automod_state and a guild-scoped setter (ADR 0121)"
```

---

### Task 3: Core, the subscriber reads the switch

**Files:**
- Modify: `packages/core/src/automod/subscriber.ts` (`AutomodSafetyState` around line 95, `handle()` lines 244–470)
- Modify: `apps/daemon/src/automod/wiring.ts` (where `readSafetyState` is wired, around line 383)
- Test: `packages/core/src/automod/subscriber.test.ts`

**Interfaces:**
- Consumes: `SafetyState.automodState` from Task 2 (the daemon passes it through).
- Produces: `AutomodSafetyState` becomes `ModerationSafetyState & { readonly automodState: 'off' | 'watch' | 'on' }`. `core` re-declares the union, because `core` may not import storage (ADR 0014). `automodTestingMode` is removed from this type.

- [ ] **Step 1: Write the failing tests.** Add a `describe('the automod switch (ADR 0121)')` block to `subscriber.test.ts`, using the file's existing deps factory (find the helper that builds `AutomodSubscriberDeps` with spies; reuse it, overriding `readSafetyState`). Write tests for:
  - `off`: `listRules`, `authorRoleIds`, `recordCaseEvent`, `openOrResolveCase`, `deleteMessage` and `captureFixture` are all **not called**.
  - `readSafetyState` returns `undefined` (unknown guild): nothing is recorded or deleted, same as off.
  - `watch`, on a matching message: `recordCaseEvent` is called once with `actionTaken: 'would_delete'`; `openOrResolveCase` gets `{ countsAsViolation: false }`; `deleteMessage` is not called; `captureFixture` is not called.
  - `on` with killswitch / breaker / dryRun each true: records `delete_blocked_killswitch` / `_breaker` / `_dry_run` and makes no delete. Parametrise with `it.each`.
  - `on`, all clear: `deleteMessage` is called once.
  - `watch` and `on` ignore `rule.mode` entirely: a rule with `mode: 'enforce'` under `watch` still records `would_delete`, and a rule with `mode: 'test'` under `on` still deletes.

```ts
const state = (over: Partial<AutomodSafetyState>): AutomodSafetyState => ({
  killswitch: false, dryRun: false, breakerOpen: false, breakerReason: null,
  roleRatePerMin: 20, reconcileBudget: 25, breakerThreshold: 5,
  automodState: 'on', ...over,
});

it('off evaluates nothing and records nothing', async () => {
  const deps = makeDeps({ readSafetyState: () => state({ automodState: 'off' }) });
  await createAutomodSubscriber(deps).handle(matchingMessageEvent());
  expect(deps.listRules).not.toHaveBeenCalled();
  expect(deps.authorRoleIds).not.toHaveBeenCalled();
  expect(deps.recordCaseEvent).not.toHaveBeenCalled();
  expect(deps.deleteMessage).not.toHaveBeenCalled();
});
```

Adapt `makeDeps` and `matchingMessageEvent` to the helpers the file already has, and match `ModerationSafetyState`'s real field list. Copy it from its declaration, not from this example. Delete or update existing tests that assert `automodTestingMode` behaviour, or that assert per-rule `mode !== 'enforce'` recording: they are superseded by the tests above.

- [ ] **Step 2: Run, and see them fail.** Run: `npx vitest run packages/core/src/automod/subscriber.test.ts`. Expected: the new tests FAIL (`off` still calls `listRules`).

- [ ] **Step 3: Implement.** In `handle()`, after the `input === undefined` return and **before** `deps.listRules()`:

```ts
      // ADR 0121: one switch for the guild. Off — and an unknown guild,
      // which fails closed — means automod does nothing at all: no rule is
      // listed, no member fetched, nothing recorded.
      const state = deps.readSafetyState();
      if (state === undefined || state.automodState === 'off') return;
```

- Delete the per-rule `captureFixture` block (the `let fixtureId` … `if (rule.mode !== 'enforce') { try { … captureFixture …` lines) and the `fixtureId` field passed in `record`. If `recordCaseEvent`'s input type requires `fixtureId`, pass nothing; it is optional, so check its type.
- Replace the `if (rule.mode !== 'enforce') { record(... 'would_delete'); continue; }` block with:

```ts
        // Watch records what automod would have done and touches no one.
        // `would_delete`, never `deleted` (ADR 0036).
        if (state.automodState === 'watch') {
          record(
            deps.openOrResolveCase(authorId, { countsAsViolation: false }).caseId,
            'would_delete',
          );
          continue;
        }
```

- Delete the second `const state = deps.readSafetyState();` and the whole `automodTestingMode` block (lines ~418–435). In `blocked`, `state` is now never undefined, so drop the `delete_blocked_guild_unknown` arm:

```ts
        const blocked: AutomodActionTaken | undefined = state.killswitch
          ? 'delete_blocked_killswitch'
          : state.breakerOpen
            ? 'delete_blocked_breaker'
            : state.dryRun
              ? 'delete_blocked_dry_run'
              : undefined;
```

- Update the `AutomodSafetyState` doc comment and type. Leave `captureFixture` in `AutomodSubscriberDeps` for now, marked `/** @deprecated removed in Task 8 */`, so daemon wiring still compiles. Task 8 deletes it.
- In `apps/daemon/src/automod/wiring.ts`, `readSafetyState` already returns the storage `SafetyState`, which now carries `automodState`. Map it if the wiring builds the object field by field; otherwise nothing changes. `automodTestingMode` is still on the storage type until Task 8, and that is fine as an extra field.

- [ ] **Step 4: Run, and see them pass.** Run: `npx vitest run packages/core/src/automod/subscriber.test.ts`. Expected: PASS.

- [ ] **Step 5: Gates, then commit.**

```bash
npm run typecheck && npm run lint && npm run test
git add packages/core apps/daemon
git commit -m "automod: the guild switch decides off/watch/on; per-rule mode no longer read (ADR 0121)"
```

---

### Task 4: HTTP, the state routes

**Files:**
- Create: `packages/http/src/routes/automod-state.ts`
- Modify: `packages/http/src/server.ts` (register it beside `registerWriteRoutes`)
- Modify: `packages/core/src/ops/ports.ts` (`OpsSafetyState` gains `automodState`; `OpsPorts` gains `setAutomodState(state)` and `listEnabledAutomodRuleNames()`)
- Modify: `apps/daemon/src/ops/wiring.ts` (~line 113–130), `packages/http/src/test-support.ts` (~line 63–100), `packages/core/src/ops/test-fixtures.ts` (~line 26–30): implement the new port members
- Test: `packages/http/src/routes/automod-state.test.ts` (new; copy the setup from `write.test.ts`, which tests `/api/killswitch`)

**Interfaces:**
- Consumes: `setAutomodState(scope, state, now)` and `readSafetyState(scope).automodState` (Task 2).
- Produces:
  - `GET /api/automod/state` returns `200 { state: 'off'|'watch'|'on', dryRun: boolean, killswitch: boolean, enabledRules: { ruleId: string; name: string }[] }`.
  - `PUT /api/automod/state { state }` returns `200 { ok: true, state }`.
  - On the ports: `OpsPorts.setAutomodState(state: OpsAutomodState): void`, `OpsPorts.listEnabledAutomodRuleNames(): readonly { ruleId: string; name: string }[]`, and `export type OpsAutomodState = 'off' | 'watch' | 'on'` in `ports.ts`.

- [ ] **Step 1: Write the failing tests** (`automod-state.test.ts`), following the killswitch tests in `write.test.ts` for login, stale-session and capability helpers:
  - GET with a session returns `state: 'off'` on a fresh guild, with `enabledRules` listing the seeded enabled rules by name.
  - PUT `{ state: 'on' }` with a **stale** session gets the same status `write.test.ts` asserts for a stale killswitch-off (401 with re-auth). The state stays `off`.
  - PUT `{ state: 'on' }` with a fresh session returns 200; the state is `on`; exactly one audit row has `action: 'automod.state_set'`, `before: { state: 'off' }` and `after: { state: 'on' }`.
  - PUT `{ state: 'off' }` from `on` with a **stale** (non-fresh) but valid session returns 200. Stopping is never harder.
  - PUT `{ state: 'watch' }` from `on` with a stale session returns 200 (less action).
  - PUT `{ state: 'watch' }` from `off` with a stale session is refused (more action).
  - PUT with the current state returns 200 with no audit row, even from a stale session.
  - PUT `{ state: 'enforce' }` returns 400.
  - A session without `config.write` is refused with the status `requireCapability` uses.
  - Guild scope: a PUT from a guild-A session leaves guild B `off`. Use the two-guild support the other route tests use; if there is none, assert through `readSafetyState` on a second scope.

- [ ] **Step 2: Run, and see them fail.** Run: `npx vitest run packages/http/src/routes/automod-state.test.ts`. Expected: FAIL (404s).

- [ ] **Step 3: Ports.** In `ports.ts` add `readonly automodState: OpsAutomodState;` to `OpsSafetyState`, the type alias, and the two members on `OpsPorts` with doc comments. Implement them in daemon `ops/wiring.ts` and `http/test-support.ts`:

```ts
  setAutomodState: (state) => guildRepo.setAutomodState(scope, state, now()),
  listEnabledAutomodRuleNames: () =>
    automodAdmin.listRules(scope).filter((r) => r.enabled).map((r) => ({ ruleId: r.ruleId, name: r.name })),
```

Use whatever name the wiring file already imports for the automod-admin `listRules`. In `core/ops/test-fixtures.ts`, add `unstubbed('setAutomodState')` and `unstubbed('listEnabledAutomodRuleNames')`.

- [ ] **Step 4: Route.** `automod-state.ts`:

```ts
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { HttpDeps, RouteGuard } from '../server.js';
import { badRequest } from '../errors/reply.js';
import { dashboardAuditBase } from './audit-base.js';
import { requireCapability } from './capability.js';

const RANK = { off: 0, watch: 1, on: 2 } as const;
const bodySchema = z.object({ state: z.enum(['off', 'watch', 'on']) });

/**
 * The guild-wide automod switch (ADR 0121). Moving toward more action needs
 * a fresh password; moving toward less does not — ADR 0029's asymmetry, the
 * same one the kill switch follows: stopping is never harder than starting.
 */
export const registerAutomodStateRoutes = (
  app: FastifyInstance,
  guard: RouteGuard,
  deps: HttpDeps,
): void => {
  app.get('/api/automod/state', (request, reply) => {
    const session = guard.require(request, reply);
    if (session === undefined) return reply;
    const ports = deps.portsFor(session.scope);
    const safety = ports.safetyState();
    if (safety === undefined) return reply.status(404).send({ error: 'not-found' });
    return reply.status(200).send({
      state: safety.automodState,
      dryRun: safety.dryRun,
      killswitch: safety.killswitch,
      enabledRules: ports.listEnabledAutomodRuleNames(),
    });
  });

  app.put('/api/automod/state', (request, reply) => {
    const parsed = bodySchema.safeParse(request.body);
    if (!parsed.success) return badRequest(reply, parsed.error);
    const next = parsed.data.state;

    const lenient = guard.require(request, reply);
    if (lenient === undefined) return reply;
    const before = deps.portsFor(lenient.scope).safetyState();
    if (before === undefined) return reply.status(404).send({ error: 'not-found' });
    if (before.automodState === next) return reply.status(200).send({ ok: true, state: next });

    const session =
      RANK[next] > RANK[before.automodState] ? guard.requireFresh(request, reply) : lenient;
    if (session === undefined) return reply;
    if (!requireCapability(session, 'config.write', reply)) return reply;

    const ports = deps.portsFor(session.scope);
    ports.setAutomodState(next);
    ports.recordAudit({
      ...dashboardAuditBase(session, deps.now()),
      action: 'automod.state_set',
      subjectType: 'guild',
      subjectId: session.guildId,
      before: { state: before.automodState },
      after: { state: next },
    });
    return reply.status(200).send({ ok: true, state: next });
  });
};
```

Check that calling `guard.require` and then `guard.requireFresh` on one request does not send two replies. Read `RouteGuard` in `server.ts`. If `require` writes to `reply` on failure only, this is safe; if not, restructure so that only one guard call is made per path. Register the routes in `server.ts` next to `registerWriteRoutes(app, guard, deps)`.

Also confirm whether the same-state no-op should still check the capability. The test in Step 1 expects 200 without it, which leaks nothing a GET wouldn't. Keep it as written.

- [ ] **Step 5: Run, and see them pass**, then run the gates and commit.

```bash
npx vitest run packages/http/src/routes/automod-state.test.ts
npm run typecheck && npm run lint && npm run test
git add packages/http packages/core apps/daemon
git commit -m "http: GET/PUT /api/automod/state with ADR 0029 fresh-password asymmetry and audit"
```

---

### Task 5: Dashboard, the switch card on the automod tab

**Files:**
- Create: `packages/dashboard/src/pages/automod-switch.tsx`
- Modify: `packages/dashboard/src/pages/automod-rules.tsx` (render `<AutomodSwitch />` directly under `PageHeader`)
- Modify: `packages/dashboard/src/api/automod.ts` (add `AutomodState`, `AUTOMOD_STATE_LABEL`, `AUTOMOD_STATE_MEANING`, `AutomodStateView`)
- Test: `packages/dashboard/src/pages/automod-switch.test.tsx` (copy `stubFetch`/render helpers from `automod-rule.test.tsx`)

**Interfaces:**
- Consumes: `GET`/`PUT /api/automod/state` (Task 4).
- Produces: `export function AutomodSwitch(): JSX.Element`.

Copy (exact strings; tests assert them):

```ts
export type AutomodState = 'off' | 'watch' | 'on';
export const AUTOMOD_STATE_LABEL: Record<AutomodState, string> = { off: 'Off', watch: 'Watch', on: 'On' };
export const AUTOMOD_STATE_MEANING: Record<AutomodState, string> = {
  off: 'Automod is off. It does not check messages and records nothing.',
  watch: 'Automod records matches for you to review and flag. It deletes nothing and touches no one.',
  on: 'Automod deletes messages that match an enabled rule and escalates repeat offenders.',
};
export interface AutomodStateView {
  readonly state: AutomodState;
  readonly dryRun: boolean;
  readonly killswitch: boolean;
  readonly enabledRules: readonly { ruleId: string; name: string }[];
}
```

The confirmation text per target state:
- **Off:** title "Turn automod off?" and scope "Automod stops checking messages. Nothing new is recorded." Not `danger`.
- **Watch:** title "Switch automod to Watch?" and scope "Automod records matches for review and deletes nothing." Not `danger`.
- **On:** title "Turn automod on?" with `danger`. The scope is "These {n} enabled rules will delete matching messages and escalate repeat offenders:" followed by a `<ul>` of rule names, then the paragraph "Turn off the matching Carl-bot or Dyno automod first, so two bots don't act on the same message." When `dryRun` is true, add a further paragraph: "Dry run is on for this server, so matches will be logged, not acted on, until dry run is turned off on the Configuration page." When `n === 0`: "No rules are enabled, so nothing will happen until you enable one."

The card shows the dry-run sentence above whenever `state === 'on' && dryRun`, and "The kill switch is on: nothing is sent to Discord." whenever `killswitch`.

- [ ] **Step 1: Write the failing tests:**
  - It renders three buttons (Off, Watch, On) in a group labelled "Automod", with the current one `aria-pressed="true"` and its meaning text shown.
  - Clicking On opens a dialog titled "Turn automod on?" that lists both enabled rule names and the Carl-bot sentence; Cancel closes it and no PUT is sent (assert the fetch stub saw no PUT).
  - Confirming sends `PUT /api/automod/state` with `{ state: 'on' }` and re-reads.
  - With `dryRun: true`, the On dialog shows the dry-run paragraph.
  - Clicking the current state does nothing (no dialog).

- [ ] **Step 2: Run, and see them fail.** Run: `npx vitest run packages/dashboard/src/pages/automod-switch.test.tsx`. Expected: FAIL (module not found).

- [ ] **Step 3: Implement** `automod-switch.tsx`, following `safety.tsx`'s `ConfirmDialog` and `session.write` usage:

```tsx
import { useCallback, useState } from 'react';
import {
  AUTOMOD_STATE_LABEL,
  AUTOMOD_STATE_MEANING,
  type AutomodState,
  type AutomodStateView,
} from '../api/automod.js';
import { useSession } from '../app/session.js';
import { useResource } from '../hooks/useResource.js';
import { Card } from '../ui/Card.js';
import { ConfirmDialog } from '../ui/ConfirmDialog.js';
import { DataState } from '../ui/DataState.js';
import { useToast } from '../ui/Toast.js';

const STATES: readonly AutomodState[] = ['off', 'watch', 'on'];

/** ADR 0121: the one guild-wide automod switch, at the top of /automod. */
export function AutomodSwitch() {
  const session = useSession();
  const toast = useToast();
  const load = useCallback(() => session.read<AutomodStateView>('/api/automod/state'), [session]);
  const view = useResource('the automod switch', load);
  const [target, setTarget] = useState<AutomodState | undefined>(undefined);
  const [busy, setBusy] = useState(false);

  const apply = async (state: AutomodState) => {
    setBusy(true);
    try {
      const result = await session.write<{ ok: boolean }>('/api/automod/state', { state }, 'PUT');
      if (result !== undefined) {
        toast({ tone: 'ok', title: `Automod is ${AUTOMOD_STATE_LABEL[state]}` });
        view.reload();
      }
    } finally {
      setBusy(false);
      setTarget(undefined);
    }
  };

  return (
    <DataState resource={view.resource}>
      {(v) => (
        <Card title="Automod">
          <div role="group" aria-label="Automod" className="inline-flex rounded-md border border-line">
            {STATES.map((s) => (
              <button
                key={s}
                type="button"
                aria-pressed={v.state === s}
                disabled={busy}
                onClick={() => (s === v.state ? undefined : setTarget(s))}
                className={/* copy the selected/unselected classes from an existing segmented control or Button variant */ ''}
              >
                {AUTOMOD_STATE_LABEL[s]}
              </button>
            ))}
          </div>
          <p className="mt-2 text-sm">{AUTOMOD_STATE_MEANING[v.state]}</p>
          {v.state === 'on' && v.dryRun && <p className="mt-1 text-sm text-ink-muted">{DRY_RUN_NOTE}</p>}
          {v.killswitch && (
            <p className="mt-1 text-sm text-ink-muted">The kill switch is on: nothing is sent to Discord.</p>
          )}
          {target !== undefined && (
            <ConfirmDialog
              open
              title={TITLE[target]}
              scope={<Scope target={target} view={v} />}
              confirmLabel={`Turn automod ${AUTOMOD_STATE_LABEL[target]}`}
              danger={target === 'on'}
              busy={busy}
              onConfirm={() => void apply(target)}
              onCancel={() => setTarget(undefined)}
            />
          )}
        </Card>
      )}
    </DataState>
  );
}
```

Define `TITLE`, `DRY_RUN_NOTE` and `Scope` in the same file, using the exact copy above. Before writing a segmented control from scratch, look in `packages/dashboard/src/ui/` for one (`rg -n "aria-pressed" packages/dashboard/src/ui`) and reuse it if it exists. Check `DataState`'s props; it may require `isEmpty`/`empty`. Render `<AutomodSwitch />` in `automod-rules.tsx` right after `<PageHeader … />`, and change that header's `purpose` to "The automod switch, and every rule it applies to."

- [ ] **Step 4: Run, and see them pass**, then run the gates and commit.

```bash
npx vitest run packages/dashboard/src/pages/automod-switch.test.tsx packages/dashboard/src/pages/automod-rules.test.tsx
npm run typecheck && npm run lint && npm run test
git add packages/dashboard
git commit -m "dashboard: Off / Watch / On automod switch with confirmation on the automod tab"
```

---

### Task 6: Remove the staged rollout from the dashboard and HTTP

**Files:**
- Delete: `packages/dashboard/src/pages/cutover.tsx`, `pages/cutover.test.tsx`
- Modify: `app/routes.ts` and `app/Shell.tsx` (remove the "Turn on moderation" / `/cutover` entry and route), `Shell.test.tsx` if it lists nav items
- Modify: `pages/automod-rules.tsx`:
  - drop the Mode, Stage and Observed columns, and the Observing/Enforcing cards;
  - keep the Rules count card, the Enabled column, and the Reviewed / false-positive columns. Reword `REVIEWED_HELP` to: "Matches you have flagged as correct or false positive. Flags help you tune a rule."
- Modify: `pages/automod-rule.tsx`:
  - remove `refusalReason`, `eligibilitySentence`, `signoffText`, `observedText`, the Stage / Observed since / Sign-off `dl`, the mode radio fieldset, `ENFORCE_CUTOVER_NOTE`, the mode confirm, the mark-ready and sign-off controls, and the Dry run card;
  - remove the config-save sentence about withdrawing a sign-off;
  - keep the config editor, exemptions, invite and domain lists;
  - replace the radios with a single **Enabled** checkbox that POSTs to `/api/automod/rules/:ruleId/enabled`.
- Modify: `pages/review.tsx`, `pages/overview-pulse.tsx`, `pages/docs.tsx`: reword every observe / cutover / gate sentence around tuning. Keep the flags, native hits and suppress.
- Modify: `api/automod.ts`: remove `RuleMode`, `CutoverState`, `OBSERVE_FLOOR_DAYS`, `daysObserved`, `CUTOVER_STAGE_*`, `RULE_MODE_*`, `OBSERVED_HELP`, `DryRunReport`, and the eligibility/refusal types, plus their fields on `RuleSummary`/`RuleDetail`.
- Modify: `packages/http/src/routes/automod.ts`:
  - replace `POST /rules/:ruleId/mode` with `POST /rules/:ruleId/enabled { enabled: boolean }`. Use `guard.require` for `enabled: false` and `guard.requireFresh` for `true` (ADR 0029). The audit action is `automod_rule.enabled_set`, with before/after `{ enabled }`.
  - delete `POST /rules/:ruleId/dry-run`;
  - drop the staged fields (mode, cutoverState, observeStartedAt, signoff, eligibility) from the list and detail responses;
  - remove the sign-off withdrawal from config PUT.
- Modify: `packages/http/src/routes/ops-write.ts`: delete `POST /rules/:id/ready` and `POST /rules/:id/signoff`.
- Modify: `packages/http/src/errors/catalog.ts`: delete `not-observing`, `not-eligible` and any other slug that is no longer sent (the catalog test lists stale slugs only one way, so grep for each slug before deleting it).
- Modify: `packages/core/src/ops/ports.ts`, daemon `ops/wiring.ts`, `http/test-support.ts`: replace `setAutomodRuleMode` with `setAutomodRuleEnabled(ruleId: string, enabled: boolean): 'ok' | 'no-such-rule'`, implemented with a plain guild-scoped `UPDATE mod_rules SET enabled` (add `setRuleEnabled(scope, ruleId, enabled, now): boolean` to `automod-rules.ts`). Delete `setRuleMode`'s callers here; the function itself goes in Task 8.
- Tests: update `automod-rules.test.tsx`, `automod-rule.test.tsx`, `review.test.tsx`, `overview-pulse.test.tsx`, `http/routes/automod.test.ts` and `ops-write.test.ts`, deleting the assertions on removed UI and routes.

- [ ] **Step 1: Write the failing tests first** for the replacement behaviour:
  - `automod.test.ts`: `POST /rules/:id/enabled { enabled: false }` with a stale session returns 200 and sets the rule disabled, with one `automod_rule.enabled_set` audit row. `{ enabled: true }` with a stale session is refused. A rule in another guild returns 404. `POST /rules/:id/mode` now returns 404.
  - `automod-rule.test.tsx`: the page has an "Enabled" checkbox and **no** element whose label is Test / Observe / Enforce; the text "Dry run" does not appear.
  - `automod-rules.test.tsx`: no column header reads Mode, Stage or Observed.

  Run them and see them fail.
- [ ] **Step 2: Make the removals listed above.** After each file, run that file's tests.
- [ ] **Step 3: CLI-web parity.** In `packages/dashboard/src/app/cli-parity.ts`, delete the `automod dryrun`, `automod ready` and `automod signoff` entries **only if** Task 7 is in the same commit. Otherwise leave them for Task 7: the parity test fails on stale entries in both directions, so the CLI command and its parity row must be removed together.
- [ ] **Step 4: Gates, then commit.**

```bash
npm run typecheck && npm run lint && npm run test
git add packages apps
git commit -m "remove the staged rollout from the dashboard and HTTP: cutover page, modes, stage, dry run, ready, signoff (ADR 0121)"
```

---

### Task 7: Remove it from the CLI, doctor and MCP; add the switch to doctor and health

**Files:**
- Modify: `packages/core/src/ops/commands/automod.ts`: delete `automod dryrun` (~line 199), `automod ready` (~648) and `automod signoff` (~707), plus their helpers. Keep `review`, `verdict`, `invite-allow`, `invite-deny`, `domain-add` and `domain-rm`.
- Modify: `packages/core/src/ops/registry.ts` (unregister them), `packages/dashboard/src/app/cli-parity.ts` (delete their rows)
- Modify: `packages/core/src/ops/commands/reads.ts` (doctor, ~lines 105–280 and 405–475):
  - delete `badCutoverState`, `observePastWindow`, their report fields `automodEnforceModeBadCutoverState` / `automodObservePastWindowWithBacklog`, and the "drop the rule back to observe mode" sentence;
  - add a line `automod           off|watch|on` (align with the neighbouring lines' padding);
  - add a warning when `automodState === 'on' && dryRun`: `automod is On but dry run is on: matches are logged, not acted on`;
  - re-base the Manage Messages check on `automodState === 'on'` plus "an enabled keyword rule exists", replacing `listEnforceModeKeywordFilterRules`.
- Modify: `packages/core/src/ops/ports.ts`: delete the ports for the removed doctor findings, the fixtures, dry-run, ready and signoff; add `hasEnabledKeywordRule(): boolean`. Implement it in daemon `ops/wiring.ts` and `http/test-support.ts`, and stub it in `test-fixtures.ts`.
- Modify: `packages/mcp/src/tools/health.ts`: add `automodState` to the output, and the text `automod off|watch|on` beside the existing dry-run line.
- Tests: `automod.test.ts` (core ops), `reads.test.ts`, `registry`/dispatch tests, `cli-parity.test.ts`, `mcp/tools/health.test.ts`, `apps/daemon/src/ops/wiring.test.ts`

- [ ] **Step 1: Failing tests first.**
  - `reads.test.ts`: doctor prints `automod           off` on a fresh guild. With state `on` and dry run on, it prints the warning. With state `on`, an enabled keyword rule, and Manage Messages missing, the existing Manage Messages finding fires. With state `watch`, it does not.
  - `health.test.ts`: the tool output includes `automodState: 'off'`.
  - The dispatcher answers an unknown command (`automod ready`) the way it answers any unknown command. Copy the existing unknown-command test's expectation.

  Run them and see them fail.
- [ ] **Step 2: Make the removals and additions above.**
- [ ] **Step 3: Gates, then commit.**

```bash
npm run typecheck && npm run lint && npm run test
git add packages apps
git commit -m "remove dryrun/ready/signoff and the staged doctor findings; doctor and MCP health report the switch (ADR 0121)"
```

---

### Task 8: Remove it from storage and core types; migration 0055

**Files:**
- Modify: `packages/storage/src/schema.ts`:
  - `guilds`: delete `automodTestingMode` and its CHECK; add `check('guilds_automod_state', sql\`${t.automodState} IN ('off','watch','on')\`)`.
  - `mod_rules`: delete `mode`, `observeStartedAt`, `legacyRuleRef`, `enforceSignedOffBy`, `enforceSignedOffAt`, `cutoverState`, `maxFalsePositiveRate` and `minReviewedMatches`, and their CHECKs (`mod_rules_mode`, `mod_rules_cutover_state`, `mod_rules_max_false_positive_rate_range`, the `min_reviewed_matches` check). Delete the ADR 0042 comments.
  - Delete the `automodFixtures` and `automodFixtureAttachments` tables.
  - `mod_case_events`: delete `fixtureId`.
- Create (generated): `drizzle/0055_<name>.sql` plus its snapshot and journal entry
- Delete: `packages/storage/src/repos/enforcement-gate.ts`, `repos/automod-fixtures.ts` and their tests
- Modify: `packages/storage/src/repos/automod-rules.ts`:
  - delete `setRuleMode`, `setRuleReady`, `setEnforceSignOff`, `setRuleLegacyRef` (if present) and `listEnforceModeKeywordFilterRules`;
  - `createRule` takes no mode;
  - keep `setRuleEnabled` (Task 6).
- Modify: `repos/automod-admin.ts`: keep `countReviewedByRule`, `countVerdictsByRule` and `listUnreviewedNativeHits`, because the flags stay. Remove the staged fields they return, if any.
- Modify: `repos/mod-cases.ts`: drop the `automodFixtures` join.
- Modify: `packages/storage/src/index.ts`, `packages/storage/src/test-support.ts`: remove the deleted exports and the "state setRuleMode will accept" helper.
- Modify: `packages/core/src/automod/predicates/types.ts`: remove `mode` and `cutoverState` from `AutomodRule`, and delete `FixtureRecord`.
- Modify: `packages/core/src/automod/predicates/attachment-type.ts`: remove its fixture references.
- Delete: `packages/core/src/automod/dry-run.ts` and its test.
- Modify: `packages/core/src/automod/subscriber.ts`: delete the deprecated `captureFixture` dep.
- Modify: `apps/daemon/src/automod/wiring.ts` (~line 329): delete the `captureFixture` wiring.
- Modify: `apps/daemon/src/runtime/daemon.ts` (~line 808): the seeded rule is created without a mode.
- Modify: `packages/core/src/index.ts`: remove the deleted re-exports.
- Test: `packages/storage/src/db.test.ts`: a new describe block for the upgrade.

- [ ] **Step 1: Write the upgrade test, and see it fail.** In `db.test.ts`, add `describe('migration 0055 removes the staged rollout without losing rules, word lists or flags')`, reusing the file's `migrationsFolderUpTo` helper (move it to the top level of the file if it is scoped inside the 0012 describe):

```ts
it('keeps rules, their children, case events and flags; drops fixtures; guild is off', () => {
  const raw = new Database(':memory:');
  raw.pragma('foreign_keys = ON');
  const db = drizzle(raw, { schema });
  runMigrations(raw, db, migrationsFolderUpTo(54)); // through 0054 (Task 2)

  // Seed with raw SQL against the 0054 shape: a guild; an observing rule with
  // mode 'observe', cutover_state 'observing', observe_started_at set; a word
  // category, term, allowlist phrase and role exemption on it (copy the
  // INSERTs from schema-invariants.test.ts ~line 395–420); a mod_case and a
  // mod_case_events row with action_taken 'would_delete' and fixture_id set;
  // an automod_fixtures row; a mod_match_reviews row with verdict
  // 'false_positive' on that event.

  runMigrations(raw, db, MIGRATIONS_FOLDER);

  // Assert: the rule row exists with its name, kind, config, enabled; the
  // category, term, allowlist and exemption rows exist; the case event exists
  // with action_taken 'would_delete'; the review exists with its verdict;
  // `SELECT name FROM sqlite_master WHERE name IN ('automod_fixtures',
  // 'automod_fixture_attachments')` returns no rows; PRAGMA table_info on
  // mod_rules has no mode/cutover_state/observe_started_at/legacy_rule_ref/
  // enforce_signed_off_by/enforce_signed_off_at/max_false_positive_rate/
  // min_reviewed_matches; table_info on guilds has no automod_testing_mode;
  // the guild's automod_state is 'off'; inserting automod_state 'enforce'
  // throws a CHECK failure; PRAGMA foreign_key_check returns [].
});
```

Write every INSERT and `expect` out in full; the comments above are the checklist. Run it. Expected: FAIL (there is no 0055 yet, so the columns still exist).

- [ ] **Step 2: Schema edits, then generate.** Make the `schema.ts` changes, then run `npm run db:generate`. Read the generated `0055_*.sql` end to end and check that:
  - it starts with `PRAGMA foreign_keys=OFF` and ends with `PRAGMA foreign_keys=ON`;
  - each rebuilt table (`guilds`, `mod_rules`, `mod_case_events`) has an `INSERT INTO __new_x (...) SELECT ... FROM x` whose column list names **only** columns that exist in the old table;
  - the fixture tables get `DROP TABLE`;
  - the `guilds_automod_state` CHECK is present.

  If drizzle-kit split or mangled any of this, fix the SQL by hand: keep the journal entry and edit only the `.sql`, and record that in the commit message.
- [ ] **Step 3: Run the upgrade test, and see it pass.** Run: `npx vitest run packages/storage/src/db.test.ts packages/storage/src/schema-invariants.test.ts`. Expected: PASS. The existing invariants tests must also still pass. Old migration tests that seed `mode`/`cutover_state` against *their own* earlier migration point are still valid, because they run only up to their own index.
- [ ] **Step 4: Remove the code listed above.** Let the typecheck errors guide you to every remaining reference. Delete tests of deleted functions.
- [ ] **Step 5: Gates, then commit.**

```bash
npm run typecheck && npm run lint && npm run test
git add packages apps drizzle
git commit -m "storage: drop modes, cutover columns, testing mode and fixtures; CHECK automod_state (migration 0055, ADR 0121)"
```

---

### Task 9: The no-remnants guard

**Files:**
- Create: `packages/dashboard/src/app/no-staged-rollout.test.ts`

- [ ] **Step 1: Write the guard.** It reads every non-test `.ts`/`.tsx` file under these paths:
  - `packages/dashboard/src`
  - `packages/core/src/ops`
  - `packages/core/src/automod`
  - `packages/http/src/routes`
  - `packages/http/src/errors`
  - `packages/mcp/src/tools`
  - `apps/daemon/src/ops`
  - `apps/daemon/src/runtime`

  It strips `//` line comments and `/* … */` block comments, then fails on any match of:

```ts
const FORBIDDEN = /observe window|observe floor|observing|cutover|cut over|sign-off|signoff|signed off|legacy ref|legacy-ref|legacyRuleRef|fixture|enforce mode|enforceSignedOff|cutoverState|observeStartedAt|automodTestingMode|OBSERVE_FLOOR/i;
```

  Use `fs.readdirSync(dir, { recursive: true })` (Node 22) and resolve paths from `import.meta.dirname` up to the repo root. The failure message lists `file:line: text` for every hit. Exclude `*.test.ts(x)` files, the test-support modules (`test-fixtures.ts`, `test-support.ts`, whose names and contents are about test fixtures, not automod's), and the guard itself.

  If a legitimate non-staged use of a word turns up (for example the archive's own "fixture" in `apps/daemon/src/assistant/__fixtures__`, which is outside the scanned paths), narrow the regex or path list and say why in a comment. Do not add an allowlist of files.

- [ ] **Step 2: Watch it fail.** Temporarily add the line `const x = 'cutover';` to `packages/dashboard/src/pages/automod-switch.tsx`, run `npx vitest run packages/dashboard/src/app/no-staged-rollout.test.ts`, confirm it FAILS naming that file and line, then revert the line. Run it again: PASS. If it fails on real leftovers, remove them (they are Task 6–8 misses).
- [ ] **Step 3: Gates, then commit.**

```bash
npm run typecheck && npm run lint && npm run test
git add packages/dashboard/src/app/no-staged-rollout.test.ts
git commit -m "test: guard against the staged rollout's wording returning (ADR 0121)"
```

---

### Task 10: Docs

**Files:** `REVIEW.md`, `docs/08_ROADMAP.md`, `docs/17_OPERATOR_ACCESS.md`, `docs/SMOKE_TESTS.md`, `docs/reports/release2-gate-signoff.md`, `docs/STATE.md`, `PRIVACY.md`

- [ ] **Step 1:**
  - `REVIEW.md`: after §A4's "Fix." paragraph and after §E's automod "Done when", add one line each: `> **Superseded 2026-09-30 by ADR 0121** (owner decision): one guild-wide Off / Watch / On switch replaces per-rule observe windows and cutover. The no-overlap rule survives as a step in the On confirmation.` Do not rewrite the original text.
  - `docs/08_ROADMAP.md`: in Release 2, replace the bullets on per-rule test/observe/enforce, fixtures and dry-run, and the Gate's observe-floor and cutover sentences, with the switch and "automod reaches On via the switch, recorded by an `automod.state_set` audit row". Keep the rest of the Gate (hierarchy tests, idempotency, audit fields, no AI).
  - `docs/17_OPERATOR_ACCESS.md`: delete the `automod dryrun`, `ready` and `signoff` lines and any flip-day text; note that the switch lives on the dashboard's automod tab and the kill switch is the terminal's emergency stop.
  - `docs/SMOKE_TESTS.md`: replace Section E with "Section E — the automod switch (dev guild)". Steps:
    1. `doctor` shows `automod off`.
    2. Post a term matching an enabled rule: nothing is recorded.
    3. Switch to Watch (password asked). Post again: one match on Review, the message is untouched. Flag it false positive.
    4. Switch to On; the dialog lists the rules and the Carl-bot sentence. With dry run on, post again: `delete_blocked_dry_run` is recorded. With dry run off, the message is deleted.
    5. Switch to Off with no password prompt. Post again: nothing is recorded.
    6. The audit log shows four `automod.state_set` rows.
  - `docs/reports/release2-gate-signoff.md`: replace the automod rows (observe floor, false-positive rate via cutover audit, one-rule-at-a-time) with one row: "automod reached On via the switch — the `automod.state_set` audit row, timestamp". Leave the rest.
  - `docs/STATE.md`: replace the Slice 11 paragraph with a short ADR 0121 paragraph: Slice 11 abandoned; the switch is in; migrations 0054–0055; next is deploy (stop → migrate → start) and the new Section E.
  - `PRIVACY.md`: `rg -n -i "fixture|observe" PRIVACY.md`. Remove or reword any paragraph about saved fixtures, and state that automod keeps no copy of matched messages beyond what case events already hold. Keep the 30-day deleted-message text if it is about logging, not fixtures.
- [ ] **Step 2: Lint** (`npm run lint` checks Markdown through Prettier), then commit.

```bash
npm run lint
git add REVIEW.md docs PRIVACY.md
git commit -m "docs: bring REVIEW, roadmap, operator access, smoke tests, gate sign-off, STATE and PRIVACY in line with ADR 0121"
```

---

## Rollout (owner, after merge)

1. `sudo systemctl stop bananasaurs && npm run build && npm run db:migrate && sudo systemctl start bananasaurs` (stop → migrate → start; two migrations).
2. `npx bananasaurs doctor`: expect `automod           off`.
3. Run the new SMOKE_TESTS Section E on the dev guild.
4. On the club: turn off overlapping Carl-bot/Dyno automod, then set the switch to Watch or On.
