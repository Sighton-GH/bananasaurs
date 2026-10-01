# MCP connector v2 — Slice 4: roles and panels — Implementation Plan

> Approved under the owner's 2026-09-29 auto-approval of all MCP v2 slices. Execute task-by-task with opencode-driven-development.

**Goal:** Let the owner do these from Claude:
- grant and remove roles;
- run bulk role changes with a preview and a confirmation;
- create and edit plain roles;
- manage self-assign role panels, using existing roles or new ones.

All of it goes through the existing role chokepoint, under the D1 grant policy and the dangerous-permission floor.

**Architecture:** ADR 0118. The MCP gets its own `EffectGateway` instance with injected policy, a breaker trip that does nothing, and an `mcp` rate bucket, so moderation code is not edited. Each call is an `mcp_actions` row through `runMcpAction` (slice 3). Bulk changes are stored previews (migration `0093`) plus one durable `mcp.bulk_role` job. Panels go through the shared ops commands.

**Spec:** §5.2, §6.1, §6.2. **ADR:** `docs/decisions/0118-mcp-role-changes-and-panels.md`, written before code. ADRs 0113–0117 bind.

**Depends on:** slice 3 merged into `worktree-mcp-connector-v2`. That gives `runMcpAction`, `mcp_actions`, `resolvePings` / `rolePingAllowed`, the actions deps factory, and the cap-group rename to `structure` plus the addition of `member_role`.

## Global Constraints

