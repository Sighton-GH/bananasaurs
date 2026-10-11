# Slice 2: New abilities — implementation plan

> **Instinct plan.** Read with `2026-10-10-harness-00-instinct-handoff.md` and `2026-10-10-harness-00-shared-contracts.md`.
> **Status:** READY (round 1)

**Goal:** The assistant resolves member names, looks members up, pings members and roles in replies under code control, posts scheduled messages as plain messages, manages club tasks for leads, and searches the web through Parallel as a third source.
**Spec:** docs/superpowers/specs/2026-10-09-assistant-harness-capability-design.md §4 Slice 2 (2a–2g), decisions D1, D3, D4(a), D11, §4.7
**ADRs:** 0145, 0146, 0147   **Migration:** parallel_search_source
**Base:** main @ 0371edc3

## Global Constraints

- `CLAUDE.md` hard rules 1–9 apply. In particular: AI is never in the enforcement path; every query, key and job carries a guild id; model output passes Zod; every Discord side effect has a durable idempotency key; no secrets in code, logs or fixtures; no new outbound destination unless the slice's ADR records the owner's instruction.
- No new dependency.
- Fixtures use invented names (Sam L, Alex P, Car Team A). Never a real member's name or id.
- Canadian English, plain words in prompts and dashboard copy. No tool names shown to members.
- Write the failing test first for anything touching permissions, pings, idempotency, retention or guild scope, and watch it fail before writing the code.
- Slice-specific constraints (exact values from the spec):
  - Reply pings: at most 5 members and 3 roles per reply; `@everyone` and `@here` never ping; inline code and fenced code spans are skipped (same `CODE_SPAN` parser as ADR 0128); a refused mention renders as plain text and pings nobody. Roles pass the ADR 0117 policy (`rolePingAllowed` in `packages/core/src/roles/dangerous.ts:87-98` via `checkRolePing` in `apps/daemon/src/mcp/targets.ts:260-295`); a non-mentionable role also needs the asker's Mention Everyone permission in the channel, as reminders do. Gated by the new `ping` skill (default everyone) and the asker's Send permission in the channel.
  - `find_member` returns up to 5 matches as `{ name, username, roles }`, never ids; read-only, any round.
  - `set_reminder` gains `style: "reminder" | "message"` (default `"reminder"`); `message` posts the text as is, without the "⏰" and "Set by" frame; same storage, delivery, ping checks, edit and cancel as reminders.
  - Task tools: `create_task` (title, details, team, assignees by name, due date; id deterministic from the invocation key, as MCP derives from `requestId`), `list_tasks` (read-only, the asker's teams), `task_progress` (a progress note on a task the asker is assigned to, reusing `recordReport`). Authority comes from `TaskContextPort.access(actorId)` (team lead or president), never `canManageTasks`.
  - Parallel: REST `POST https://api.parallel.ai/v1/search` with header `x-api-key` (never MCP); fixed body `{ objective, search_queries: [query], mode: "fast" }`, first 5 results; 5,000 free requests a month, then fast is $1 per 1,000; default monthly limit for a new Parallel key is 4,500; training disclosure per hard rule 5 (`trainsOnInput: "yes"`, Parallel customer terms §4(b)); `api.parallel.ai` is the new outbound destination, instructed by the owner 2026-10-10 (D11).
  - Files in contracts §4 are edited additively only: append to the end of lists, objects and unions; never reorder, reformat or rename; keep each edit small. Dashboard UI goes in new component files where a new surface is needed; existing pages change only to mount a component, except the small additive radio/row edits this plan names. Slice 6 runs in parallel: never touch `assistant_model_chain.pool`/`.tier`, key `project`/`fingerprint`, `assistant_key_cooldowns`, router files, or Slice 6 settings.
  - The migration is generated with `npm run db:generate -- --name parallel_search_source` after editing `packages/storage/src/schema.ts`. Never hand-number it. Only S2-T5 touches `schema.ts` or `drizzle/`.

## Plan decisions

- **How the capability block picks new tools up (no prompt-code change needed):** `buildCapabilityBlock` (`packages/core/src/assistant/capabilities.ts`) groups `TOOL_CATALOGUE` entries by `TOOL_GROUPS` using `offeredTools`, which `service.ts:1064-1081` sets to `declarations.map((d) => d.name)` from `toolDeclarations` (`apps/daemon/src/assistant/tools.ts:370-383`). `toolDeclarations` derives from the catalogue plus `skillAllowed(entry.requiresSkill/actsForSkill)` plus port presence. So a new tool appears in the capability block, in its group, once its catalogue entry (with `group`, `rounds`, `writes`, `requiresSkill` and a ≥120-character `Use when` description) exists, its skill gate passes, and its port is present. S2-T2 wires this; S2-T7 proves it with a test that `find_member`/`create_task`/`list_tasks`/`task_progress` render under their groups.
- **`tasks` skill default is `owner`, not leads:** `AssistantSkill.defaultScope` is `'everyone' | 'owner'` only (`packages/core/src/assistant/types.ts:47`), and `skills.test.ts:21` pins `acts → owner`. Team leads and the president get access two ways: the owner grants lead roles per guild on the Skills page (the D1 pattern), and every task-tool call additionally passes the code authority check `TaskContextPort.access(actorId)` (lead of the team, or president). A caller with skill scope but no team authority gets an actionable refusal, never a tool result.
- **`task_progress` is `rounds: 'returned-id'`:** `list_tasks` returns task ids as `handles` (the `edit_reminder`/`cancel_reminder` pattern from ADR 0137), so a progress note acts on a returned id and may run after round 1. `create_task` is `rounds: 'first'`, `writes: true`.
- **`create_task` destination is the current channel:** the spec names no destination field, so the task posts where it was asked for (`currentChannelId`); absent channel (Try-it) refuses with an actionable message. Assignee names resolve by exact case-insensitive display-name match through the same `findMember` port as `find_member` (reusing `resolveFromMember`'s rule in `service.ts:379-403`); zero or several matches without an exact one refuse.
- **2a covers the current message; channel context keeps flattening:** `sanitizeMentionsForProvider` gains an optional names map, used at `service.ts:1242` for the current question. `channel-context.ts:42-46` keeps calling it without names (signature stays backward compatible), so older channel lines still show `@user`/`@role` this slice; the speaker label already carries the display name.
- **Reply-ping matching is exact-match only:** `@Name` tokens (code spans stripped with the ADR 0128 `CODE_SPAN` regex) match a mentioned member/role by exact case-insensitive display-name equality, or a single `findMember` hit otherwise. No fuzzy matching: a near-miss renders as plain text and pings nobody.
- **Parallel response parsing is tolerant:** the exact upstream shape is unverified from the sandbox, so the Zod schema accepts `title`/`url` plus any of `content`/`excerpts[]`/`snippet`, takes the first 5 results, drops non-http(s) urls, strips tags, and caps each excerpt at 1,000 characters. The request body is exactly the spec's fixed shape (no invented ranking parameter).
- **Parallel dashboard monthly default is 4,500:** when the Parallel source is selected, the add-key monthly box pre-fills 4,500 (under the 5,000 free allowance); Brave/Tavily keep 1,000.
- **Parallel warnings are log + dashboard + PRIVACY.md, not doctor:** `doctor.ts` has no search-terms surface (verified: no search/eligibility matches), and contracts give Slice 6 the doctor line. The eligibility row drives the generic Terms card; a warn-level log fires when a Parallel run is built; the web-search card carries Parallel training copy like Tavily's.
- **Parallel eligibility row is seeded in the migration:** following the `drizzle/0022_brainy_meteorite.sql` precedent and ruling M4-D16 (eligibility claims change by migration), S2-T5 appends one `INSERT INTO provider_eligibility` for `parallel` (`trains_on_input 'yes'`, clause `Parallel customer terms §4(b)…`, `production_use_allowed` 1 — allowed by owner decision D11 with disclosure, the D12 pattern). The Terms page stays editable so the owner can correct the evidence URL.
- **`style` is immutable after creation:** `edit_reminder` does not change it (spec names no edit path); `my_reminders` shows it so both kinds are distinguishable.
- **No Parallel attribution line:** only Brave results carry a `-# Powered by` line (ADR 0120 §7); Parallel answers get the once-per-request may-train log warn, mirroring the Tavily block at `service.ts:1349-1361`.

## Review Focus

1. **A non-lead member asks to create a task.** Expect `create_task` refused with what to do next ("Only a team lead or the president can create tasks…"), and no task row. Pinned in S2-T7, with a break-it step (drop the `access` check, watch the refusal test fail, restore).
2. **The model writes `@Sam L` for someone the asker never mentioned or named.** Expect plain text, no `<@id>`, nothing in `allowedMentions.users`. Pinned in S2-T9, with a break-it step (skip the mentioned-or-named filter, watch the no-ping test fail, restore).
3. **A role above the bot or with a dangerous permission is named in the answer.** Expect `checkRolePing` to refuse (`role-above-bot` / `role-dangerous`), plain text, no ping. Pinned in S2-T9.
4. **A retry re-posts the assistant reply.** Expect the staged cursor (`partsPosted`/`postedMessageIds` in `jobs/assistant.ts`) to resume without re-posting, with identical `allowedMentions`. Pinned in S2-T9.
5. **A Parallel key at its monthly limit, then a Brave key.** Expect the Parallel reservation to skip before any HTTP call and the search to succeed on the next source's keys only if the configured source is Parallel with its own keys — keys never cross sources. Pinned in S2-T8.

## Waves

| Wave | Task | Owns (create/modify) | Depends on |
|---|---|---|---|
| 1 | S2-T1 ADRs 0145–0147 | Create: `docs/decisions/0145-*.md`, `0146-*.md`, `0147-*.md` | — |
| 2 | S2-T2 Catalogue groups, four tools, ping/tasks skills | Modify: `packages/core/src/assistant/tool-catalogue.ts`, `packages/core/src/assistant/skills.ts`, `packages/core/src/assistant/tool-catalogue.test.ts`, `packages/core/src/assistant/skills.test.ts` | T1 |
| 2 | S2-T3 Mention names in the provider text | Modify: `apps/daemon/src/assistant/mentions.ts`; Create: `apps/daemon/src/assistant/mentions.test.ts` | T1 |
| 2 | S2-T4 Parallel REST connector | Create: `apps/daemon/src/assistant/parallel-search.ts`, `apps/daemon/src/assistant/parallel-search.test.ts` | T1 |
| 3 | S2-T5 Storage: style column, source CHECKs, migration, eligibility seed | Modify: `packages/storage/src/schema.ts`, `packages/storage/src/repos/assistant.ts`, `packages/storage/src/repos/search-keys.ts`, `packages/core/src/assistant/reminders.ts`; Create: `drizzle/0*_parallel_search_source.sql`, `packages/storage/src/repos/slice2-storage.test.ts` | T1 |
| 3 | S2-T6 Ping-cap settings and tuning test | Modify: `packages/core/src/settings/instance-settings.ts`, `packages/core/src/settings/instance-settings.test.ts`, `packages/dashboard/src/pages/assistant-tuning.test.tsx` | T1 |
| 4 | S2-T7 Task tools + find_member implementation and service wiring | Modify: `apps/daemon/src/assistant/tools.ts`, `apps/daemon/src/assistant/tools.test.ts`, `apps/daemon/src/assistant/service.ts`, `apps/daemon/src/assistant/service.test.ts`, `apps/daemon/src/assistant/capability-fixtures.ts`, `apps/daemon/src/assistant/capability-fixtures.test.ts`, `apps/daemon/src/runtime/guild.ts` | T2, T5 |
| 4 | S2-T8 Parallel wiring: source union, clients, routes, dashboard | Modify: `apps/daemon/src/assistant/web-search.ts`, `apps/daemon/src/assistant/provider-config.ts`, `apps/daemon/src/assistant/provider-config.test.ts`, `apps/daemon/src/assistant/tool-loop.ts`, `apps/daemon/src/assistant/tool-loop.test.ts`, `packages/http/src/routes/assistant.ts`, `packages/http/src/routes/assistant-search-keys.ts`, `packages/http/src/routes/assistant-search-keys.test.ts`, `packages/dashboard/src/api/assistant.ts`, `packages/dashboard/src/pages/providers.tsx`, `packages/dashboard/src/pages/providers.test.tsx`, `packages/dashboard/src/pages/assistant-skills.tsx`, `packages/dashboard/src/pages/assistant-skills.test.tsx` | T4, T5 |
| 5 | S2-T9 Reply pings from answer text | Modify: `packages/core/src/jobs/kinds.ts`, `apps/daemon/src/assistant/commands.ts`, `apps/daemon/src/assistant/commands.test.ts`, `apps/daemon/src/assistant/service.ts`, `apps/daemon/src/assistant/service.test.ts`, `apps/daemon/src/runtime/guild.ts`, `apps/daemon/src/jobs/assistant.ts`, `apps/daemon/src/jobs/assistant.test.ts`, `packages/core/src/discord/port.ts`; Create: `apps/daemon/src/assistant/reply-pings.ts`, `apps/daemon/src/assistant/reply-pings.test.ts` | T2, T6 |
| 5 | S2-T10 Scheduled-message style | Modify: `apps/daemon/src/assistant/tools.ts`, `apps/daemon/src/assistant/tools.test.ts`, `apps/daemon/src/assistant/reminder-delivery.ts`, `apps/daemon/src/assistant/reminder-delivery.test.ts` | T5, T7 |
| 6 | S2-T11 Gates, STATE.md, PRIVACY.md, spec ledger | Modify: `docs/STATE.md`, `PRIVACY.md`, `docs/superpowers/specs/2026-10-09-assistant-harness-capability-design.md` | T9, T10 |

## Tasks

### S2-T1: ADRs 0145, 0146 and 0147   ·   Wave 1
**Owns:** Create: `docs/decisions/0145-member-names-find-member-reply-pings-scheduled-style.md`, `docs/decisions/0146-assistant-task-tools.md`, `docs/decisions/0147-parallel-web-search-source.md`
**Reads (do not edit):** `docs/decisions/0137-read-only-tools-in-later-rounds.md` (style model), `docs/superpowers/specs/2026-10-09-assistant-harness-capability-design.md` §4 Slice 2
**Interfaces:** Consumes: none · Produces: ADR numbers 0145/0146/0147 and the decisions S2-T2–S2-T11 cite

- [ ] **Step 1: Write ADR 0145**

```markdown
# 0145. Member names, find_member, reply pings, scheduled-message style

Date: 2026-10-11

Status: accepted (owner decisions D1, D3, 2026-10-10).

## Context
`<@id>` reached the provider as the literal `@user` (`apps/daemon/src/assistant/mentions.ts:7-11`), so "remind @Sam" arrived as "remind @user". The assistant had no member lookup, its reply could never ping (`allowedMentions` fixed to `{ parse: [] }`), and a scheduled post always carried the reminder frame.

## Decision
1. `sanitizeMentionsForProvider` renders `@Sam L` / `@Car Team A` from guild display names through `safeDisplayName`; unknown ids keep `@user` / `@role`; snowflakes never leave the process.
2. New read-only tool `find_member` (any round): up to 5 matches as `{ name, username, roles }`, never ids.
3. Reply pings (D3): the model writes `@Name` in its answer; deterministic code replaces tokens matching a member or role the asker mentioned or named with `<@id>` / `<@&id>` in `allowedMentions.users` / `.roles`. At most 5 members and 3 roles (settings `assistant.pingMaxMembers`, `assistant.pingMaxRoles`); roles pass the ADR 0117 policy, non-mentionable roles also need the asker's Mention Everyone; `@everyone`/`@here` never ping; code spans skipped with the ADR 0128 `CODE_SPAN` parser; refused mentions stay plain text. Gated by the `ping` skill (default everyone) and the asker's Send permission. Idempotent through the reply's existing durable key.
4. `set_reminder` gains `style: "reminder" | "message"` (default `"reminder"`); `message` posts the text as is, without the "⏰" and "Set by" frame, on the same storage, delivery, ping checks, edit and cancel. This amends the "only reminder delivery may set users" comment in `packages/core/src/discord/port.ts:103-109`.

## Consequences
- No new outbound destination. Skill defaults: `ping` everyone; reminders unchanged (D1, owner grants per guild).
```

- [ ] **Step 2: Write ADR 0146**

```markdown
# 0146. Assistant task tools for team leads and the president

Date: 2026-10-11

Status: accepted (owner decision D4a, 2026-10-10).

## Context
"Can you create tasks?" was refused: no task tool existed. UHill has no teams, so team-scoped creation is the whole surface for now.

## Decision
1. New acting skill `tasks` (default owner; the owner grants lead roles per guild). Tools: `create_task` (first round, writes), `list_tasks` (any round, read-only, task ids as handles), `task_progress` (returned-id round, writes).
2. Authority is `TaskContextPort.access(actorId)` — team lead of the task's team, or the president — never `canManageTasks`, which keys on a dashboard account. Skill scope and team authority must both pass.
3. `create_task` takes title, details, team, assignees by display name (exact match only) and an ISO due date, posting in the current channel. Its id is deterministic from the invocation key plus a content hash (the `contentKey` pattern in `apps/daemon/src/assistant/tools.ts:427-428`), the same duplicate rule MCP's `requestId` gives `create_club_task`. `task_progress` reuses `recordReport` with a deterministic report id.
4. The reply's confirmation line is built by code, as for reminders.

## Consequences
- No new scheduler, no new table. A non-lead gets an actionable refusal; nothing is written.
```

- [ ] **Step 3: Write ADR 0147**

```markdown
# 0147. Parallel as a third web-search source

Date: 2026-10-11

Status: accepted (owner request and decision D11, 2026-10-10: fast mode, training disclosure accepted).

## Context
Web search runs Brave or Tavily through one `WebSearchRun` shape (ADR 0120). The owner asked for Parallel as one more source beside them.

## Decision
1. REST, not MCP: `POST https://api.parallel.ai/v1/search` with header `x-api-key`; fixed body `{ objective, search_queries: [query], mode: "fast" }`, first 5 results mapped to `WebResult` with each excerpt capped at 1,000 characters. The `objective` is the model's query through the same local query scan; no member text is added.
2. Fits ADR 0120 unchanged in shape: `search_source` gains `parallel`; keys live in `assistant_search_keys` with the same sealed storage, ordering, limits and reserve-before-send. Default monthly limit for a new Parallel key is 4,500 (under the 5,000 free allowance; fast is $1 per 1,000 after that).
3. Hard rule 5: provider-eligibility row `parallel` with `trainsOnInput: "yes"` (customer terms §4(b): Parallel may use queries to train), cited clause and review date; warnings in the log and dashboard, plus a PRIVACY.md line. Queries are model search terms (member names already forbidden), not member messages.
4. Hard rule 8: `api.parallel.ai` is a new outbound destination on the owner's 2026-10-10 instruction, recorded here.

## Consequences
- One migration widening the `search_source` CHECKs. Doctor has no search-terms surface, so it is unchanged; Slice 6 owns the doctor line.
```

- [ ] **Step 4: Verify numbers and titles** — `ls docs/decisions/0145-* docs/decisions/0146-* docs/decisions/0147-*` shows three files; `rg -n "0145|0146|0147" docs/superpowers/plans/2026-10-10-harness-00-shared-contracts.md` matches this plan's ADR table. Expected: all present, no other slice renumbered.
- [ ] **Step 5: Typecheck** — `npx tsc --build` · Expected: exit 0 (docs only; proves nothing else broke)
- [ ] **Step 6: Format and lint** — `npx prettier --write docs/decisions/0145-member-names-find-member-reply-pings-scheduled-style.md docs/decisions/0146-assistant-task-tools.md docs/decisions/0147-parallel-web-search-source.md` then `npx eslint docs/decisions/0145-member-names-find-member-reply-pings-scheduled-style.md docs/decisions/0146-assistant-task-tools.md docs/decisions/0147-parallel-web-search-source.md` · exit 0
- [ ] **Step 7: Commit** — `git add docs/decisions/0145-member-names-find-member-reply-pings-scheduled-style.md docs/decisions/0146-assistant-task-tools.md docs/decisions/0147-parallel-web-search-source.md && git commit -m "Slice 2 T1: ADRs 0145 member names and pings, 0146 task tools, 0147 Parallel source"`

**Done when:** three ADR files exist with Context/Decision/Consequences; contracts ADR table matches; gates pass.

---

### S2-T2: Catalogue groups, four new tools, ping and tasks skills   ·   Wave 2
**Owns:** Modify: `packages/core/src/assistant/tool-catalogue.ts`, `packages/core/src/assistant/skills.ts`, `packages/core/src/assistant/tool-catalogue.test.ts`, `packages/core/src/assistant/skills.test.ts`
**Reads (do not edit):** `packages/core/src/assistant/capabilities.ts` (`buildCapabilityBlock` grouping), `apps/daemon/src/assistant/tools.ts:370-383` (`toolDeclarations` derivation)
**Interfaces:** Consumes: none · Produces: `ToolGroupId` gains `'tasks'`; `TOOL_GROUPS` gains the tasks row; `TOOL_CATALOGUE` gains `find_member | create_task | list_tasks | task_progress`; `RETURNED_ID_ARGS` gains `task_progress: ['taskId']`; `CLUB_ASSISTANT_SKILLS` gains `ping` and `tasks` (exact shapes below, for S2-T7's gates)

- [ ] **Step 1: Write the failing tests** — in `tool-catalogue.test.ts`, extend the four pinned tests:
  - names list: append `'find_member', 'create_task', 'list_tasks', 'task_progress'` after `'channel_history'`;
  - rounds test: add `'find_member', 'list_tasks'` to the `'all'` list, `'task_progress'` to `'returned-id'`, `'create_task'` to `'first'`;
  - writers test: expect `['cancel_reminder', 'create_task', 'edit_reminder', 'propose_decision', 'propose_memory', 'set_reminder', 'task_progress']`;
  - returned-id map test: add `task_progress: ['taskId']`;
  - add:

```ts
it('gates the new tools behind fitting groups and skills (ADR 0145, 0146)', () => {
  const byName = new Map(TOOL_CATALOGUE.map((e) => [e.name, e]));
  expect(byName.get('find_member')).toMatchObject({ group: 'server', rounds: 'all' });
  expect(byName.get('find_member')?.requiresSkill).toBeUndefined();
  expect(byName.get('create_task')).toMatchObject({ group: 'tasks', rounds: 'first', writes: true, requiresSkill: 'tasks', actsForSkill: 'tasks' });
  expect(byName.get('list_tasks')).toMatchObject({ group: 'tasks', rounds: 'all', requiresSkill: 'tasks', actsForSkill: 'tasks' });
  expect(byName.get('task_progress')).toMatchObject({ group: 'tasks', rounds: 'returned-id', writes: true, requiresSkill: 'tasks', actsForSkill: 'tasks' });
  expect(TOOL_GROUPS.find((g) => g.id === 'tasks')?.label).toBe('Club tasks');
});
```

  In `skills.test.ts` add:

```ts
it('has a non-acting ping skill open to everyone and an acting tasks skill owned by default (ADR 0145, 0146)', () => {
  const ping = CLUB_ASSISTANT_SKILLS.find((x) => x.id === 'ping');
  expect(ping).toMatchObject({ acts: false, defaultScope: 'everyone', effect: 'send', name: 'Ping members and roles' });
  const tasks = CLUB_ASSISTANT_SKILLS.find((x) => x.id === 'tasks');
  expect(tasks).toMatchObject({ acts: true, defaultScope: 'owner', effect: 'schedule', name: 'Club tasks' });
  expect(STARTER_SKILL_IDS).toContain('ping');
  expect(STARTER_SKILL_IDS).not.toContain('tasks');
});
```

  (`STARTER_SKILL_IDS` is already imported in that file's scope per `skills.ts:157-159`; if the import is missing, add it — the symbol exists.)

- [ ] **Step 2: Run it and watch it fail** — `npx vitest run packages/core/src/assistant/tool-catalogue.test.ts packages/core/src/assistant/skills.test.ts --maxWorkers=1` · Expected: FAIL (unknown tools/skills)
- [ ] **Step 3: Implement** — in `tool-catalogue.ts`:
  - `ToolGroupId` union gains `| 'tasks'`; append `{ id: 'tasks', label: 'Club tasks', description: 'create tasks in existing teams, list the open ones and record progress notes; team leads and the president only' }` to the end of `TOOL_GROUPS`; extend the `server` row description to `"the server's channels, members and upcoming events"`.
  - Append four entries to the end of `TOOL_CATALOGUE` (descriptions verbatim; each is ≥120 characters and contains "Use" + a when-clause, satisfying the 1b shape test):

```ts
{
  name: 'find_member',
  description:
    "Look up a club member by name, username or mention, returning up to 5 matches with display name, username and role names. Use it when a member names someone you need to tell apart, or before claiming anything about who someone is. It never returns ids; later tools take names and code resolves them. Example: 'remind Sam at 23:00' becomes find_member with name 'Sam', then set_reminder with members: [\"Sam L\"].",
  parameters: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'The name, username or mention to look up.', minLength: 1, maxLength: 100 },
    },
    required: ['name'],
  },
  rounds: 'all',
  outputLimit: RESULT_LIMIT,
  skills: ['search-club'],
  group: 'server',
},
{
  name: 'create_task',
  description:
    "Create a club task inside an existing team, assigned to members by display name with a due date. Use it when a team lead or the president asks for something to be made, tracked and nudged. Only team leads and the president can use it; anyone else is refused. Example: 'task the site team to fix the charger by Friday' becomes title 'Fix the charger', team '<teamId>', assignees: [\"Sam L\"], due '2026-10-17T17:00:00-07:00'.",
  parameters: {
    type: 'object',
    properties: {
      title: { type: 'string', description: 'The task title.', minLength: 1, maxLength: 180 },
      details: { type: 'string', description: 'What needs doing, in a few sentences.', maxLength: 5000 },
      team: { type: 'string', description: 'The team id from list_tasks or the task context.', minLength: 1, maxLength: 128 },
      assignees: { type: 'array', description: 'Display names to assign (at most 25).', items: { type: 'string' }, maxItems: 25 },
      due: { type: 'string', description: 'Due date, ISO 8601 with its UTC offset.' },
    },
    required: ['title', 'team', 'due'],
  },
  rounds: 'first',
  outputLimit: RESULT_LIMIT,
  skills: ['tasks'],
  actsForSkill: 'tasks',
  group: 'tasks',
  requiresSkill: 'tasks',
  writes: true,
},
{
  name: 'list_tasks',
  description:
    "The asking member's teams and their open tasks, with ids for task_progress. Use it when a member asks what tasks exist, what is due, or before recording progress on one. Only team members, team leads and the president see anything; anyone else is refused.",
  parameters: {
    type: 'object',
    properties: {
      team: { type: 'string', description: 'Only this team id.', minLength: 1, maxLength: 128 },
      includeDone: { type: 'boolean', description: 'Also list finished tasks.' },
    },
    required: [],
  },
  rounds: 'all',
  outputLimit: RESULT_LIMIT,
  skills: ['tasks'],
  actsForSkill: 'tasks',
  group: 'tasks',
  requiresSkill: 'tasks',
},
{
  name: 'task_progress',
  description:
    'Record a short progress note on one open task by its id from list_tasks. Use it when a member says what got done, what is blocked, or gives an update on their task. Only someone assigned to the task, its team lead or the president can use it.',
  parameters: {
    type: 'object',
    properties: {
      taskId: { type: 'string', description: 'The task id from list_tasks.', minLength: 1, maxLength: 128 },
      note: { type: 'string', description: 'The progress note.', minLength: 1, maxLength: 5000 },
    },
    required: ['taskId', 'note'],
  },
  rounds: 'returned-id',
  outputLimit: RESULT_LIMIT,
  skills: ['tasks'],
  actsForSkill: 'tasks',
  group: 'tasks',
  requiresSkill: 'tasks',
  writes: true,
},
```

  - `ID_ARG_NAMES` gains `task_progress: ['taskId']`.
  - In `skills.ts`, append after `draft-handoff`:

```ts
{
  id: 'ping',
  name: 'Ping members and roles',
  description: 'Ping members or roles the asker named by writing @Name in the answer; code decides who pings.',
  promptLine: 'Ping a member or role the asker named by writing @Name in the answer; only people and roles they mentioned or named ever ping.',
  effect: 'send',
  requiredPermission: 'assistant.communications',
  acts: false,
  defaultScope: 'everyone',
  requiresConfirmation: false,
},
{
  id: 'tasks',
  name: 'Club tasks',
  description: 'Create, list and update club tasks for team leads and the president.',
  promptLine: 'Make, list and update club tasks for team leads and the president; refuse anyone else plainly.',
  effect: 'schedule',
  requiredPermission: 'assistant.organise',
  acts: true,
  defaultScope: 'owner',
  requiresConfirmation: false,
},
```

- [ ] **Step 4: Run it and watch it pass** — same command · Expected: PASS
- [ ] **Step 5: Typecheck** — `npx tsc --build` · Expected: exit 0
- [ ] **Step 6: Format and lint** — `npx prettier --write packages/core/src/assistant/tool-catalogue.ts packages/core/src/assistant/skills.ts packages/core/src/assistant/tool-catalogue.test.ts packages/core/src/assistant/skills.test.ts` then `npx eslint packages/core/src/assistant/tool-catalogue.ts packages/core/src/assistant/skills.ts packages/core/src/assistant/tool-catalogue.test.ts packages/core/src/assistant/skills.test.ts` · exit 0
- [ ] **Step 7: Commit** — `git add packages/core/src/assistant/tool-catalogue.ts packages/core/src/assistant/skills.ts packages/core/src/assistant/tool-catalogue.test.ts packages/core/src/assistant/skills.test.ts && git commit -m "Slice 2 T2: tasks group, find_member and task tools, ping and tasks skills"`

**Done when:** catalogue names/rounds/writers/returned-id tests pass with the four new tools; every new description passes the ≥120/`Use when` shape test; `ping` in starter ids, `tasks` owner-default.

---

### S2-T3: Mention names in the provider text   ·   Wave 2
**Owns:** Modify: `apps/daemon/src/assistant/mentions.ts`; Create: `apps/daemon/src/assistant/mentions.test.ts`
**Reads (do not edit):** `apps/daemon/src/assistant/service.ts:1242` (call site), `apps/daemon/src/assistant/channel-context.ts:42-46` (second call site), `packages/core/src/assistant/untrusted.ts:24-32` (`safeDisplayName`)
**Interfaces:** Consumes: none · Produces: `export const sanitizeMentionsForProvider = (text: string, names?: MentionNames) => string` with `export interface MentionNames { readonly users?: ReadonlyMap<string, string> | undefined; readonly roles?: ReadonlyMap<string, string> | undefined }` (for S2-T9's candidate wiring; callers without names keep today's output byte-for-byte)

- [ ] **Step 1: Write the failing test** — `apps/daemon/src/assistant/mentions.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { sanitizeMentionsForProvider } from './mentions.js';

