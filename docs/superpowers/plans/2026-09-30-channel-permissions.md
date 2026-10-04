# Channel Permissions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** make Read, Write, Archive and No access independent, enforced per-channel
permissions that every Bananasaurs surface obeys, and make turning Archive off pause
recording instead of deleting.

**Architecture:**
- A guild-bound `ChannelAccess` port in `packages/core/src/channels/access.ts`:
  - built on the existing `isInScope` precedence, plus a new `'read'` purpose;
  - wired once per guild in `apps/daemon/src/runtime/guild.ts`;
  - consumed by the assistant, MCP, HTTP, reminders and task nudges.
- Storage:
  - a new `channel_read_scope` allowlist;
  - a `channel_read_seeds` once-only marker;
  - an `archive_channels.collecting` flag.
- The dashboard Permissions page shows four columns over these.

**Tech Stack:** TypeScript (Node 22, strict), better-sqlite3 + Drizzle, discord.js v14,
Fastify, React + Vite, Zod, Vitest.

**Spec:** `docs/superpowers/specs/2026-09-30-channel-permissions-design.md` (approved
2026-09-30). ADR: `docs/decisions/0126-channel-read-write-archive-permissions.md`.

## Global Constraints

- **Hard rule 2:** every repository function takes `GuildScope` first and filters through
  `scope.only`. Every new table has `guild_id` in its primary key and a foreign key to
  `guilds` with `ON DELETE CASCADE`.
- **Hard rule 6:** the Read seed runs at most once per guild, enforced by a primary key on
  `channel_read_seeds.guild_id`, not by caller discipline.
- **Hard rule 1:** moderation, automod, purge, and operator-configured posts (assistant log
  channel, escalation channel, panels, logging forward targets) are **exempt**. Do not add
  checks to them.
- **The two handed messages:** the tagging message and the message it replies to are the
  only Discord messages the assistant reads without Read.
- **Archive off never deletes.** The only delete verbs are the CLI's
  `archive delete-channel` / `archive delete-category` and the HTTP `DELETE` routes. The
  dashboard Permissions page never calls those routes.
- **Fail closed:** a channel the live cache and one fetch cannot resolve is denied for
  read, write and record.
- **Archived history of a channel that no longer exists in Discord** stays searchable unless
  that channel id itself is excluded.
- **Log lines** use `safeLogFields`, carry `guildId`, `channelId`, `purpose` and `reason`,
  and never carry message content.
- **Command rules for every agent:**
  - Always give `rg` or `git` an explicit path, never a bare `.`.
  - Never pipe a gate through `tail` or `head`.
  - No loop variables as paths.
  - Run each gate as its own command.
- **Gates**, run from the worktree root (it has its own `node_modules`):
  `npm run typecheck`, `npm run lint`, `npm run test`.
- **Migration:** generated with `npm run db:generate -- --name channel_permissions`. Keep
  the number drizzle assigns; it is renumbered at merge if another branch took it.

## Review Focus

1. **A thread under a category set to No access** must be denied read, write and record,
   even when the thread's parent channel has its own Read row. Pinned in Task 2.
2. **A channel moved out of a Read-granted category** loses Read immediately, with no stale
   copy. Pinned in Task 3 (the resolver is live) and Task 2 (precedence).
3. **Archive off, then on again**, keeps the attachment policy, does not queue a duplicate
   backfill, and the messages archived before are searchable throughout. Pinned in Task 1
   and Task 4.
4. **A reminder whose channel loses Write before it is due** is marked skipped once and
   never retried in a loop. Pinned in Task 8.
5. **The Read seed** run twice, or on a guild whose cache is empty at boot, never inserts
   twice. It never marks a guild seeded while its cache is empty, which would leave the
   guild with Read off everywhere forever. Pinned in Task 3.

---

### Task 1: Storage — read scope, seed marker, archive pause

**Files:**
- Modify: `packages/storage/src/schema.ts`. Add tables `channelReadScope` and `channelReadSeeds` beside `mcpSendAllowlist` (around line 1689). Add the `collecting` column to `archiveChannels` (around line 874).
- Create: `packages/storage/src/repos/channel-read.ts`
- Create: `packages/storage/src/repos/channel-read.test.ts`
- Modify: `packages/storage/src/repos/archive.ts` — add `pauseChannel`, `resumeChannel`, `hasArchivedChannel`, and the collecting filter.
- Modify: `packages/storage/src/repos/archive.test.ts`
- Modify: `packages/storage/src/index.ts` — export the new repo the same way `mcpSendRepo` is exported. Read that file first and follow its pattern.
- Create (generated): `drizzle/00NN_channel_permissions.sql` plus the snapshot and journal entry.

