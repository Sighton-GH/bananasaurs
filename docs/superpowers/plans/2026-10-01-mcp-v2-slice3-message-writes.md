# MCP connector v2 — Slice 3: message writes — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the owner do real message work in Discord from Claude:
- post with replies, embeds and explicit pings, into channels and threads;
- create public and private threads and forum posts;
- edit or delete the bot's own messages;
- pin, react, archive and lock;
- undo what can be undone.

Every one of these goes through one guarded, idempotent, audited pipeline.

**Architecture:** One new core pipeline, `packages/core/src/effects/mcp-action-gateway.ts` (ADR 0116), runs every MCP write. It stores each one in one ledger, `mcp_actions` (migration tag `0092`). The daemon resolves targets against ADR 0047 send scope and the bot's live permissions. The new Discord REST calls go through `DiscordPort`. New tools are registered only under `bananasaurs:send`.

**Tech Stack:** TypeScript (Node 22, strict), `@modelcontextprotocol/sdk`, Zod, Drizzle/better-sqlite3, discord.js v14 REST, Vitest.

**Spec:** `docs/superpowers/specs/2026-09-29-mcp-connector-v2-design.md` §3.1, §3.2, §5.1, §6.1–6.3. ADRs written before code: `docs/decisions/0116-mcp-action-gateway-and-send-targets.md` and `docs/decisions/0117-mcp-role-and-user-pings.md`. ADRs 0113 (output format), 0114 (scopes) and 0115 (private-thread reads) bind this slice. These are slice 1–2's 0110–0112, renumbered when main was merged; see the precondition below.