const U_SAM = '456789012345678901';
const U_UNKNOWN = '567890123456789012';
const R_CAR = '678901234567890123';
const R_UNKNOWN = '789012345678901234';
const names = {
  users: new Map([[U_SAM, 'Sam L']]),
  roles: new Map([[R_CAR, 'Car Team A']]),
};

describe('sanitizeMentionsForProvider (ADR 0145)', () => {
  it('renders known members and roles by display name', () => {
    expect(sanitizeMentionsForProvider(`remind <@${U_SAM}> and <@&${R_CAR}>`, names)).toBe(
      'remind @Sam L and @Car Team A',
    );
  });
  it('keeps @user and @role for unknown ids', () => {
    expect(sanitizeMentionsForProvider(`hi <@${U_UNKNOWN}> <@&${R_UNKNOWN}>`, names)).toBe(
      'hi @user @role',
    );
  });
  it('without names keeps today’s flattening byte-for-byte', () => {
    expect(sanitizeMentionsForProvider(`remind <@!${U_SAM}> in <#111111111111111111>`)).toBe(
      'remind @user in #channel',
    );
  });
  it('cleans member-controlled names through the display-name sanitiser', () => {
    const evil = { users: new Map([[U_SAM, '  Sam\nL]  ']]), roles: new Map() };
    expect(sanitizeMentionsForProvider(`<@${U_SAM}>`, evil)).toBe('@Sam L');
  });
  it('leaves bare numbers alone for the outbound scan', () => {
    expect(sanitizeMentionsForProvider('call 456789012345678901 now', names)).toBe(
      'call 456789012345678901 now',
    );
  });
});
```

- [ ] **Step 2: Run it and watch it fail** — `npx vitest run apps/daemon/src/assistant/mentions.test.ts --maxWorkers=1` · Expected: FAIL (module has no second parameter; unknown ids already `@user`/`@role` but known ids do not render)
- [ ] **Step 3: Implement** — replace `apps/daemon/src/assistant/mentions.ts` content (keeping the header comment, extended with one line: "With a names map, known users and roles render as `@Name` through `safeDisplayName`; unknown ids keep the old tokens."):

```ts
import { safeDisplayName } from '@bananasaurs/core';