- Everything in slice 3's Global Constraints applies.
- Role changes reach Discord only through `EffectGateway.applyRoleEffect` (ADR 0014). Do not modify `packages/core/src/effects/gateway.ts`. The only change to `rate-limit.ts` is adding `'mcp'` to `EffectSource` (with its bucket configuration where the other sources' buckets are configured).
- Authorization: `authorize({ store, guildId, actor: { type: 'dashboard', id: principal.accountId, roleIds: [] } }, 'roles.mutate')`. A denial is a distinct refusal ("this account lacks roles.mutate"), never a fallback.
- The floor and the grant policy are checked live at call time, and for panels at creation and at edit.
- No permissions parameter anywhere. A created role's permissions are always `"0"`.
- Tools register under the `bananasaurs:roles` scope only (ADR 0114). `list_panels` / `get_panel` are reads (read scope).
- New CLI ops commands need a `CLI_WEB_PARITY` entry in `packages/dashboard/src/app/cli-parity.ts`:
  - `covered` if a dashboard control already does the same thing;
  - otherwise `exception` with a reason;
  - and keep `docs/webui-capability-map.md` in step.

## Review Focus

1. A role that gains ManageRoles after being allowlisted → refused before any Discord call (Task 3 "floor is live").
2. MCP rate overflow → refused, and the guild breaker stays closed (Task 2 "never trips").
3. An account without `roles.mutate` → refused, with no effect row (Task 3).
4. A bulk confirm with a tampered argument, an expired token, a reused token, or a token from another guild → each refused (Task 4).
5. The bulk job applies the previewed member set, not a fresh query (Task 4).
6. `create_role` cannot produce a role with any permission bit (Task 5).

---

### Task 1: Storage + port (migration 0093, role port methods)

**Files:**
- Storage: `packages/storage/src/schema.ts`, `packages/storage/src/index.ts`, `packages/storage/src/db.test.ts`; create `packages/storage/src/repos/mcp-bulk.ts` + `.test.ts`, `drizzle/0093_mcp_bulk_previews.sql` + snapshot, and the journal entry.
- Port: `packages/core/src/discord/port.ts`, `packages/discord/src/rest/port.ts` + `.test.ts`, `packages/testkit/src/fake-discord.ts` + `.test.ts`, and the stub doubles.

**Interfaces:**
- Table `mcp_bulk_previews(guild_id FK, preview_id text, token_hash text, action_kind 'add'|'remove', role_id snowflake, args_hash, member_ids_json, created_at, expires_at, consumed_at NULL, job_id NULL, UNIQUE(guild_id, preview_id), UNIQUE(guild_id, token_hash))`. Store the sha256 of the token, never the token itself.
- Repo functions: `createPreview`, `findPreviewByToken(scope, token)` (it hashes the token), `consumePreview(scope, previewId, jobId, now)`, which only succeeds when `consumed_at IS NULL` and `expires_at > now`.
- Port methods:
  - `createRole(guildId, { name, color?, hoist?, mentionable? })` → `{ roleId }`, always sending `permissions: '0'`;
  - `setRolePosition(guildId, roleId, position)`;
  - `editRole(guildId, roleId, { name?, color?, mentionable? })`.

  Verify routes and bodies against discord-api-types.

---

### Task 2: The MCP role chokepoint instance (daemon) + `EffectSource 'mcp'`

**Files:** `packages/core/src/effects/rate-limit.ts` (the source union and bucket configuration only), with its tests; create `apps/daemon/src/mcp/roles-gateway.ts` + `.test.ts`.

**Interfaces:**
- `mcpRoleGatewayFor(deps, client, discord, scope)` → an `EffectGateway` with:
  - `isRoleAllowlisted` = the grant policy (below-bot/allowlist plus the floor, live from the client cache);
  - `tripBreaker` = a no-op that logs a warning;
  - a rate limiter that includes the `mcp` bucket;
  - an audit port that writes `actor_type 'mcp_operator'`.
- Tests:
  - **never trips**: drive the bucket past its limit → `rate-cap` refusals, and the guild breaker is still closed;
  - grant policy: below-bot passes; above, managed, `@everyone` and dangerous are refused; allowlist mode;
  - the standard protected-target refusal still applies.

---

### Task 3: `grant_role` / `remove_role` + undo

**Files:** create `packages/mcp/src/tools/role-writes.ts` + `.test.ts`; modify `packages/mcp/src/server.ts`, `packages/mcp/src/index.ts`, `apps/daemon/src/mcp/wiring.ts` + `.test.ts`, `apps/daemon/src/mcp/actions.ts`.

- Params: `{guildId, member (id or name, via search_members' resolver), role (id or name), idempotencyKey, dryRun?}`.
- Behaviour:
  - runs as `runMcpAction` kind `role.grant` / `role.remove`, cap group `member_role`;
  - `execute` authorizes `roles.mutate` and calls the MCP gateway;
  - the gateway outcomes `skipped` and `no-change-needed` render as "already had / didn't have";
  - undo is the inverse.

  Extend Task 7 of slice 3's `undo_action` to dispatch the `role.*` inverses, and extend the registration test for the `roles` scope.
- Tests:
  - **floor is live**;
  - an account without `roles.mutate` is refused, with no `role_effects` row;
  - guild owner as target → protected;
  - two-guild gate;
  - replay;
  - undo.

---

### Task 4: `bulk_role_change` (preview → confirm → job)

**Files:** create `packages/mcp/src/tools/bulk-roles.ts` + `.test.ts`, `apps/daemon/src/jobs/mcp-bulk-role.ts` + `.test.ts`; modify the job registry the other job handlers use (find with `rg -n "registerJob|jobHandlers"` over `/home/bryan/projects/bananasaurs/.claude/worktrees/mcp-connector-v2/.oc-worktrees/oc/<branch>/apps/daemon/src`), plus the wiring and server files.

- Params: `{guildId, action: 'add'|'remove', role, members?: string[] (≤100) | selector?: {hasRoles?: string[], lacksRoles?: string[]}, confirmToken?, idempotencyKey}`.
- **Preview** (no token):
  - resolves the members live (selector through paginated `guild.members.list`, as `list_members` does);
  - refuses when there are more than 100, and says to narrow the set;
  - creates the preview;
  - returns the count, the first 20 display names, the token and the expiry.

  It writes no `mcp_actions` row; that happens at confirm.
- **Confirm:**
  - `findPreviewByToken` must match the guild, the args hash and the expiry;
  - `runMcpAction` kind `role.bulk`, cap group `member_role`; its cap check counts the member total by consulting `countSince` plus the member count;
  - `consumePreview` runs, and the `mcp.bulk_role` job is enqueued with payload `{guildId, previewId, actionId}`;
  - the result returns the job id, which `get_job` shows.
- **Job:**
  - iterates the stored member ids from a cursor through the MCP gateway (trigger ref `mcp-bulk:<actionId>:<memberId>`);
  - records per-member outcomes in the job result;
  - is resumable after a restart.
- Tests:
  - each item in Review Focus 4;
  - the job uses the previewed set even when membership changed after the preview;
  - the job resumes from its cursor;
  - 101 members → refusal.

---

### Task 5: `create_role` / `edit_role`

**Files:** extend `role-writes.ts` and its tests, plus the wiring.

- `create_role {name, color?, hoist?, mentionable?}`:
  - `createRole`, then `setRolePosition` to the bot's highest position minus one;
  - kind `role.create`, cap group `structure`; not undoable.
- `edit_role {role, name?, color?, mentionable?}`:
  - the role must pass the grant policy and the floor;
  - the undo record holds the previous values.
- Tests:
  - **permissions are always "0"** (assert the REST body), and the params schema has no permissions key;
  - the position lands directly below the bot;
  - editing a dangerous role is refused.

---

### Task 6: Panels — ops commands `panel edit` / `panel delete` + MCP panel tools

**Files:**
- `packages/core/src/ops/commands/` (create `panel-edit.ts` and `panel-delete.ts` with tests, following `panel-create.ts`; register them where the others are registered);
- `packages/dashboard/src/app/cli-parity.ts`, `docs/webui-capability-map.md`;
- create `packages/mcp/src/tools/panels.ts` + `.test.ts`;
- the wiring and server files.

- `list_panels` / `get_panel` (read scope) wrap `panel list` / `panel show`.
- `create_panel {channel, title, body, behaviour, component (per ADR 0054), options: [{role: id|name|{create:{name,color}}, label, emoji?}]}`:
  - creates the new roles first (as Task 5);
  - checks every role against the grant policy and the floor;
  - then `panel create` with a generated `panelId`, then `panel sync`.
  - Kind `panel.create`, cap group `structure`.
- `edit_panel {panelId, title?, body?, behaviour?, component?, addOptions?, removeOptions?, reorder?}` → `panel edit` + `panel sync`.
- `delete_panel {panelId}` → `panel delete` (removes the message and the panel rows; roles stay).
- Tests:
  - a dangerous role in the options → refused before any write;
  - a new role created in the panel → appears in `managed_roles`;
  - `edit_message` on a panel message is still refused (slice 3 protection);
  - the CLI parity test passes.

---

### Task 7: Registration, instructions, smoke docs

`registration.test.ts` gets the exact tool sets for the `roles` scope. `instructions.ts` gets a short "Roles" section: grant policy, floor, the bulk preview → confirm flow, and panels. `docs/SMOKE_TESTS.md` gets live checks for each role tool.

## Slice verification (controller)

`npm run typecheck`, then `npm run lint`, then `npm run test`, each run alone in the relinked oc worktree, each exit 0.