**Interfaces — Produces:**
```ts
// packages/storage/src/repos/channel-read.ts
export interface ReadScopeRow { readonly channelId: string; readonly scopeKind: 'channel' | 'category'; readonly addedAt: number }
export const allowRead: (scope: GuildScope, input: { channelId: string; scopeKind: 'channel' | 'category'; now: number }) => boolean; // false = already allowed
export const disallowRead: (scope: GuildScope, channelId: string, scopeKind: 'channel' | 'category') => 'removed' | 'not-allowed' | 'wrong-kind';
export const isReadScopeAllowed: (scope: GuildScope, channelId: string, scopeKind: 'channel' | 'category') => boolean;
export const listReadScope: (scope: GuildScope) => readonly ReadScopeRow[];
/** One transaction: claims the marker; inserts rows only when the claim succeeded. Empty `targets` claims nothing. */
export const seedReadScopeOnce: (scope: GuildScope, input: { targets: readonly { channelId: string; scopeKind: 'channel' | 'category' }[]; now: number }) => 'seeded' | 'already-seeded' | 'nothing-to-seed';

// packages/storage/src/repos/archive.ts (additions)
export const pauseChannel: (scope: GuildScope, channelId: string) => 'paused' | 'already-paused' | 'not-enabled' | 'derived';
export const resumeChannel: (scope: GuildScope, channelId: string) => 'resumed' | 'already-collecting' | 'not-enabled' | 'derived';
/** True when an `archive_channels` row of ANY kind exists — the "has archived history" test; ignores `collecting`. */
export const hasArchivedChannel: (scope: GuildScope, channelId: string) => boolean;
// ArchiveChannel gains `readonly collecting: boolean`.
```

**Behaviour changes in `archive.ts`:**
- `isChannelEnabled`, `hasCategoryRow` and `parentIncludesThreads` add
  `AND collecting = 1` to their predicates.
  - For `parentIncludesThreads`, the rule is: a paused parent row answers `true`, which is
    the no-row default. Paused means "not a grant". The thread is still not recorded,
    because `hasOwnRow(parent)` is now false.
- `enableChannel` on an existing paused row of the same kind returns `'already-enabled'`
  **unchanged**. Resuming is its own verb, so a replayed enable never resets a cursor.
- `pauseChannel` / `resumeChannel` act on `scope_kind IN ('channel','category')`. A derived
  row answers `'derived'`: pause its category instead.

- [ ] **Step 1: Schema.** Add to `schema.ts`, mirroring `mcpSendAllowlist`:
```ts
export const channelReadScope = sqliteTable(
  'channel_read_scope',
  {
    guildId: snowflake('guild_id').notNull(),
    channelId: snowflake('channel_id').notNull(),
    scopeKind: text('scope_kind').notNull().default('channel'),
    addedAt: integer('added_at').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.guildId, t.channelId] }),
    foreignKey({ columns: [t.guildId], foreignColumns: [guilds.guildId] }).onDelete('cascade'),
    check('channel_read_scope_guild_id_snowflake', snowflakeCheck(t.guildId)),
    check('channel_read_scope_channel_id_snowflake', snowflakeCheck(t.channelId)),
    check('channel_read_scope_scope_kind', sql`${t.scopeKind} IN ('channel','category')`),
  ],
);

/** ADR 0126: the Read seed's once-only marker (hard rule 6) — the PK makes a second seed impossible. */
export const channelReadSeeds = sqliteTable(
  'channel_read_seeds',
  {
    guildId: snowflake('guild_id').notNull().primaryKey(),
    seededAt: integer('seeded_at').notNull(),
  },
  (t) => [
    foreignKey({ columns: [t.guildId], foreignColumns: [guilds.guildId] }).onDelete('cascade'),
    check('channel_read_seeds_guild_id_snowflake', snowflakeCheck(t.guildId)),
  ],
);
```
Then add the column to `archiveChannels`:
```ts
    /** ADR 0126: 0 = Archive off (paused). Rows and messages are kept; nothing records. */
    collecting: integer('collecting').notNull().default(1),
```
plus `check('archive_channels_collecting', sql\`${t.collecting} IN (0,1)\`)` in its
constraint list.
- [ ] **Step 2:** Run `npm run db:generate -- --name channel_permissions`. Open the generated
  SQL and confirm two things:
  - the `archive_channels` change is an `ALTER TABLE ... ADD collecting ... DEFAULT 1`
    (existing rows keep collecting);
  - if drizzle rebuilt the table instead, the copy preserves every row.

  Then check whether the repo has a guild-scope invariant test, which lists every table with
  `guild_id` (`rg -n "mcp_send_allowlist" packages/storage/src`). If it exists, add both
  new tables to it.
- [ ] **Step 3: Write the failing tests** in `channel-read.test.ts`. Follow
  `mcp-send.test.ts` / `logging.test.ts` for the harness (two guild scopes, `a` and `b`).
  ```ts
  it('allowRead is guild-scoped: a row in guild a grants nothing in guild b', ...)
  it('disallowRead refuses the other kind with wrong-kind and keeps the row', ...)
  it('seedReadScopeOnce inserts targets once; the second call is already-seeded and inserts nothing', ...)
  it('seedReadScopeOnce with empty targets returns nothing-to-seed and does NOT claim the marker, so a later call with targets seeds', ...)
  it('seedReadScopeOnce never overwrites an existing row (insert-or-ignore)', ...)
  ```
  In `archive.test.ts`:
  ```ts
  it('pauseChannel keeps the row and its messages; isChannelEnabled becomes false; hasArchivedChannel stays true', ...)
  it('resumeChannel restores isChannelEnabled and keeps attachmentPolicy, cursor and backfillState', ...)
  it('a paused category row is not a hasCategoryRow grant', ...)
  it('pauseChannel on a derived row answers derived', ...)
  it('enableChannel on a paused row returns already-enabled and does not resume', ...)
  ```