export interface MentionNames {
  readonly users?: ReadonlyMap<string, string> | undefined;
  readonly roles?: ReadonlyMap<string, string> | undefined;
}

const namedOr = (raw: string | undefined, fallback: string): string =>
  `@${safeDisplayName(raw) ?? fallback}`;

export const sanitizeMentionsForProvider = (text: string, names?: MentionNames): string =>
  text
    .replace(/<@&(\d{17,20})>/g, (_match, id: string) => namedOr(names?.roles?.get(id), 'role'))
    .replace(/<@!?(\d{17,20})>/g, (_match, id: string) => namedOr(names?.users?.get(id), 'user'))
    .replace(/<#\d{17,20}>/g, '#channel');
```

- [ ] **Step 4: Run it and watch it pass** — `npx vitest run apps/daemon/src/assistant/mentions.test.ts apps/daemon/src/assistant/channel-context.test.ts apps/daemon/src/assistant/service.test.ts --maxWorkers=1` · Expected: PASS (both existing call sites pass no names, so their output is unchanged)
- [ ] **Step 5: Typecheck** — `npx tsc --build` · Expected: exit 0
- [ ] **Step 6: Format and lint** — `npx prettier --write apps/daemon/src/assistant/mentions.ts apps/daemon/src/assistant/mentions.test.ts` then `npx eslint apps/daemon/src/assistant/mentions.ts apps/daemon/src/assistant/mentions.test.ts` · exit 0
- [ ] **Step 7: Commit** — `git add apps/daemon/src/assistant/mentions.ts apps/daemon/src/assistant/mentions.test.ts && git commit -m "Slice 2 T3: mention ids render as display names with a names map"`

**Done when:** known ids render `@Sam L` / `@Car Team A`; unknown ids keep old tokens; bare numbers untouched; existing service/channel-context tests green.

---

### S2-T4: Parallel REST connector   ·   Wave 2
**Owns:** Create: `apps/daemon/src/assistant/parallel-search.ts`, `apps/daemon/src/assistant/parallel-search.test.ts`
**Reads (do not edit):** `apps/daemon/src/assistant/tavily-search.ts:27-73` (request/response/error shape to mirror), `apps/daemon/src/assistant/tools.ts:62-66` (`WebResult`), `apps/daemon/src/assistant/web-search.ts:22-28` (`SearchHttpError`)
**Interfaces:** Consumes: none · Produces: `export const parallelWebSearch = (options: { readonly apiKey: string; readonly fetch?: typeof globalThis.fetch; readonly timeoutMs?: number }, query: string) => Promise<readonly WebResult[]>` (for S2-T8's client selection)

- [ ] **Step 1: Write the failing test** — `apps/daemon/src/assistant/parallel-search.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import { SearchHttpError } from './web-search.js';
import { parallelWebSearch } from './parallel-search.js';

const fetchOk = (body: unknown) =>
  vi.fn(async () => new Response(JSON.stringify(body), { status: 200 }));

describe('parallelWebSearch (ADR 0147)', () => {
  it('posts the fixed fast-mode body with the x-api-key header and maps excerpts', async () => {
    const fetchImpl = fetchOk({
      results: [
        { title: 'TRIUMF <b>tours</b>', url: 'https://triumf.example/visit', excerpts: ['Grade 9 <i>welcome</i>', 'second line'] },
        { title: 'Other', url: 'https://other.example/', content: 'plain content here' },
        { title: 'Nope', url: 'ftp://nope.example/' },
      ],
    });
    const results = await parallelWebSearch({ apiKey: 'p-key', fetch: fetchImpl }, 'TRIUMF tour grade 9');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.parallel.ai/v1/search');
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>)['x-api-key']).toBe('p-key');
    expect(JSON.parse(init.body as string)).toEqual({
      objective: 'TRIUMF tour grade 9',
      search_queries: ['TRIUMF tour grade 9'],
      mode: 'fast',
    });
    expect(results).toEqual([
      { title: 'TRIUMF tours', url: 'https://triumf.example/visit', description: 'Grade 9 welcome second line' },
      { title: 'Other', url: 'https://other.example/', description: 'plain content here' },
    ]);
  });
  it('caps each excerpt at 1,000 characters and keeps the first 5 results', async () => {
    const fetchImpl = fetchOk({
      results: [0, 1, 2, 3, 4, 5, 6].map((i) => ({ title: `t${i}`, url: `https://e.example/${i}`, content: 'x'.repeat(2000) })),
    });
    const results = await parallelWebSearch({ apiKey: 'p-key', fetch: fetchImpl }, 'q');
    expect(results).toHaveLength(5);
    for (const r of results) expect(r.description.length).toBeLessThanOrEqual(1000);
  });
  it('throws SearchHttpError on a refused status and a fixed error on a bad body', async () => {
    const refused = vi.fn(async () => new Response('no', { status: 429 }));
    await expect(parallelWebSearch({ apiKey: 'k', fetch: refused }, 'q')).rejects.toMatchObject({ name: 'SearchHttpError', status: 429 });
    const bad = fetchOk({ nope: true });
    await expect(parallelWebSearch({ apiKey: 'k', fetch: bad }, 'q')).rejects.toThrow(
      'Parallel returned an invalid response',
    );
  });
  it('never logs or returns the key', async () => {
    const fetchImpl = fetchOk({ results: [] });
    await parallelWebSearch({ apiKey: 'super-secret-parallel-key', fetch: fetchImpl }, 'q');
    expect(JSON.stringify(fetchImpl.mock.calls)).not.toContain('super-secret-parallel-key');
  });
});
```

  (The last assertion holds because the key travels only in the header object; if the implementation ever interpolates it into the url or body, this fails.)

- [ ] **Step 2: Run it and watch it fail** — `npx vitest run apps/daemon/src/assistant/parallel-search.test.ts --maxWorkers=1` · Expected: FAIL (module missing)
- [ ] **Step 3: Implement** — `apps/daemon/src/assistant/parallel-search.ts`, mirroring `tavily-search.ts`:

```ts
import { z } from 'zod';
import type { WebResult } from './tools.js';
import { SearchHttpError } from './web-search.js';

