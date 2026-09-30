# MCP connector v2 — design (DRAFT)

Status: **DRAFT — awaiting owner review.** Nothing here is implemented. Written
2026-09-29 from the owner's requests and answers in session "bananasaurs mcp
forum threads".

## 1. Goal

Make the Bananasaurs MCP connector a practical way for the owner to run the
club from Claude: read what's happening in compact, correctly labelled form,
and do real work in Discord (post, thread, edit, pin, react, grant roles,
build role panels, schedule messages, create events and polls) through
deterministic, guarded, audited code.

Success looks like: a weekly recap of Car Team A takes one call; "give
Alumni to everyone in Car Team A who isn't Club Member" takes a preview and a
confirm; a typo in an announcement is an edit, not a second post; and the owner
is never throttled by Bananasaurs during normal work.

### What stays true (non-negotiable)

- **Owner keystroke only** (ADR 0044 §1–2). Every call starts in the owner's
  own client. Scheduled sends carry text fixed at scheduling time; no model
  runs when they fire.
- **AI is never in the enforcement path** (hard rule 1). The model proposes a
  tool call; `core` validates and executes it.
- **Guild scope first** (hard rule 2). Every tool takes `guildId` and passes
  `requireReachableGuild` before anything else.
- **Idempotency** (hard rule 6). Every Discord side effect has a durable key
  with a unique constraint.
- **No DMs** (owner decision). Posts go to guild channels and threads only.
- **No moderation tools.** No ban, kick, timeout, purge or automod edits.
  ADR 0044 §4 is amended only for roles, and only as far as §6 below.

## 2. Owner decisions recorded here (2026-09-29)

| # | Question | Decision |
|---|---|---|
| D1 | Which roles can be granted/removed | Policy per guild: **default any role below the bot**, switchable to an explicit allowlist. Roles with dangerous permissions are never grantable (§6.1). |
| D2 | Which roles can be pinged | Same shape: **default any role below the bot**, switchable to an allowlist. `@everyone`/`@here` never. |
| D3 | Confirmation model | Claude's per-tool approval + server guards (targets, caps, audit, undo). Bulk role changes add preview → confirm. |
| D4 | Prompt injection in reads | Messages that trip `outbound-safety` detectors are **withheld** from MCP results (§4.1). |
| D5 | OAuth scopes | Split: `bananasaurs:read`, `bananasaurs:send`, new `bananasaurs:roles`, new `bananasaurs:tasks` (for the task branch). One re-authorisation. |
| D6 | Private threads | Readable when created via MCP, **or** when both the bot and the owner (`BANANASAURS_OWNER_USER_ID`) are members. Read live, never archived. |
| D7 | Edit/delete | Any message the bot authored, except role-panel messages and task anchors. |
| D8 | Self-assign roles | Full panel management, using existing or new roles. |
| D9 | Extras | Discord events + native polls; pins + reactions; unanswered-question report. **Not** channel admin. |
| D10 | Send targets | **Default all** channels/threads/forums the bot can post in, switchable to allowlist. Threads inherit their parent. |
| D11 | Bulk roles | Yes: preview, confirm, 100 members per call, run as a durable job. |
| D12 | DMs | No. |
| D13 | Rate caps | High backstops only (§5.4); Discord's own limits bind first. |
| D14 | Build approach | One shared MCP action gateway, 5 slices. |
| D15 | Member lookup | Profile + roles + last-active (from the ≤30-day archive). |

Separately, **health says `env development`** because `BANANASAURS_ENV` defaults
to `development`. It only switches Pino to pretty-printed logs
(`packages/core/src/obs/logger.ts:199`). Fix: set `BANANASAURS_ENV=production`
in the deployed `.env` and restart. Slice 1 adds a `doctor` warning when the
systemd unit runs with `development`.

## 3. Architecture