- [ ] **Step 4:** Run `npx vitest run packages/storage/src/repos/channel-read.test.ts packages/storage/src/repos/archive.test.ts`. Expected: FAIL (missing exports).
- [ ] **Step 5: Implement** the repo functions, mirroring `mcp-send.ts`. `seedReadScopeOnce`
  runs inside one `write(scope, ...)`:
  1. If `targets` is empty, return `'nothing-to-seed'`.
  2. Insert the marker with `onConflictDoNothing`. If `changes === 0`, return `'already-seeded'`.
  3. Insert each target with `onConflictDoNothing`.
  4. Return `'seeded'`.
- [ ] **Step 6:** Re-run the tests from Step 4. Expected: PASS. Then run
  `npm run typecheck` alone and fix every caller that breaks on `ArchiveChannel.collecting`.
- [ ] **Step 7: Commit** with the message
  `feat(storage): read scope, read seed marker, archive pause (ADR 0126)`.

---

### Task 2: Core — `'read'` purpose and `ChannelAccess`

**Files:**
- Modify: `packages/core/src/channels/scope.ts`
- Modify: `packages/core/src/channels/scope.test.ts`
- Create: `packages/core/src/channels/access.ts`
- Create: `packages/core/src/channels/access.test.ts`
- Modify: `packages/core/src/index.ts` — export `createChannelAccess`, `ChannelAccess`, `AccessDecision`, `ChannelFacts`, `isNoAccess`.

**Interfaces — Produces:**
```ts
// scope.ts
export type ScopePurpose = 'archive' | 'send' | 'read';
/** No access: an exclusion on the channel, its parent, or its category. Sync, for subscribers that hold event facts. */
export const isNoAccess = (facts: Pick<ScopeFacts, 'channelId' | 'parentChannelId' | 'categoryId' | 'isExcluded'>): boolean;

// access.ts
export interface ChannelFacts {
  readonly channelId: Snowflake;
  readonly parentChannelId: Snowflake | undefined;
  readonly categoryId: Snowflake | undefined;
  readonly isPrivateThread: boolean;
}
export type AccessPurpose = 'read' | 'write' | 'record';
export type AccessDecision =
  | { readonly allowed: true; readonly grantedBy: Snowflake }
  | { readonly allowed: false; readonly reason: 'no-access' | 'not-granted' | 'unknown-channel' };
export interface RowPredicates {
  hasOwnRow(id: Snowflake): boolean;
  hasCategoryRow(id: Snowflake): boolean;
}
export interface ChannelAccessDeps {
  resolve(channelId: Snowflake): Promise<ChannelFacts | undefined>;
  isExcluded(id: Snowflake): boolean;
  read: RowPredicates;
  write: RowPredicates;
  record: RowPredicates & { parentIncludesThreads(id: Snowflake): boolean };
  hasArchivedChannel(channelId: Snowflake): boolean;
}
export interface ChannelAccess {
  check(purpose: AccessPurpose, channelId: Snowflake): Promise<AccessDecision>;
  /** Archived history readable: an archive row exists and the channel is not No access. Unresolvable channel → own exclusion only. */
  canSearchArchived(channelId: Snowflake): Promise<boolean>;
  isNoAccess(channelId: Snowflake): Promise<boolean>; // unresolvable → own exclusion only
}
export const createChannelAccess: (deps: ChannelAccessDeps) => ChannelAccess;
```

- [ ] **Step 1: Write the failing tests.** In `scope.test.ts`, add `'read'` cases (the
  existing `send` cases show the shape):
  - a public thread inherits its parent's own row;
  - a private thread never inherits;
  - a category grants its channels;
  - an exclusion on the thread, parent or category vetoes;
  - `isNoAccess` is true for an exclusion at each of the three levels.

  In `access.test.ts`, build deps from in-memory `Set`s:
  ```ts
  it('check(read) grants via the category row and reports grantedBy = categoryId')
  it('check(read) on a thread whose CATEGORY is excluded is no-access even when the parent has its own read row')  // Review Focus 1
  it('check(write) uses the write predicates, never the read ones')
  it('check(record) honours parentIncludesThreads=false for threads')
  it('check(*) on an unresolvable channel is unknown-channel')
  it('canSearchArchived: archived + not excluded → true; archived + category excluded → false; no archive row → false')
  it('canSearchArchived on an unresolvable channel with an archive row is true unless the id itself is excluded')
  it('a channel whose facts change between calls is re-resolved every call (no caching)')  // Review Focus 2
  ```