/**
 * The Parallel Search API (ADR 0147). The third outbound web-search
 * destination. Results are held only for the request that asked; nothing
 * here stores them. The key is only ever in the `x-api-key` header.
 */
const ENDPOINT = 'https://api.parallel.ai/v1/search';

/** Same strip as `brave-search.ts`: the model only needs the text. */
const stripTags = (text: string): string => text.replace(/<[^>]*>/g, '');

const parallelResponse = z.object({
  results: z
    .array(
      z.object({
        title: z.string().optional(),
        url: z.string().optional(),
        content: z.string().optional(),
        snippet: z.string().optional(),
        excerpts: z.array(z.string()).optional(),
      }),
    )
    .default([]),
});

export const parallelWebSearch = async (
  options: {
    readonly apiKey: string;
    readonly fetch?: typeof globalThis.fetch;
    readonly timeoutMs?: number;
  },
  query: string,
): Promise<readonly WebResult[]> => {
  const response = await (options.fetch ?? globalThis.fetch)(ENDPOINT, {
    method: 'POST',
    headers: {
      'x-api-key': options.apiKey,
      'content-type': 'application/json',
      accept: 'application/json',
    },
    body: JSON.stringify({ objective: query, search_queries: [query], mode: 'fast' }),
    signal: AbortSignal.timeout(options.timeoutMs ?? 10_000),
  });
  if (!response.ok) throw new SearchHttpError(response.status);
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new Error('Parallel returned an invalid response');
  }
  const parsed = parallelResponse.safeParse(body);
  if (!parsed.success) throw new Error('Parallel returned an invalid response');
  return parsed.data.results.slice(0, 5).flatMap((result) =>
    result.url === undefined || !/^https?:\/\//.test(result.url)
      ? []
      : [
          {
            title: stripTags(result.title ?? result.url),
            url: result.url,
            description: stripTags(
              result.content ?? result.excerpts?.join(' ') ?? result.snippet ?? '',
            ).slice(0, 1000),
          },
        ],
  );
};
```

- [ ] **Step 4: Run it and watch it pass** — same command · Expected: PASS
- [ ] **Step 5: Typecheck** — `npx tsc --build` · Expected: exit 0
- [ ] **Step 6: Format and lint** — `npx prettier --write apps/daemon/src/assistant/parallel-search.ts apps/daemon/src/assistant/parallel-search.test.ts` then `npx eslint apps/daemon/src/assistant/parallel-search.ts apps/daemon/src/assistant/parallel-search.test.ts` · exit 0
- [ ] **Step 7: Commit** — `git add apps/daemon/src/assistant/parallel-search.ts apps/daemon/src/assistant/parallel-search.test.ts && git commit -m "Slice 2 T4: Parallel REST search connector (fast mode)"`

**Done when:** fixed body + header asserted; 5-result cap and 1,000-char excerpts asserted; refused statuses throw `SearchHttpError` so `createWebSearchRun` falls through to the next key.