```
Claude client ──OAuth bearer──► /mcp (Fastify) ──► packages/mcp
                                                     │ tool modules (Zod parse → guild gate → port → render)
                                                     ▼
                                     apps/daemon/src/mcp/wiring.ts (ports)
                                                     ▼
                         core: McpActionGateway  ◄── also used by task anchor posting
                           │ resolve target → policy → caps → ledger → effect → audit
                           ├── message-gateway (existing)   posts/edits/deletes
                           ├── role effects (existing panel machinery)  grants/removes
                           └── discord REST port            threads, pins, reactions, events, polls
```

### 3.1 McpActionGateway (core, new)

One function per action kind. Each runs the same fixed pipeline:

1. **Resolve target** from live Discord state (channel/thread/role/member/
   message). Accept names as well as ids (§4.3); ambiguity is a refusal that lists
   candidates.
2. **Policy.** Send-target policy (D10), role policy (D1/D2), the dangerous-
   permission floor, and protected messages (panels, task anchors) for edit/delete.
3. **Killswitch / breaker / readonly.** Reuse the existing ones.
4. **Rate cap** per kind (§5.4).
5. **Ledger claim.** One row in `mcp_actions` keyed `(guild_id, idempotency_key)`,
   unique. A replay with the same key returns the stored outcome. The same key
   with different arguments is refused (same as `send_message` today).
6. **Effect** through the existing gateway for that kind.
7. **Audit** `audit_events` row, `actor_type='mcp_operator'`, ids only, no content,
   written in the same transaction as the ledger completion.
8. **Dry-run.** When `BANANASAURS_DRY_RUN` is set, or the call passes
   `dryRun: true`, stop after step 5 and return what would happen.

`mcp_sends` stays as is for backward compatibility. `send_message` is re-routed
through the gateway and writes to `mcp_actions`; `mcp_sends` becomes read-only
history.

### 3.2 Undo

Every reversible action records its inverse in `mcp_actions.undo_json`: a role
grant records a remove, and an edit records the previous content hash plus the
content itself (bot-authored content only). `undo_action(actionId)` runs the
inverse through the same gateway with a derived idempotency key. Deletes, posts
and events are not undoable; the tool says so.

### 3.3 Scopes

`packages/http`'s OAuth vocabulary gains `bananasaurs:roles` and
`bananasaurs:tasks`. Registration filters tools by scope, as today (ruling M4-D17):

| Scope | Tools |
|---|---|
| read | every read tool, `get_server_context`, resources |
| send | message, thread, pin, reaction, event, poll, schedule, undo of these |
| roles | role grant/remove/bulk, role create, panel management, undo of these |
| tasks | the task branch's write tools (moved off `send` — see §8) |

The consent screen lists scopes in plain words. Existing tokens keep their old
scopes until the owner re-authorises.

## 4. Read-side changes

### 4.1 Injection filter (D4)

Every tool that returns member-typed text (archive reads, thread reads,
digests, mod-case evidence, audit payloads) runs each message body through the
`prompt-injection` and `secret` detectors from
`packages/core/src/providers/outbound-safety.ts`. On a hit, the body is
replaced:

```
[withheld: detector instruction-override · message 1290… · #help · read in dashboard]
```

Author, time and ids still show, so Claude knows the message existed. The
count of withheld messages goes in the ADR 0050 read record. Personal-data
detectors are **not** applied: the owner needs names and emails in club
messages.

The envelope stays around member-typed text only. **Names, ids, types and
counts are no longer enveloped** (the overview fix below).

### 4.2 Output format

Structural results (overview, channel/role/member lists, jobs) return compact
JSON with **names and ids side by side**. No evidence blocks. Message-bearing
results return a small JSON header plus one envelope around the message list,
with one line per message: `[time] @name (id) in #channel: body`.

### 4.3 Names, not only ids

Every tool that takes a channel, role or member accepts
`{ id } | { name }`. Names resolve case-insensitively against the live guild
cache (`#` and `@` prefixes stripped). Zero matches refuses. More than one match
refuses and lists up to 10 candidates with ids. Every result that mentions an
entity shows `name (id)`.