- [ ] **Step 2:** Run `npx vitest run packages/core/src/channels`. Expected: FAIL.
- [ ] **Step 3: Implement.** In `isInScope`, treat `read` exactly like `send` for thread
  inheritance:
  ```ts
  const threadsAllowed = purpose !== 'archive' || facts.parentIncludesThreads(parentChannelId);
  ```
  Use the same change in the category branch. In `access.ts`, map
  `read → ('read', deps.read)`, `write → ('send', deps.write)` and
  `record → ('archive', deps.record)`. Call `isInScope` with
  `parentIncludesThreads: () => true` for read and write. Return `no-access` when
  `isNoAccess(facts)`, otherwise `not-granted` when `isInScope` returns `undefined`.
  Do no caching.
- [ ] **Step 4:** Re-run the tests from Step 2. Expected: PASS.
- [ ] **Step 5: Commit** with the message `feat(core): read purpose and ChannelAccess (ADR 0126)`.

---

### Task 3: Daemon — build `ChannelAccess` per guild, seed Read, route MCP send through it

**Files:**
- Create: `apps/daemon/src/channels/access.ts` — `channelAccessFor(client, scope)`.
- Create: `apps/daemon/src/channels/access.test.ts`
- Create: `apps/daemon/src/channels/read-seed.ts` — `seedReadScope(client, scope, now)`.
- Create: `apps/daemon/src/channels/read-seed.test.ts`
- Modify: `apps/daemon/src/runtime/guild.ts`. Construct one `ChannelAccess` per guild and expose it on the guild runtime object, so later tasks can take it from there. Call `seedReadScope` once the client is ready and the guild is cached; find where other on-ready per-guild work runs (`rg -n "ready|clientReady" apps/daemon/src/runtime`).
- Modify: `apps/daemon/src/mcp/wiring.ts:585-605` (`sendPortFor`). Replace the inline `isInScope('send', …)` walk with `access.check('write', channelId)`. Keep the existing `private-thread` refusal and the audit `grantedByChannelId` (from `decision.grantedBy`).

**Interfaces:**
- Consumes:
  - `createChannelAccess`, `ChannelAccess` (Task 2);
  - `channelReadRepo.*`, `archiveRepo.hasArchivedChannel` / `isChannelEnabled` / `hasCategoryRow` / `parentIncludesThreads` (Task 1);
  - `mcpSendRepo.isChannelAllowed` / `isScopeAllowed`;
  - `loggingRepo.isChannelExcluded`;
  - `resolveChannel` (`apps/daemon/src/channels/resolver.ts`).
- Produces:
  - `export const channelAccessFor: (client: Client, scope: GuildScope) => ChannelAccess`
  - `export const seedReadScope: (client: Client, scope: GuildScope, now: number) => 'seeded' | 'already-seeded' | 'nothing-to-seed'`

  The seed's targets are every `GuildCategory` channel, plus every non-thread channel with
  no `parentId`, from `client.guilds.cache.get(guildId)?.channels.cache`. When the guild is
  uncached, the targets are empty.

- [ ] **Step 1: Write the failing tests.**
  - `read-seed.test.ts`, with an in-memory DB (follow an existing daemon test that uses
    `createTestDb` or similar; `rg -n "createTestDb|openTestDatabase" apps/daemon/src` to
    find it) and a fake client whose `channels.cache` is a `Map`:
    - seeds categories and uncategorised channels, but not channels inside categories or threads;
    - a second call is `already-seeded`;
    - an uncached guild gives `nothing-to-seed`, and a later call with channels seeds them. (Review Focus 5)
  - `access.test.ts`: `channelAccessFor` over a real test DB plus a fake client.
    - A channel with a Read row and Write off → read allowed, write `not-granted`.
    - An excluded category → `no-access` for both.
  - Extend the existing MCP send test (find it with `rg -n "sendPortFor|send_message" apps/daemon/src/mcp`):
    a channel under an excluded category is refused, with the reason the gateway already
    maps for exclusion. Check what reason it returns today, and keep it.
- [ ] **Step 2:** Run the new tests. Expected: FAIL.
- [ ] **Step 3: Implement.** In `channelAccessFor`, `resolve` calls
  `resolveChannel(client, scope.guildId, id)` and maps it to `ChannelFacts`. Every
  predicate reads its repo with `scope`. The seed is called with `Date.now()` from the guild
  runtime. It logs one info line with the outcome and the target count, through
  `safeLogFields`.
- [ ] **Step 4:** Run the tests again, then `npm run typecheck` alone. Expected: PASS and clean.
- [ ] **Step 5: Commit** with the message `feat(daemon): per-guild ChannelAccess, one-time Read seed, MCP send through it`.

---

### Task 4: Archive off pauses — ops, HTTP, CLI, subscriber, backfill