**Precondition (controller, before Task 1):**
1. Merge slice 2 into `worktree-mcp-connector-v2`.
2. Merge `main` (task tracking + Tavily) into it.
3. Renumber this work's ADRs 0110/0111/0112 to 0113/0114/0115, updating every reference in code comments and docs.
4. Re-tag migration `0080_archive_reply_links` as `0091_archive_reply_links` (drizzle-kit takes the last snapshot by file name, so it must sort after main's `0090_search_keys`); place it last in the journal (idx 91) with a `when` above 0090's; rebuild its snapshot on 0090's and re-chain `prevId`; `npm run db:generate` must report no changes. The journal test must pass. *(Done 2026-10-01.)*
5. Run the gates green.

## Global Constraints

- Read `CLAUDE.md` hard rules 1–9. Every tool takes `guildId` and calls `requireReachableGuild(principal, guildId)` before any port call (hard rule 2).
- Every write tool takes `idempotencyKey` (required, min 1) and optional `dryRun`, and returns structured text naming `actionId`, `status` and the resulting ids. On parse failure it returns `INVALID_ARGUMENTS_MESSAGE`; on gate failure or any throw it returns `GUILD_REFUSAL_MESSAGE`. It never throws. Refusal texts are distinct, actionable and content-free (ids only), as in `packages/mcp/src/tools/send.ts`.
- Every write goes through `runMcpAction` (Task 2). No tool or port calls a Discord write method any other way.
- `allowedMentions` is always `{ parse: [] }` plus explicit `roles`/`users` lists that passed policy (ADR 0117). Never `'everyone'`.
- Audit rows: `actor_type='mcp_operator'`, `via='http'`, action `mcp.<kind>`. They hold ids, the outcome and `actionId`, never content (rule 4).
- Content stored in `mcp_actions` is limited to: the bot's own previous content in `undo_json` (edits), and the posted content's hash. The posted content itself is not stored.
- `packages/mcp` must not import `discord.js`, `@bananasaurs/storage` or `@bananasaurs/http`. `packages/core` must not import storage.
- Storage functions take `GuildScope` first and filter with `scope.only(...)`. New tables are guild-partitioned with an FK to `guilds` and snowflake CHECKs, and satisfy `schema-invariants.test.ts`.
- Migration tags for this work are `0092`–`0099`. The journal `idx` is the next sequential number, and `when` must be above every earlier entry (the journal test enforces it).
- No new dependencies. No new outbound network destinations (Discord REST only). No DMs, no moderation actions, no channel create/delete.
- Tool names must be unique across all registrars, including main's task tools (Task 7 adds the test).
- Gates: `npm run typecheck`, `npm run lint`, `npm run test`, each run alone and never piped through `tail`/`head`. Shell rules: explicit paths for `rg`/`git`; no `cd x && …`; no heredoc-plus-redirect.
- Before the first gate in an oc worktree, run `bash /home/bryan/projects/bananasaurs/.claude/worktrees/mcp-connector-v2/.oc-runs/mcp-v2-s1/relink.sh`.

## Review Focus

1. A replayed key with different arguments → refused, with no Discord call (Task 2 test "key reuse with other args").
2. A crash between claim and call (the port throws after the claim) → the retry replays and never posts twice (Task 2 test "claim survives failure").
3. A role that gains ManageRoles mid-test → the ping is refused (Task 4 test "floor is live").
4. An edit or delete on a role-panel message, a task anchor, or a member's message → refused before any Discord call (Task 6).
5. A private thread created via the MCP → gets an allowlist row and an `mcp_private_threads` row, and `read_thread` reads it without the owner being a member (Task 5).
6. Kill switch on → every write tool refuses. The breaker is never tripped by an MCP refusal (Task 2).
7. A pre-migration `mcp_sends` key retried after deploy → replays (Task 1 copy test + Task 4 test).

---

### Task 1: Storage — `mcp_actions`, role policy, private threads (migration 0092)

**Files:**
- Modify `packages/storage/src/schema.ts`, `packages/storage/src/index.ts`, `packages/storage/src/db.test.ts`, `packages/storage/src/schema-invariants.test.ts` (only if its allowlists need the new columns).
- Create `packages/storage/src/repos/mcp-actions.ts` + `.test.ts`, `packages/storage/src/repos/mcp-role-policy.ts` + `.test.ts`, `drizzle/0092_mcp_actions.sql`, `drizzle/meta/0092_snapshot.json`.
- Modify `drizzle/meta/_journal.json`.

**Interfaces:**
```ts
// schema
mcp_actions(
  guild_id snowflake FK guilds NOT NULL, action_id text NOT NULL (ulid-like, unique per guild),
  idempotency_key text NOT NULL, kind text NOT NULL, cap_group text NOT NULL CHECK IN ('message','edit','member_role','structure','pin_react'),
  args_hash text NOT NULL, status text NOT NULL CHECK IN ('claimed','done','dry_run','failed'),
  token_id text NOT NULL, target_channel_id snowflake NULL, result_message_id snowflake NULL, result_thread_id snowflake NULL,
  undo_json text NULL, undone_by_action_id text NULL, created_at int NOT NULL, completed_at int NULL,
  UNIQUE(guild_id, idempotency_key), UNIQUE(guild_id, action_id), INDEX(guild_id, cap_group, created_at), INDEX(guild_id, target_channel_id, created_at))
mcp_role_policy(guild_id PK FK, grant_mode text NOT NULL DEFAULT 'below-bot' CHECK IN ('below-bot','allowlist'),
  ping_mode text NOT NULL DEFAULT 'below-bot' CHECK IN ('below-bot','allowlist'), updated_at int NOT NULL)
mcp_role_allowlist(guild_id FK, role_id snowflake, purpose text CHECK IN ('grant','ping'), added_by_account_id text, added_at int,
  UNIQUE(guild_id, role_id, purpose))
mcp_private_threads(guild_id FK, thread_id snowflake, parent_channel_id snowflake, created_action_id text NOT NULL, created_at int,
  UNIQUE(guild_id, thread_id))

// repos/mcp-actions.ts
export interface McpActionRow { actionId; idempotencyKey; kind; capGroup; argsHash; status; tokenId; targetChannelId?; resultMessageId?; resultThreadId?; undoJson?; undoneByActionId?; createdAt; completedAt? }
export const findAction: (scope, idempotencyKey) => McpActionRow | undefined;
export const findActionById: (scope, actionId) => McpActionRow | undefined;
export const claimAction: (scope, row: {actionId, idempotencyKey, kind, capGroup, argsHash, tokenId, targetChannelId?, now, dryRun: boolean}) => { claimed: boolean }; // INSERT OR IGNORE; status 'dry_run' when dryRun else 'claimed'
export const completeAction: (scope, actionId, result: {status: 'done'|'failed', resultMessageId?, resultThreadId?, undoJson?, now}) => void;
export const markUndone: (scope, actionId, undoneByActionId) => boolean; // only when undone_by_action_id IS NULL
export const countActionsSince: (scope, capGroup, sinceMs) => number; // statuses claimed|done|dry_run
export const recentSameContent: (scope, argsHash, targetChannelId, sinceMs) => boolean;
export const listActions: (scope, {limit, beforeCreatedAt?}) => McpActionRow[];
// repos/mcp-role-policy.ts
export const readRolePolicy: (scope) => { grantMode: 'below-bot'|'allowlist'; pingMode: 'below-bot'|'allowlist' }; // defaults when no row
export const isRoleAllowlisted: (scope, roleId, purpose: 'grant'|'ping') => boolean;
export const recordPrivateThread: (scope, {threadId, parentChannelId, createdActionId, now}) => void; // idempotent
export const isMcpPrivateThread: (scope, threadId) => boolean;
```
- The migration copies `mcp_sends` into `mcp_actions`:
  - `action_id` = `'legacy:' || idempotency_key`; `kind` `'message.send'`; `cap_group` `'message'`;
  - `args_hash` = `content_hash`;
  - `status` = `CASE outcome WHEN 'dry_run' THEN 'dry_run' ELSE 'done' END`;
  - `target_channel_id` = `channel_id`; `result_message_id` = `message_id`;
  - `created_at` = `sent_at`, `completed_at` = `sent_at`.
  - Generate with `npm run db:generate -- --name mcp_actions`, rename the SQL and snapshot to tag `0092`, and fix the journal tag. Then append the copy `INSERT … SELECT` by hand at the end of the SQL (drizzle-kit does not emit data moves). Say in the RESULT that you did.

- [ ] Step 1: failing repo tests:
  - claim twice with one key → the second returns `claimed:false`;
  - guild B is isolated;
  - `countActionsSince` ignores `failed` and counts `dry_run`;
  - `markUndone` happens only once;
  - policy defaults to below-bot with no row;
  - `recordPrivateThread` is idempotent.

  FAIL → implement schema + repos → PASS.
- [ ] Step 2: migration + **copy test** in `db.test.ts`:
  - migrate to the previous tag;
  - seed two `mcp_sends` rows (one `dry_run`);
  - run `runMigrations`;
  - assert both are in `mcp_actions` with the mapped values, and that `mcp_sends` is unchanged.

  Watch it fail with the INSERT commented out, then restore.
- [ ] Step 3: Gates. Commit per step.

---

### Task 2: Core — `runMcpAction` pipeline, caps, dangerous-role floor, ping policy (test first)

**Files:** Create `packages/core/src/effects/mcp-action-gateway.ts` + `.test.ts`, `packages/core/src/roles/dangerous.ts` + `.test.ts`. Modify `packages/core/src/index.ts`.

**Interfaces:**
```ts
export type McpCapGroup = 'message' | 'edit' | 'member_role' | 'structure' | 'pin_react';
export const MCP_ACTION_CAPS: Readonly<Record<McpCapGroup, number>> = { message: 300, edit: 300, member_role: 1000, structure: 100, pin_react: 300 };
export const MCP_ACTION_WINDOW_MS = 60 * 60 * 1000;
export const argsHashFor: (kind: string, args: unknown) => string; // sha256 of canonical JSON (sorted keys) of {kind,args}
export interface McpActionIntent {
  readonly kind: string; readonly capGroup: McpCapGroup; readonly idempotencyKey: string; readonly tokenId: string;
  readonly argsHash: string; readonly targetChannelId: string | undefined; readonly dryRun: boolean;
  /** M5-D8 layer B: message posts only. */ readonly duplicateContentGuard: boolean;
}
export type McpActionRefusal = 'target' | 'killswitch' | 'breaker-open' | 'rate-cap' | 'key-reused-with-other-args' | 'duplicate-content-recently' | 'guild-unknown';
export type McpActionOutcome<R> =
  | { status: 'done'; actionId: string; result: R }
  | { status: 'dry-run'; actionId: string }
  | { status: 'replayed'; actionId: string; resultMessageId?: string; resultThreadId?: string }
  | { status: 'refused'; reason: McpActionRefusal; detail?: string }
  | { status: 'failed'; actionId: string; code: string };
export interface McpActionDeps {
  readonly guildId: GuildId; readonly logger: Logger; now(): number; newActionId(): string;
  readonly state: { read(): SafetyStateForSend | undefined };
  readonly ledger: { find(key): McpActionLedgerRow | undefined; claim(row): { claimed: boolean }; complete(actionId, result): void; countSince(capGroup, sinceMs): number; recentSameContent(argsHash, channelId, sinceMs): boolean };
  readonly audit: { record(input: { kind; actionId; outcome: 'done'|'dry-run'|'failed'; targetChannelId?; resultMessageId?; resultThreadId?; tokenId; dryRun; atMs }): void };
}
export const runMcpAction: <R extends { resultMessageId?: string; resultThreadId?: string; undo?: unknown }>(
  deps: McpActionDeps, intent: McpActionIntent,
  /** Policy result computed by the caller from live state BEFORE calling; a string is the refusal detail. */
  targetCheck: true | string,
  execute: () => Promise<R>,
) => Promise<McpActionOutcome<R>>;
// roles/dangerous.ts
export const DANGEROUS_PERMISSION_BITS: readonly bigint[]; // the ADR 0117 list, from discord-api-types PermissionFlagsBits (verify names in node_modules)
export const isDangerousRole: (permissions: bigint) => boolean;
export interface RoleFacts { id; position; permissions: bigint; managed: boolean; isEveryone: boolean }
export const rolePingAllowed: (role: RoleFacts, botTopPosition: number, mode: 'below-bot'|'allowlist', allowlisted: boolean) => true | 'dangerous' | 'managed-or-everyone' | 'above-bot' | 'not-allowlisted';
```
- *As built (Task 2, 2026-10-01):* `McpActionIntent` is not generic. The module also exports `MCP_ACTION_DUPLICATE_WINDOW_MS` (60 s) and the port shapes `McpActionClaim`, `McpActionCompletion` and `McpActionAuditInput`, which Task 4's deps factory implements. The ledger row type is `McpActionLedgerRow`.
- The pipeline order is ADR 0116 §1:
  1. target refusal;
  2. state (unknown → `guild-unknown`, kill switch, breaker);
  3. ledger find: same hash → `replayed`, different hash → `key-reused-with-other-args`;
  4. duplicate-content window (60 s), only when `duplicateContentGuard`;
  5. cap (`countSince(capGroup, now - window) >= cap` → `rate-cap`, with the detail being the reset time);
  6. claim (a lost race → re-find → replay or mismatch);
  7. dry run (`intent.dryRun || state.dryRun`): audit, return `dry-run`, no execute;
  8. execute. A throw → `complete(failed)` + audit `failed` + return `failed` (the claim row stays, so a retry replays);
  9. `complete(done, result)` + audit `done`.
- It never trips the breaker. It takes no `DiscordPort`: the caller's `execute` closure owns the single REST call.
- Test-first, each FAIL before implementing:
  - **key reuse with other args**;
  - **claim survives failure** (execute throws → the same key replays and `execute` is not called again);
  - kill switch;
  - breaker open (assert nothing trips it);
  - cap reached → refused, while a replay at the cap still replays;
  - the duplicate-content window applies only with the guard;
  - dry run makes no execute call and still occupies cap room;
  - target refusal comes before the state read;
  - floor: each dangerous bit alone → dangerous; `@everyone`/managed → refused; above-bot → refused; allowlist mode without a row → refused.

- [ ] Step 1: tests. Step 2: implement. Step 3: Gates. Commit per step.

---

### Task 3: Discord port — thread, forum, pin, reaction, mention writes

**Files:**
- Modify `packages/core/src/discord/port.ts`, `packages/discord/src/rest/port.ts`, `packages/discord/src/rest/port.test.ts`, `packages/testkit/src/fake-discord.ts`, `packages/testkit/src/fake-discord.test.ts`.
- Modify every other `implements DiscordPort` double that fails typecheck (minimal stubs).

**Interfaces (all guild id first; verify every route in `node_modules/discord-api-types` v10 `Routes`):**
```ts
pinMessage(guildId, ref: DiscordMessageRef): Promise<void>;          // PUT channelMessagesPin / pins route — verify name
unpinMessage(guildId, ref): Promise<void>;
deleteOwnReaction(guildId, ref, emoji: EmojiKey): Promise<void>;     // DELETE channelMessageOwnReaction
createThread(guildId, channelId, input: { name: string; type: 'public' | 'private'; autoArchiveMinutes: 60|1440|4320|10080; invitable?: boolean; fromMessageId?: string }): Promise<{ threadId: string }>;
addThreadMember(guildId, threadId, userId): Promise<void>;
removeThreadMember(guildId, threadId, userId): Promise<void>;
createForumPost(guildId, forumChannelId, input: { name: string; message: OutgoingMessage; appliedTagIds: readonly string[] }): Promise<{ threadId: string; messageId: string }>;
setThreadState(guildId, threadId, state: { archived?: boolean; locked?: boolean }): Promise<void>;
fetchMessageAuthor(guildId, ref): Promise<{ authorId: string; content: string; embeds: readonly unknown[] } | undefined>; // 404/403 → undefined
```
- `OutgoingMessage` gains `pingReplyAuthor?: boolean`. When `replyTo` is set and `pingReplyAuthor` is `false`, the REST adapter sends `allowed_mentions.replied_user: false`. When it is undefined, it keeps today's `true`, so assistant behaviour is unchanged (ADR 0072). Test both.
- FakeDiscord records each call and holds pin/thread/member state for later assertions.
- [ ] Step 1: REST tests per method: the route and body asserted against the installed types; 404 handling where specified. FAIL → implement → PASS.
- [ ] Step 2: FakeDiscord + tests. Gates. Commit per step.

---

### Task 4: Daemon target resolution + `send_message` upgraded and re-routed (ADR 0116 §3, ADR 0117)

**Files:** Modify `packages/mcp/src/tools/send.ts`, `packages/mcp/src/tools/send.test.ts`, `packages/mcp/src/server.ts`, `packages/mcp/src/index.ts`, `apps/daemon/src/mcp/wiring.ts`, `apps/daemon/src/mcp/wiring.test.ts`. Create `apps/daemon/src/mcp/targets.ts` + `.test.ts`, `apps/daemon/src/mcp/actions.ts` (the `McpActionDeps` factory over the repos) + `.test.ts`.

**Interfaces:**
```ts
// apps/daemon/src/mcp/targets.ts
export type TargetNeed = 'post' | 'post-in-thread' | 'create-public-thread' | 'create-private-thread' | 'pin' | 'manage-thread' | 'react';
export const resolveSendTarget: (client: Client, scope: GuildScope, guildId: GuildId, channelId: string, need: TargetNeed) =>
  { ok: true; channelId; parentChannelId?; categoryId?; isThread; isPrivateThread; isForum } | { ok: false; reason: 'not-in-guild' | 'not-in-send-scope' | 'private-thread-not-allowed' | 'bot-lacks-permission'; missing?: string };
// ADR 0047 isInScope('send') with the same facts as today's sendPortFor, then channel.permissionsFor(botMember) has the bits for `need`.
export const resolvePings: (client, scope, guildId, input: { roles: readonly string[]; users: readonly string[] }) =>
  { ok: true; roleIds: string[]; userIds: string[] } | { ok: false; reason: 'role-unknown'|'role-dangerous'|'role-managed-or-everyone'|'role-above-bot'|'role-not-allowlisted'|'user-not-member'; ref: string };
```
- The `send_message` params gain:
  - `replyTo?` (message id in the same channel/thread) and `pingReplyAuthor?` (default false);
  - `threadId?` (posts into that thread; the target becomes the thread with need `post-in-thread`);
  - `embeds?` (≤3; each `{title?≤256, description?≤4096, fields?≤10 {name≤256,value≤1024,inline?}, color? int 0..0xFFFFFF, footer?≤2048}`; total ≤6000 chars; no url/image/thumbnail fields — strict Zod);
  - `pingRoles?` (≤10, names or ids via `resolveRoleRef`) and `pingUsers?` (≤25 ids);
  - `dryRun?`.

  Content becomes optional when embeds are present, but at least one of the two is required.
- Re-route `sendPortFor` through `runMcpAction` with:
  - kind `message.send`, cap group `message`, `duplicateContentGuard: true`;
  - `argsHash` = `contentHashFor(targetChannelId, content)` when there are no embeds, pings or reply, else `argsHashFor('message.send', canonicalArgs)` (ADR 0116 §2);
  - `allowedMentions` `{ parse: [], roles, users }`.

  The result names the `actionId` and `messageId`. Keep every existing refusal text that still applies; add texts for the new reasons.
- Rename the tool's description to describe the new fields and the Discord Markdown note (bold, italics, lists, `-# subtext`, masked links; headings `#`–`###`).
- Test-first:
  - **floor is live** (role allowlisted/below the bot gains ManageRoles in the fake cache → refused);
  - `@everyone`/`@here` in content never ping (`allowedMentions.parse` is empty);
  - a pinged role passes and appears in `allowedMentions.roles`;
  - a reply with no ping → `replied_user` false;
  - posting into a thread under an in-scope channel passes, and into a private thread without its own row is refused;
  - bot lacks SendMessages → refused naming the permission;
  - **legacy key replays** (a row copied by migration 0092 with the old `content_hash` → the same plain-text args replay);
  - an embed with an image field → invalid arguments.

- [ ] Step 1: targets/pings tests → implement. Step 2: actions deps factory tests → implement. Step 3: tool + wiring tests → implement. Step 4: Gates. Commit per step.

---

### Task 5: Threads and forum posts

**Files:** Create `packages/mcp/src/tools/thread-writes.ts` + `.test.ts`. Modify `packages/mcp/src/server.ts`, `packages/mcp/src/index.ts`, `apps/daemon/src/mcp/wiring.ts`, `apps/daemon/src/mcp/wiring.test.ts`.

**Tools** (all `send` scope; each takes `guildId`, `idempotencyKey`, `dryRun?`):
- `create_thread {channel (id|name), name ≤100, type: 'public'|'private', autoArchiveMinutes? (default 1440), invitable? (private only, default false), fromMessageId? (public only), firstMessage? {content?, embeds?}}`
  - kind `thread.create`, cap group `structure`.
  - A private thread: write `mcp_private_threads` and an `mcp_send_allowlist` channel row for the thread (`addedByAccountId` = the principal's account) as soon as `createThread` returns, inside `execute` (both writes are idempotent).
    - *As built (controller ruling, Task 5 review):* this does not use the completion transaction. The Discord call → database window exists either way. A crash before the rows leaves an orphan thread that MCP cannot read, and putting the rows in the completion transaction would not prevent that. A crash after the rows but before completion leaves a thread the MCP really did create, readable, with its action still `claimed`; that is correct, not a leak.
  - `firstMessage` is a second action, key `<idempotencyKey>:first`, through the `message.send` path into the new thread.
- `add_thread_members` / `remove_thread_members {threadId, userIds ≤25}`
  - One action per call (kind `thread.members.add|remove`, cap group `structure`). Members are resolved live; a non-member of the guild is refused.
  - Undo for add = remove of the same list.
- `create_forum_post {forum (id|name), title ≤100, content?, embeds?, tags?: string[] (names or ids, ≤5, matched against the forum's available tags case-insensitively; unknown → refusal listing the available names)}`
  - kind `forum.post`, cap group `message`. Always public.
- `archive_thread` / `lock_thread {threadId, archived|locked: boolean}`
  - kind `thread.state`, cap group `structure`. Undo restores the previous state.
- Extend ADR 0115's daemon readability check: `privateThreadReadableFor` also returns true when `isMcpPrivateThread(scope, threadId)` is true (and this guild's cache or REST still knows the thread).
- Tests:
  - **private thread created via MCP is readable** with only the bot as a member;
  - its allowlist row exists, so a follow-up `send_message threadId` passes;
  - a forum tag that is unknown → refusal naming the available tags;
  - `invitable` defaults false;
  - a two-guild gate refusal;
  - kill switch;
  - replay;
  - `create_thread` in a forum → refusal pointing at `create_forum_post`.
- [ ] Step 1: tool tests → implement. Step 2: wiring tests → implement. Step 3: Gates. Commit per step.

---

### Task 6: Edit, delete, pins, reactions

**Files:** Create `packages/mcp/src/tools/message-writes.ts` + `.test.ts`, `apps/daemon/src/mcp/protected.ts` + `.test.ts`. Modify `packages/mcp/src/server.ts`, `packages/mcp/src/index.ts`, `apps/daemon/src/mcp/wiring.ts`, `apps/daemon/src/mcp/wiring.test.ts`.

**Interfaces:**
```ts
// apps/daemon/src/mcp/protected.ts
export const protectedMessageReason: (scope: GuildScope, messageId: string) => 'role-panel' | 'task-anchor' | undefined; // panels.message_id, task_message_anchors.message_id
```
- `edit_message {channel, messageId, content?, embeds?}`:
  - live `fetchMessageAuthor`: author ≠ bot → refusal `not-bot-authored`; gone → `not-found`; protected → refusal naming the kind;
  - kind `message.edit`, cap group `edit`;
  - `undo` = `{content, embeds}` of the previous version.
- `delete_message {channel, messageId}`: the same eligibility; kind `message.delete`, cap group `edit`; not undoable.
- `pin_message` / `unpin_message {channel, messageId}`:
  - any message in a send-scope target with need `pin`;
  - kind `message.pin|unpin`, cap group `pin_react`; the undo is the opposite.
- `add_reaction` / `remove_reaction {channel, messageId, emoji}`:
  - the bot's own reaction only; `emoji` is a unicode emoji or `name:id` for a guild emoji that exists in this guild's cache;
  - kind `reaction.add|remove`, cap group `pin_react`; the undo is the opposite.
- Tests:
  - **panel message refused**, **task anchor refused**, **member message refused**, each with zero Discord write calls;
  - an edit records undo content;
  - a delete is not undoable;
  - a pin needs ManageMessages (missing → refusal names it);
  - a reaction with a foreign guild's emoji → refusal;
  - a two-guild gate;
  - replay.
- [ ] Step 1: protected + tool tests → implement. Step 2: wiring tests → implement. Step 3: Gates. Commit per step.

---

### Task 7: `undo_action`, `list_actions`, task tools' scope, registration and smoke docs

**Files:**
- Create `packages/mcp/src/tools/actions.ts` + `.test.ts`, `packages/mcp/src/registration.test.ts`.
- Modify `packages/mcp/src/server.ts`, `packages/mcp/src/server.test.ts`, `packages/mcp/src/index.ts`, `packages/mcp/src/instructions.ts`, `packages/mcp/src/instructions.test.ts`, `apps/daemon/src/mcp/wiring.ts`, `apps/daemon/src/mcp/wiring.test.ts`, `docs/SMOKE_TESTS.md`.

- `undo_action {actionId}`:
  - finds the action; refuses when it has no `undo_json`, is already undone, failed, or was a dry run;
  - otherwise runs the inverse through `runMcpAction` with key `undo:<actionId>` and the original kind's inverse;
  - on `done` → `markUndone`.

  A replayed undo answers "already undone" with the undo's `actionId`.
- `list_actions {limit? ≤100}` (read scope): the newest MCP actions — kind, status, target ids, `undoable`, created time. No content. A structural read record.
- In `server.ts`, the task write tools (main's `hasSendScope(deps.principal) && deps.taskAdmin` block and any other task write registration) switch to `hasTasksScope` (ADR 0114 §, ADR 0101 follow-up). Read-only task tools stay under read.
- `registration.test.ts`:
  - for every scope combination (read, send, roles, tasks, and all subsets), the exact registered tool-name set;
  - every name is unique across registrars.
- `instructions.ts`: add a short "Writes" section — idempotency keys, dry run, undo, pings are explicit, private threads.
- `SMOKE_TESTS.md`: a live checklist for each new write tool on the test guild (not claimed from unit tests).
- [ ] Step 1: tests → implement. Step 2: Gates (full `npm run test`). Commit per step.

---

## Parallelism

Tasks 1, 2 and 3 touch disjoint files (storage / core effects + roles / discord port + testkit) and may run at the same time on separate branches. The controller merges them before Task 4. Task 4 depends on all three. Tasks 5 and 6 both edit `server.ts`, `index.ts` and `wiring.ts`, so they run one after the other unless the controller merges and resolves. Task 7 is last.

## Slice verification (controller)

In the oc worktree after the relink: `npm run typecheck`, then `npm run lint`, then `npm run test`, each run alone, each exit 0.