### 4.4 Read tools — new and changed

| Tool | Change |
|---|---|
| `get_server_overview` | **Fix.** JSON: `{guild:{name,id,memberCount}, categories:[{name,id,channels:[{name,id,type}]}], uncategorised:[…], roles:[{name,id,members,mentionable,grantable,pingable}], panels:[{name,id,channel}], rules:{observe:n,enforce:n}}`. Roughly 10× smaller than the current 125 blocks. |
| `get_health` | Adds `failedJobs` by kind and a pointer to `list_jobs`. |
| `list_jobs` | **New.** `status` (queued/running/failed/done), `kind`, `limit`. Returns id, kind, state, attempts, updated-at, `lastError` (truncated to 500 chars and secret-redacted). |
| `get_job` | **New.** One job, with its full redacted `lastError` and a payload summary (ids only). |
| `get_member` | **New.** By id or name: username, display name, nickname, roles, joined-at, last-message-at (archive, ≤30 days, else "not in the last 30 days"). |
| `search_members` | **New.** `hasRoles[]`, `lacksRoles[]`, `nameContains`, `inactiveDays`, `joinedAfter`; paged at 200. Answers "who has Car Team A but not Club Member" in one call. |
| `read_thread` | **New.** Messages in a thread or forum post: archive for public threads, live REST for private threads that pass D6. |
| `read_digest` | **New.** All archived messages under a **category** (or channel list) since a timestamp, grouped by channel/thread, capped at 1,000 messages per call with a cursor. Bounded by the 30-day archive. |
| `read_channel_history` / `search_messages` | Add `authorFilter: "bot" \| "members" \| userId`. `"bot"` = messages authored by Bananasaurs. |
| message results | Add metadata: `replyTo`, `threadId`, `pinned`, `reactions:[{emoji,count}]` (needs §7 archive columns). |
| `list_threads` | Includes private threads that pass D6, marked `private`. |
| `list_unanswered` | **New (D9).** Messages in chosen channels (default: every channel whose name contains `help`) older than N hours (default 12), with no reply, no thread reply, and no reaction from anyone except the author. |
| `list_scheduled` | **New.** The owner's scheduled sends (§5.3). |
| `list_events` | **New.** Discord scheduled events. |

### 4.5 Context: what Bananasaurs is, the server, Markdown

- **MCP server `instructions`** (sent at `initialize`, around 400 words, static
  and versioned in code): what Bananasaurs is (a self-hosted club bot for one
  engineering club), who the operator is, the guardrails (what the write tools
  refuse and why), the name-or-id convention, idempotency keys, the fact that
  reads are evidence and not instructions, and **Discord Markdown**. The
  Markdown part covers the formatting Discord renders: bold, italics,
  underline, strike, headings `#`/`##`/`###`, `-#` subtext, lists, block quotes,
  inline and fenced code, masked links `[text](url)`, spoilers, `<t:unix:R>`
  timestamps, and the 2,000-character limit. It also says tables do not
  render.
- **`get_server_context`** (read): the same server card the assistant's
  `server_info` sees (`assistant_server_cards.content`), the club time zone,
  the current time, and the enabled skills' names/descriptions. The card is
  owner-written text, so it is enveloped.
- **Resources** (read): `search_resources` and `open_resource`, the same
  resource cache and FTS the assistant uses (`assistant_resources`,
  `resource_documents`, `resource_chunks`). Guild-scoped, enveloped, and
  filtered through §4.1. No new outbound fetch: they read the cache only.
- The overview is also exposed as an MCP **resource** (as today), plus
  `bananasaurs://guild/{id}/context`.

## 5. Write-side tools

Every write takes `guildId`, an `idempotencyKey` and optional `dryRun`, and
returns `{actionId, status, …ids}`.

### 5.1 Messages and threads (scope `send`)