**Files:**
- Modify: `packages/core/src/ops/ports.ts` — add `archivePauseChannel`, `archiveResumeChannel`, `archivePauseCategory`, `archiveResumeCategory`.
- Modify: `packages/core/src/ops/commands/archive.ts`:
  - add commands `archive pause-channel`, `archive resume-channel`, `archive pause-category`, `archive resume-category`;
  - rename the CLI verbs `disable-channel` → `delete-channel` and `disable-category` → `delete-category`. Keep the old names as aliases only if the command registry supports aliases (check `defineCommand`); otherwise just rename them and update docs and tests.
  - The delete commands' description must say they **permanently delete archived messages**.
- Modify: `packages/core/src/ops/registry.ts`
- Modify: `packages/core/src/ops/test-fixtures.ts`
- Modify: `apps/daemon/src/ops/wiring.ts:512-605`. Wire the four ports to `archiveRepo.pauseChannel` / `resumeChannel`. Category pause and resume act on the category row only.
- Modify: `packages/http/src/test-support.ts` (mirror the wiring).
- Modify: `packages/http/src/routes/ops-write.ts` — add `POST /api/archive/channels/:channelId/pause`, `.../resume`, `/api/archive/categories/:channelId/pause` and `.../resume`. Use the same capability, audit and error mapping as the existing archive routes at lines 473–570. Leave the `DELETE` routes as they are.
- Modify: `packages/core/src/archive/backfill.ts:~118`. A paused own row stops the job, as "no longer enabled" does today: check `channel.collecting`. Replace the own-id-only `isChannelExcluded` check (around line 132) with `isNoAccess` over `{ channelId, parentChannelId: undefined, categoryId: ports.categoryOf(channelId) }`.
- Modify: `packages/core/src/archive/subscriber.ts`. No change is needed if Task 1's predicates already filter `collecting`. Add a test proving a paused channel is not recorded.
- Tests: `packages/core/src/ops/commands/archive.test.ts`, `packages/http/src/routes/*archive*.test.ts` (find them with `rg -n "api/archive/channels" packages/http/src`), `packages/core/src/archive/backfill.test.ts`, `packages/core/src/archive/subscriber.test.ts`.

- [ ] **Step 1: Write the failing tests.**
  - The subscriber does not record a paused channel, and records again after resume.
  - The backfill stops on a paused row, and stops on a channel whose category is excluded.
  - `POST /api/archive/channels/:id/pause` returns 200 with `{ outcome: 'paused' }` and the message count unchanged. Resume returns `{ outcome: 'resumed' }`. Without the capability it returns 403.
  - The CLI `archive pause-channel` prints that recording stopped and nothing was deleted.
  - `archive delete-channel` still deletes and reports the count.
- [ ] **Step 2:** Run the tests. Expected: FAIL.
- [ ] **Step 3: Implement.** Resume does **not** enqueue a backfill (Review Focus 3): the
  gap during the pause stays a gap, and the operator can run the existing backfill command.
  Say so in the resume output: `Recording resumed. Messages sent while paused were not
  recorded; run archive backfill <id> to fill the gap.` Check the existing backfill command
  name with `rg -n "backfill" packages/core/src/ops/commands/archive.ts`.
- [ ] **Step 4:** Run the tests, then `npm run typecheck` alone. Expected: PASS.
- [ ] **Step 5: Commit** with the message `feat: Archive off pauses recording; delete is its own verb (ADR 0126)`.

---

### Task 5: Read scope — ops commands, HTTP routes, CLI

**Files:**
- Modify: `packages/core/src/ops/ports.ts`:
  - `readScopeList(): readonly { channelId; scopeKind; addedAt }[]`
  - `readScopeAllow(input: { channelId; scopeKind }): 'allowed' | 'already-allowed' | 'no-such-channel'`
  - `readScopeDisallow(input: { channelId; scopeKind }): 'removed' | 'not-allowed' | 'wrong-kind'`
- Create: `packages/core/src/ops/commands/read-scope.ts`, with commands `scope read list`, `scope read enable-channel <id>`, `scope read enable-category <id>`, `scope read disable-channel <id>` and `scope read disable-category <id>`. Mirror `packages/core/src/ops/commands/mcp-allowlist.ts` exactly, including how it validates that a category id is a category.
- Create: `packages/core/src/ops/commands/read-scope.test.ts`
- Modify: `packages/core/src/ops/registry.ts`
- Modify: `packages/core/src/ops/test-fixtures.ts`
- Modify: `apps/daemon/src/ops/wiring.ts`
- Modify: `packages/http/src/test-support.ts`
- Modify: `packages/http/src/routes/ops-read.ts` — `GET /api/read-scope` returns `{ entries }`.
- Modify: `packages/http/src/routes/ops-write.ts` — `POST /api/read-scope`, `POST /api/read-scope/categories`, `DELETE /api/read-scope/:channelId` and `DELETE /api/read-scope/categories/:channelId`. Use the same capability and audit action naming as the `/api/send-allowlist` routes (around lines 742–830), with action names `read_scope.allow` / `read_scope.disallow`.
- Modify: `packages/dashboard/src/api/ops.ts` — add the `ReadScopeEntry` type.
- Modify: `packages/dashboard/src/app/cli-parity.ts` — register the new commands the way the send-allowlist ones are registered.
- Tests: the HTTP route tests next to the send-allowlist route tests.

- [ ] **Step 1: Write the failing tests:**
  - allow, list, disallow round trip;
  - wrong-kind refusal;
  - a category verb given a text channel id is `no-such-channel`;
  - 403 without the capability;
  - the audit row is written with no message content.
- [ ] **Step 2:** Run the tests. Expected: FAIL.
- [ ] **Step 3: Implement**, mirroring the send-allowlist code.
- [ ] **Step 4:** Run the tests and typecheck. Expected: PASS.
- [ ] **Step 5: Commit** with the message `feat: Read scope ops commands, HTTP routes and CLI (ADR 0126)`.

---

### Task 6: Assistant — Read and Write gates, No access

**Files:**
- Modify: `apps/daemon/src/assistant/commands.ts:276` (`handleMention`). Add an optional dep
  `channelAccess?: Pick<ChannelAccess, 'check'>`. After routing, and before enqueueing:
  - `check('write', event.channelId)` not allowed → log the reason (`no-access` or
    `write-denied`) and return. No enqueue, no reply.
- Modify: `apps/daemon/src/jobs/assistant.ts`. Add deps
  `channelAccess?: Pick<ChannelAccess, 'check'>`.
  - **Fresh run** (`prior === undefined`), mention source (`payload.interaction === undefined`),
    and `check('write', payload.channelId)` not allowed: log `write-denied` and return
    before the invoke. The member sees no reply and no provider call is made.
  - **Channel-context window** (around line 678) and **thread opener** (around line 696):
    run only when `check('read', channelId)` is allowed. Otherwise push the trace flag
    `channel-context-denied` and skip the fetch.
  - **The quoted (replied-to) message fetch** (around line 548) needs **no** Read check:
    it is a handed message.
- Modify: `apps/daemon/src/assistant/service.ts:~860` (`channelHistory`). Declare the
  `channel_history` tool only when `check('read', answerChannelId)` is allowed. Resolve this
  once per run, before `toolDeclarations`, and pass `undefined` as `channelHistory` when it
  is denied.
- **Slash commands.** Find where the assistant's public interaction replies choose
  `ephemeral` (`rg -n "ephemeral" apps/daemon/src/assistant apps/daemon/src/jobs/assistant.ts`).
  When the command's channel is not Write-allowed, force the ephemeral flag. Do not refuse:
  only the invoker sees an ephemeral reply.
- Modify: `apps/daemon/src/runtime/guild.ts` — pass the guild's `ChannelAccess` into
  `handleMention` deps, the job deps and the service.
- Tests: `apps/daemon/src/assistant/commands.test.ts`, `apps/daemon/src/jobs/assistant.test.ts`, and the service tool-declaration test (find it with `rg -n "channel_history" apps/daemon/src --glob '*.test.ts'`).

- [ ] **Step 1: Write the failing tests:**
  - A mention in a Write-denied channel enqueues nothing.
  - A mention in a No-access channel enqueues nothing.
  - The job with Write denied calls neither `service.invoke` nor `send`.
  - The job with Read denied makes no `fetchChannelMessages` call and no thread-opener
    fetch, still answers, and the trace flags contain `channel-context-denied`.
  - The job with Read denied still fetches the quoted message.
  - `channel_history` is not declared when Read is denied.
  - A slash reply in a Write-denied channel is ephemeral.
  - With `channelAccess` absent (legacy callers), the behaviour is unchanged.
- [ ] **Step 2:** Run the tests. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4:** Run the tests, then typecheck. Expected: PASS.
- [ ] **Step 5: Commit** with the message `feat(assistant): Read gates live fetches, Write gates replies (ADR 0126)`.

---

### Task 7: Assistant — archive search, recall, server info

**Files:**
- Modify: `apps/daemon/src/assistant/service.ts`:
  - **`search_archive`, `find` and Try-it** (around lines 392, 578 and 1474): after the
    candidate archive channel set is computed (today: the `archive_channels` rows
    intersected with the audience/member channels), drop each channel where
    `await access.canSearchArchived(id)` is false.
  - **`search_conversations`** (around line 944): drop conversations whose `channelId` has
    `await access.isNoAccess(id)` true.
  - **`server_info`** (`apps/daemon/src/assistant/tools.ts:~790`): hide No-access channels.
    Add a port `isNoAccess` to `AssistantToolPorts` and filter in the service, not in
    `tools.ts`, if the channel list is assembled in the service; read both files first.
- Modify: `apps/daemon/src/runtime/guild.ts` — pass the access port.
- Tests: the existing service tests for `search_archive`, `search_conversations` and Try-it.

- [ ] **Step 1: Write the failing tests:**
  - A No-access channel's archived messages are not returned by `search_archive`, nor by
    Try-it.
  - A paused (Archive off) channel's archived messages **are** returned.
  - `search_conversations` drops a No-access channel's summary.
  - `server_info` omits a No-access channel.
- [ ] **Step 2:** Run the tests. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4:** Run the tests and typecheck. Expected: PASS.
- [ ] **Step 5: Commit** with the message `feat(assistant): archive search and recall obey No access (ADR 0126)`.