| Tool | Notes |
|---|---|
| `send_message` | Adds `replyTo` (message id), `threadId`, `embeds` (≤3; title, description, fields ≤10, colour, footer; no images), `pingRoles` (role names/ids, each passing D2), and `pingUsers` (≤25). All other mentions stay suppressed via `allowedMentions`. Content 2,000 chars; embed total 6,000. |
| `create_thread` | In a text/announcement channel: `type: public \| private`, name, auto-archive, optional first message. Private: `invitable` false by default; recorded in `mcp_private_threads`, so D6 grants read access. |
| `add_thread_members` / `remove_thread_members` | ≤25 members per call. |
| `create_forum_post` | Forum/media channel: title, body, tags by name. Always public (Discord rule). |
| `edit_message` | Bot-authored only, not protected (D7). Content and/or embeds. Keeps the prior version for undo. |
| `delete_message` | Same eligibility. Not undoable. |
| `pin_message` / `unpin_message` | Any message in a send-eligible channel. |
| `add_reaction` / `remove_reaction` | The bot's own reaction only. |
| `archive_thread` / `lock_thread` | The thread-level part of D9 (no channel create/delete). |
| `schedule_message` | §5.3. |
| `create_poll` | Native Discord poll: question, 2–10 answers, duration 1–168 h, multi-select. |
| `create_event` / `edit_event` / `cancel_event` | Discord scheduled events: voice, stage or external location; name, description, start/end. |
| `undo_action` | §3.2, for send-kind actions. |

### 5.2 Roles and panels (scope `roles`)

| Tool | Notes |
|---|---|
| `grant_role` / `remove_role` | One member, one role. Live hierarchy + D1 policy + dangerous floor. |
| `bulk_role_change` | `add`/`remove` a role for a member list **or** selector `{hasRoles, lacksRoles}`. First call (no `confirmToken`) returns count, first 20 names, and a `confirmToken` (HMAC of the args and the resolved member set, 10 min TTL). A second call with the token enqueues a durable job (`mcp.bulk_role`, cursor = next member). Cap: 100 members per call. `get_job` shows progress. |
| `create_role` | Name, colour, hoist, mentionable. **Permissions always zero**; the tool has no permissions field. Placed directly below the bot's top role. |
| `edit_role` | Name, colour, mentionable only, and only for roles passing D1. |
| `list_panels` / `get_panel` | Read side (read scope). |
| `create_panel` | Channel, title, body, style (buttons/select/reactions per ADR 0054), options `[{role (existing name/id **or** `{create:{name,colour}}`), label, emoji}]`. Publishes through the existing panel publish path. |
| `edit_panel` | Title/body/style; `addOptions`, `removeOptions`, `reorder`. Republishes. |
| `delete_panel` | Removes the message and the panel rows. Roles stay. |
| `undo_action` | For role-kind actions. |

Panel tools call the dashboard's panel services (`core/src/panels`), so there's
one panel code path (ADR 0053/0054).

### 5.3 Scheduled sends