---

### Task 8: Reminders, task nudges, MCP task destinations — Write

**Files:**
- Modify: `apps/daemon/src/assistant/reminder-targets.ts` (or its call site in `guild.ts:~853`). After today's Discord permission check, refuse when `check('write', channelId)` is not allowed. Use the refusal reason the existing refusals use (one short sentence), worded: `Bananasaurs is not allowed to post in that channel.`
- Modify: `apps/daemon/src/assistant/reminder-delivery.ts:~155`. Before posting, check `check('write', channelId)`. If it is denied:
  - mark the reminder as skipped, using the existing terminal state if one fits (`rg -n "status" apps/daemon/src/assistant/reminder-delivery.ts`). If none fits, add the status `skipped-no-write` to the reminder status CHECK in the same migration as Task 1 only if Task 1 is not yet committed; otherwise make a new migration.
  - log the skip;
  - return without throwing, so the job never retries.
- Modify: `apps/daemon/src/jobs/task-nudges.ts`, at `destination()` and before each post or reaction around lines 423–752: when the destination is not Write-allowed, skip and log, without throwing.
- Modify: `apps/daemon/src/mcp/task-admin-port.ts:~108-142`: refuse a destination that is not Write-allowed, with a refusal string matching the file's existing ones.
- Tests: the existing tests next to each file.

- [ ] **Step 1: Write the failing tests:**
  - `set_reminder` into a Write-denied channel is refused.
  - A due reminder whose channel lost Write is skipped. The job completes, `send` is never
    called, and a second run does nothing. (Review Focus 4)
  - A nudge to a Write-denied destination posts nothing and completes.
  - The MCP task-admin tools refuse a Write-denied destination.
- [ ] **Step 2:** Run the tests. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4:** Run the tests and typecheck. Expected: PASS.
- [ ] **Step 5: Commit** with the message `feat: reminders, nudges and task destinations need Write (ADR 0126)`.

---

### Task 9: MCP read tools and HTTP archive routes — archived-history check

**Files:**
- Modify: `apps/daemon/src/mcp/wiring.ts`:
  - **`listArchiveChannelIds`** (around line 209, behind `search_messages`): filter by
    `canSearchArchived`.
  - **`read_channel_history`:** `canSearchArchived(channelId)` false → the tool's existing
    not-found result.
  - **`get_message`:** after `findMessage`, `canSearchArchived(message.channelId)` false →
    the same not-found result as a missing id. There is no oracle: the response must be
    identical.
  - **`list_channels` / `list_threads`** (around lines 296 and 342): omit channels where
    `isNoAccess` is true.
- Modify: `apps/daemon/src/ops/wiring.ts:~845-890`, the three archive read ports behind
  `/api/archive/search`, `/channels/:id/messages` and `/messages/:id`, with the same rules.
  The message-by-id route returns its existing 404.
- Modify: `packages/http/src/test-support.ts` to mirror the wiring.
- Tests: the MCP archive-tool tests and the HTTP archive read route tests.

- [ ] **Step 1: Write the failing tests:**
  - `get_message` for a message in a No-access channel is indistinguishable from an
    unknown id.
  - `search_messages` omits a No-access channel and includes a paused one.
  - `/api/archive/messages/:id` returns 404 for a No-access channel's message.
  - `list_channels` omits a No-access channel.
- [ ] **Step 2:** Run the tests. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4:** Run the tests and typecheck. Expected: PASS.
- [ ] **Step 5: Commit** with the message `feat: MCP and HTTP archive reads obey No access; get_message is checked (ADR 0126)`.

---

### Task 10: Logging — full No access precedence

**Files:**
- Modify: `packages/core/src/logging/subscriber.ts:150,176,178`. Replace each
  `ports.isChannelExcluded(event.channelId)` with
  `isNoAccess({ channelId: event.channelId, parentChannelId: event.parentChannelId, categoryId: event.categoryId, isExcluded: (id) => ports.isChannelExcluded(id) })`.
  Confirm that these event kinds carry `parentChannelId` and `categoryId` (the archive
  subscriber reads them from the same events). If one does not, keep the own-id check for
  that kind and note it in the commit.
- Modify: `packages/core/src/logging/attribute-deletion.ts:~72` the same way, if it checks
  exclusion.
- Test: `packages/core/src/logging/subscriber.test.ts`.

- [ ] **Step 1: Write the failing test:** a message create, edit or delete in a thread whose category is excluded is not logged.
- [ ] **Step 2:** Run it. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4:** Run it. Expected: PASS.
- [ ] **Step 5: Commit** with the message `fix(logging): No access inherits through parent and category (ADR 0126)`.

---

### Task 11: Dashboard Permissions page

**Files:**
- Modify: `packages/dashboard/src/pages/permissions.tsx`
- Modify: `packages/dashboard/src/pages/permissions.test.tsx`
- Modify: `packages/dashboard/src/api/ops.ts` — add `paused`/`collecting` to `ArchiveChannelStatus` if the status route does not already pass it. Check `archiveStatus` in `apps/daemon/src/ops/wiring.ts` and the read route.

**Behaviour:**
- **Load:** add `session.read<{ entries: ReadScopeEntry[] }>('/api/read-scope')` to the
  combined load.
- **`ScopeRow`** gains `read: 'on' | 'via-category' | 'off' | 'excluded'` and `readVia`,
  computed exactly like `send`.
- **Archive state** gains `'paused'`: an own row (or category row) with `collecting = false`.
  The badge reads "Off (history kept)".
- **Columns, in order:** Channel · Read · Write · Archive · No access · Change.
  - The No access column shows a "No access" badge or nothing.
  - The Change column has one toggle per switch:
    - **Read:** "Allow read" / "Stop read" — POST `/api/read-scope` (or `/categories`) /
      DELETE `/api/read-scope/:id` (or `/categories/:id`).
    - **Write:** unchanged.
    - **Archive:** "Archive" (new row, POST as today) / "Resume archiving" (paused, POST
      `.../resume`) / "Stop archiving" (on, POST `.../pause`). No confirm dialog.
    - **No access:** unchanged toggle.
- **Remove** `ConfirmDialog` and `PendingArchiveStop`. The page must not reference any
  `DELETE /api/archive/...` URL. A test asserts this by checking that the fetch mock never
  sees `DELETE` with `/api/archive`.
- **Replace the `PageHeader` purpose** with: `Choose what Bananasaurs may do in each channel or category. Read, Write and Archive are separate switches; No access overrides all three.`
- **New first Card, "What each switch means"**, as a `<dl>`:
  - **Read:** May look up recent messages live from Discord. Off: the bot only sees the message that tagged it, the one it replies to, and the archive.
  - **Write:** May post here, including answering when tagged. Off: the bot stays silent here.
  - **Archive:** Records new messages into a searchable copy. Turning it off stops recording; nothing is deleted. Delete archived messages on the Archive page.
  - **No access:** Overrides everything above and hides archived copies. Moderation and automod still work.
- **New Card, "Not controlled here"**: The assistant log channel, the escalation channel,
  panels and logging forwards post to the channels you picked for them. Moderation, automod
  and purge work in every channel.
- **Delete the old "MCP permissions" card**, whose text the legend now covers. Keep the
  "Assistant permissions" and "Specialised controls" cards. In the latter, change the
  Archive line to: `browse archived messages, run backfills, set retention, and delete archived messages.`
- **Remove the old intro paragraph** that mentions "replaces the old Exclude wording".

- [ ] **Step 1: Write the failing tests** in `permissions.test.tsx`, following the existing
  fetch-mock harness:
  - the Read column renders `On, via <category>` for a category-granted channel;
  - "Allow read" POSTs `/api/read-scope`;
  - "Stop archiving" POSTs `/api/archive/channels/<id>/pause` and opens no dialog;
  - a paused row shows "Off (history kept)" and "Resume archiving";
  - no request ever uses `DELETE` on `/api/archive`;
  - the legend text for each switch is present.
- [ ] **Step 2:** Run `npx vitest run packages/dashboard/src/pages/permissions.test.tsx`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4:** Run the tests, then `npm run lint` alone. Expected: PASS.
- [ ] **Step 5: Commit** with the message `feat(dashboard): Permissions page with Read, Write, Archive, No access (ADR 0126)`.

---

### Task 12: Docs and full gates

**Files:**
- Modify: `docs/decisions/0126-channel-read-write-archive-permissions.md` — set the status to `Accepted (2026-09-30)`.
- Modify: `docs/decisions/0009-archive-scope-allowlist.md`, `0047-dynamic-channel-scope.md`, `0089-channel-context-and-conversation-links.md` — append a one-line `Amended by ADR 0126: …` note to each.
- Modify: `PRIVACY.md`:
  - add Read: what it allows, and that it is seeded on for existing channels;
  - say that Archive off keeps already-archived messages until the owner deletes them;
  - say that No access hides archived copies.

  Find the archive section with `rg -n -i "archive" PRIVACY.md`.
- Modify: `docs/superpowers/specs/2026-09-30-channel-permissions-design.md`:
  - change the status to `Approved 2026-09-30`;
  - in §4, reword "trace records `write-denied`" to "logged as `write-denied`; no run, so
    no trace";
  - in §5, the seed marker is the `channel_read_seeds` table, not a job key;
  - replace the archive-delete CLI wording with the final command names from Task 4.
- Modify: any doc or runbook that names `archive disable-channel` / `disable-category`
  (`rg -n "disable-channel|disable-category" docs packages apps`).

- [ ] **Step 1:** Make the doc edits.
- [ ] **Step 2:** Run `npm run typecheck`. Expected: clean.
- [ ] **Step 3:** Run `npm run lint`. Expected: clean.
- [ ] **Step 4:** Run `npm run test`. Expected: all pass.
- [ ] **Step 5: Commit** with the message `docs: ADR 0126 accepted; PRIVACY and amendments`.