`schedule_message` stores a row in the existing **`assistant_reminders`**
machinery, with `creator_id` = `BANANASAURS_OWNER_USER_ID` and a new
`origin='mcp'` column. It supports one-shot or recurrence (the existing
`recurrenceJson`), a destination, content ≤2,000 chars, and ping roles/users
checked against D2 **when scheduled and again when delivered**. Delivery uses
the existing reminder worker, not a model. `list_scheduled`,
`edit_scheduled` and `cancel_scheduled` complete the set. This reuses tested
recurrence and quiet-delivery code instead of adding a third scheduler (the
task branch's nudge worker is the second).

### 5.4 Rate caps (D13)

Per guild per rolling hour, stored in instance AI-tuning settings (ADR 0080),
editable in the dashboard:

| Kind | Default |
|---|---|
| messages (send, reply, forum post, scheduled create) | 300 |
| edits + deletes | 300 |
| member-role changes (bulk counts each member) | 1,000 |
| threads, polls, events, panels, role create | 100 |
| pins + reactions | 300 |

A cap hit refuses with the reset time. These are runaway backstops only;
Discord REST limits (handled by discord.js's queue) are what the owner will
feel first.

## 6. Guard details

### 6.1 Dangerous-permission floor

A role is never grantable, pingable-by-policy or panel-eligible, and never
allowlisted, if it has any of: Administrator, ManageGuild, ManageRoles,
ManageChannels, ManageWebhooks, ManageMessages, BanMembers, KickMembers,
ModerateMembers, ManageGuildExpressions, MentionEveryone, ManageThreads,
ManageEvents. Checked **live at call time**, so a role that gains a permission
after being allowlisted stops being grantable. `@everyone` and managed
(integration/booster) roles are never targets.

### 6.2 Policy tables

- `mcp_role_policy(guild_id PK, grant_mode 'below-bot'|'allowlist', ping_mode 'below-bot'|'allowlist')`
- `mcp_role_allowlist(guild_id, role_id, purpose 'grant'|'ping', …)`, unique.
- `mcp_send_policy(guild_id PK, mode 'all'|'allowlist')`. The existing
  `mcp_send_allowlist` is reused for allowlist mode. **Migration default:
  `all`** (D10). That is a behaviour change from today's empty allowlist, and
  the ADR must say so.

All three are editable through the existing `bananasaurs mcp` CLI and the
dashboard's MCP page. Only the policy controls are added (current-release
dashboard rule).

### 6.3 Protected messages

Edit/delete refuses role-panel messages (`panels.message_id`) and task anchors
(when the task branch lands, via a port the task module implements). It also
refuses any message not authored by the bot.

### 6.4 Private-thread read (D6)

Readable when `mcp_private_threads` has the thread, **or** a live check shows
both the bot and the owner's Discord user (`BANANASAURS_OWNER_USER_ID`, already
required config) are thread members. The principal must also be the instance
owner account. Content is fetched live and
**never** written to the archive. The ADR 0050 read record marks
`private=true`.

## 7. Storage (migrations reserved 0080–0089)

- `mcp_actions`: the ledger (§3.1), with `undo_json`, `kind` and `status`.
- `mcp_role_policy`, `mcp_role_allowlist`, `mcp_send_policy`
- `mcp_private_threads(guild_id, thread_id, created_action_id)`
- `archive_messages` + `reply_to_message_id`, `pinned` (ingestion sets them
  from `message.reference` and pin events)
- `archive_reactions(guild_id, message_id, emoji_key, count)`, maintained by the
  existing reaction events. **Verify** the reaction intent is already enabled
  (it is needed for ADR 0054 reaction roles); if not, that's a doctor-visible
  change.
- `assistant_reminders` + `origin`
- The OAuth scope vocabulary (code, not a table).

All tables are guild-partitioned with FKs to `guilds`, in line with the schema
invariants test.

## 8. Compatibility with the task-tracking branch (`feature/task-tracking`)

That branch is staged and unmerged. It adds `list_tasks`, `get_task_details`
and ~10 task write tools under `send`, ADRs 0087–0103 and migrations 0053,
0060, 0061, 0070 and 0071.

1. **Numbering.** This work takes **ADRs 0110–0119** and **migrations
   0080–0089**. (Main already has ADRs 0087–0093 from assistant-memory, which
   collide with the task branch's 0087–0093. That branch must renumber on merge;
   flagged to the owner, not fixed here.)
2. **Tool names.** None of the new names collide with `list_tasks`,
   `get_task_details`, `create_task_team`, `configure_task_team`,
   `set_task_president_role`, `add/remove_task_team_member`,
   `create_club_task`, `edit_club_task`, `append_task_child`,
   `record_task_progress` or `request_task_completion`. Verified against
   `oc/task-loop-closure`. Plan task: a test that asserts tool names are
   unique across all registrars.
3. **`server.ts` merge surface.** New tools register through per-module
   `register*Tools(server, deps)` functions, so `server.ts` gains a few call
   lines, not bodies. The task branch's inline registrations are left
   untouched.
4. **Scope.** Slice 1 adds `bananasaurs:tasks`. When the task branch merges,
   its write tools switch their gate from `hasSendScope` to `hasTasksScope`,
   which is the follow-up its ADR 0101 names. Until then nothing changes for it.
5. **Anchor posting.** The task branch needs "an idempotent Discord send path
   that posts and persists task anchors". `McpActionGateway.postMessage` is
   that path, exported from `core` so the task module can call it from its
   worker with its own idempotency key. Protected-message checks expose a
   `ProtectedMessagePort` the task module implements.
6. **Owner identity.** Both use "bearer account is the enabled instance owner,
   re-checked per call". This work reuses the task branch's pattern verbatim
   (and extracts it to `scope.ts` if both land).

Before slice 3 starts, send a message to the task-tracking session naming the
gateway API, so the two don't build two send paths.

## 9. Slices

Each slice ships with gates green (`typecheck && lint && test`), a
whole-branch review, and an ADR written before code.

| Slice | Content | ADR |
|---|---|---|
| **1 — fixes + reads** | Overview JSON; `list_jobs`/`get_job`; health failed-jobs; injection filter; names-or-ids resolver; `get_member`/`search_members`; `authorFilter`; doctor env warning; scope vocabulary (`roles`, `tasks`); `register*` refactor | 0110 injection filter + output format; 0111 scope split |
| **2 — context + deep reads** | Server `instructions` (incl. Markdown); `get_server_context`; resources; `read_thread`; `read_digest`; archive reply/pin/reaction metadata; `list_unanswered` | 0112 private-thread read (D6) |
| **3 — message writes** | `McpActionGateway` + `mcp_actions` + undo; send policy (default all); send upgrades (reply/thread/embeds/pings); threads; forum posts; edit/delete; pins/reactions; archive/lock thread | 0113 action gateway + send policy default-all; 0114 role pings |
| **4 — roles + panels** | Role policy + floor; grant/remove; bulk with confirm token + job; create/edit role; panel CRUD | 0115 amends ADR 0044 §4 (roles) |
| **5 — schedule, events, polls** | `schedule_message` on reminders; events; polls; caps in tuning settings; dashboard MCP-page policy controls | 0116 scheduled sends are fixed text |

Slices 1 and 2 are read-only and can ship while 3–5 are reviewed.

## 10. Testing

- **Test-first** (CLAUDE.md) for: the guild gate on every new tool (two-guild
  test), the dangerous-permission floor (a role that gains ManageRoles
  mid-test is refused), hierarchy, idempotency replay/mismatch, confirm-token
  tamper/expiry, D6 membership checks, protected-message refusal, and caps.
- Injection filter: each detector's fixture is withheld; a clean message passes;
  withheld count is recorded.
- Overview: a golden JSON snapshot, plus a token-size assertion (≤ ¼ of the
  current output on the fixture guild).
- A registration test for every scope combination, asserting the exact tool set.
- A fake-Discord (`packages/testkit`) round trip per write tool; no network.
- Live checks are listed in `docs/SMOKE_TESTS.md` for the owner's test guild,
  not claimed from unit tests.

## 11. Out of scope

DMs; moderation (ban/kick/timeout/purge/automod edits); channel/category
create/delete/permission edits; role permission edits; any automated trigger
of Claude; webhooks; attachments/images in posts; voice.

## 12. Open items for review

- **O1.** Default send policy `all` widens today's behaviour for existing
  tokens as soon as slice 3 deploys. Accept, or hold `allowlist` until the
  owner flips it?
- **O2.** `list_unanswered` default channel match is "name contains `help`".
  Should it be a named list instead?
- **O3.** Bulk-role cap: 100 per call. Is a whole-team semester rollover
  bigger than that?
