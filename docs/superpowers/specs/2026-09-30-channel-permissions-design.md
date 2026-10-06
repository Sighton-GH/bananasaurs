# Channel permissions: Read, Write, Archive, No access — design

**Status: Approved 2026-09-30; implemented 2026-10-02; amended 2026-10-03
(Write seeds with Read; private threads inherit Read and Write).**
ADR: 0126. Migrations: 0098 (channel Read scope, archive `collecting`) and
0099 (`channel_write_seeds`).

## 1. Why

The Permissions tab promises READ / WRITE / ARCHIVE, but only part of it is enforced
(inventory, 2026-09-30):

- **Archive** gates what is *stored*, but not what is *read back*. Assistant
  `search_archive`, MCP `search_messages` / `read_channel_history`, and dashboard search check
  only "an `archive_channels` row exists". MCP `get_message` and
  `GET /api/archive/messages/:id` check no channel at all (`findMessage`,
  `packages/storage/src/repos/archive.ts:829`).
- **Write** gates only MCP `send_message`. Assistant replies, reminders (set and delivered)
  and task nudges post without it.
- **No access** gates archive collection, logging and MCP send. When tagged in a No access
  channel, the assistant still fetches 15 messages there and sends them to the AI provider.
  Logging and backfill check the channel id only, not its parent or category.
- **Read** has no storage and no enforcement anywhere.

Goal: every Bananasaurs surface obeys one rule, and the page says plainly what each switch
does.

## 2. The model (owner decisions 2026-09-30)

Per channel or category there are three **independent** switches. They are not levels.

| Switch | Governs | When off |
|---|---|---|
| **Read** | Fetching messages **live from Discord** beyond what the bot was handed | No live lookups. The bot sees only the tagging message, the message it replies to, and (if Archive is on) the archive, which may be stale. |
| **Archive** | **Recording** new messages into the archive | Recording stops. Messages already archived are **kept** and stay searchable. |
| **Write** | **Posting** content, including the assistant's answer when tagged | Nothing is posted there. A tag in that channel is answered by silence, logged as skipped; no run, so no trace. |
| **No access** | Overrides all three | No read, no write, no recording, and archived copies are hidden from every search. Moderation and automod still work. |

- **Default:** all three switches are off (allowlists, ADR 0009 reasoning).
- **One-time Read and Write seed:** on the first boot after deploy, Read and
  Write are each turned on for every category and uncategorised channel the
  bot can see, so nothing goes quiet. New uncategorised channels start with
  both off; a channel added to a seeded category follows the category.
  Because Write is the MCP send allowlist, the seed also lets the
  owner's connector post there.
- **"Handed to the bot"** = the tagging message, plus the message it replies to. These are
  the only Discord messages the assistant gets without Read. The thread opener and the
  15-message channel-context window (ADR 0089) are fetches and need Read.
- **Precedence** is unchanged from `isInScope` (ADR 0047), checked in this order:
  1. An exclusion on the channel, its parent or its category vetoes everything.
  2. The channel's own row.
  3. The parent's row, for a thread (public or private; Archive excepted).
  4. The category's row (Archive excepted for threads whose parent opts out).

  A private thread inherits Read and Write from its parent or category like
  any thread, and never inherits Archive. Read inherits threads the way
  `send` does (no `include_threads` flag).
- **Archiving stays live** (gateway event → SQLite upsert). A daily batch was considered and
  rejected: it would re-download content the gateway already delivers, lose same-day
  deletes and edits, and leave the archive up to a day stale.

### Archive off no longer destroys

Today, stopping archive deletes the `archive_channels` row, and its messages cascade with it.
This changes:

- **Archive off** sets `archive_channels.collecting = 0`. The row and its messages stay, and
  backfill is not queued.
- **Archive on again** sets `collecting = 1` on the same row. The attachment policy is kept,
  and live recording resumes.
- **Deleting archived messages** is a separate, explicit action that belongs to the Archive
  tab. **The Archive tab UX is out of scope for this work.** Until it is reworked, deletion
  stays available only through the CLI (`archive delete-channel` /
  `archive delete-category`, each with a confirmation). The
  Permissions page never calls a destructive endpoint.
- **Enforcement keys on `collecting`:** `isChannelEnabled`, `hasCategoryRow` and
  `parentIncludesThreads` read only rows where it is set. The archive-read check (§4) keys
  on row existence, not on `collecting`.

> **Owner check (privacy):** with Archive off, messages archived earlier remain searchable by
> the assistant and MCP until they are deleted. Only No access hides them. Confirm this, or
> choose "Archive off also hides old copies".

## 3. One enforcement point

`packages/core/src/channels/scope.ts`:

- `ScopePurpose` becomes `'read' | 'archive' | 'send'`.
- `read` behaves like `send` for thread inheritance.

A new per-guild port, `ChannelAccess`, is built once in `apps/daemon/src/runtime/guild.ts`
and holds no guild parameter, because it is guild-bound by construction (hard rule 2):

```ts
interface ChannelAccess {
  canRead(channelId): Granted | Denied;          // live Discord fetch
  canRecord(channelId): Granted | Denied;        // archive collection
  canSearchArchived(channelId): boolean;         // has archived rows AND not No access
  canWrite(channelId): Granted | Denied;         // post content
}
```

- **Live facts:** it resolves parent, category and private-thread facts from the guild cache.
  When the cache misses, it fails closed (`Denied: 'unknown-channel'`).
- **Every surface calls this port.** No surface keeps its own allowlist walk. The existing
  walks are replaced:
  - `apps/daemon/src/mcp/wiring.ts:600` (send);
  - archive subscriber;
  - backfill;
  - the logging exclusion checks.
- **Checked at use time.** A reminder or nudge re-checks at delivery, not only at creation.
- **Every denial is recorded:**
  - the assistant gets a trace flag;
  - MCP and HTTP get a read-audit or audit row;
  - jobs get a structured log line carrying `guildId`, `channelId`, `purpose` and the reason.

## 4. Surface by surface

| Surface | Check | Behaviour when denied |
|---|---|---|
| Assistant channel-context window, thread opener | `canRead` | Block omitted; trace `channel-context-denied` |
| Assistant `channel_history` tool | `canRead` | Tool not declared for this run |
| Assistant tagged message + replied-to message | none (handed) | — |
| Assistant answer in the invoking channel | `canWrite` | No post; logged as skipped; no run, so no trace |
| Slash-command replies | n/a — the assistant has no slash commands (ADR 0086/0099) | — |
| Assistant `search_archive`, `find`, dashboard Try-it | `canSearchArchived` for each candidate channel, intersected with today's audience / member filter | Channel dropped from the candidate set |
| Assistant `search_conversations` | Drop conversations whose channel is No access | Dropped |
| Assistant `server_info` | Hide No access channels | Hidden |
| Reminders (`set_reminder`, `edit_reminder`) | `canWrite(target)` at set time, plus today's Discord permission check | Refused with a short reason |
| Reminder delivery | `canWrite(target)` at delivery | Skipped and logged; reminder marked `skipped-no-write` |
| Task nudges | `canWrite(destination)` at delivery | Skipped and logged |
| MCP task-admin destinations | `canWrite` when set | Refused |
| MCP `send_message` | `canWrite` (unchanged semantics) | As today |
| MCP `search_messages`, `read_channel_history` | `canSearchArchived` | Channel dropped / `not-found` |
| MCP `get_message` | `canSearchArchived(message.channel)` | `not-found` (no oracle) |
| MCP `list_channels`, `list_threads` | Hide No access channels | Hidden |
| HTTP `/api/archive/search`, `/channels/:id/messages`, `/messages/:id` | `canSearchArchived` | Filtered / 404 |
| Archive live subscriber | `canRecord` | Not recorded (as today) |
| Archive backfill | `canRecord` (now includes parent and category exclusion) | Skipped |
| Logging subscriber | No access via full precedence (now includes parent and category) | Not logged |
| Operator-configured posts: assistant log channel, escalation channel, panels, logging forward targets | **Exempt** — the owner chose the channel for that job | — |
| Moderation, automod, purge | **Exempt** — moderation works everywhere | — |

Notes:
- **The assistant log channel** forwards the question and answer. Content from a No access
  channel is never produced in the first place, because the assistant does not run there:
  `handleMention` returns early on a Write denial (which No access always is),
  and a log line records the skip — there is no run, so no trace.
- **Write-denied with Read on is a valid state.** The assistant does the work, then cannot
  post. To avoid spending a provider call that cannot be delivered, `canWrite` is checked
  **before** the model runs, and the run is skipped.

## 5. Storage

- **Migration 0098:**
  - New table `channel_read_scope (guild_id, channel_id, scope_kind CHECK IN ('channel','category'), enabled_at)`.
    - Primary key `(guild_id, channel_id)`.
    - Foreign key to `guilds` with `ON DELETE CASCADE`.
    - The shape mirrors the send allowlist.
  - `archive_channels.collecting INTEGER NOT NULL DEFAULT 1 CHECK (collecting IN (0,1))`.
- **Migration 0099:** new table `channel_write_seeds (guild_id, seeded_at)`,
  the Write seed's once-only marker — the same shape as `channel_read_seeds`.
- **The Read and Write seeds** are startup jobs marked in the
  `channel_read_seeds` and `channel_write_seeds` tables (primary key on
  guild). Each does insert-or-ignore, one row per category and per
  uncategorised channel visible at that moment. Because Write is the MCP send
  allowlist, its seed rows carry `added_by_account_id = 'system:write-seed'`,
  rendered as `Initial setup` wherever the allowlist shows an author.
- **No access** stays in the existing exclusions table. The UI renames it; no data moves.

## 6. Permissions page (dashboard) and CLI

- **Columns:** Channel · Read · Write · Archive · No access.
  - Each cell shows its effective state: `On`, `On, via <category>`, `Off`, or `Blocked by No access`.
  - Each cell has its own toggle.
- **Legend card** at the top, in plain words:
  - **Read:** "May look up recent messages live from Discord. Off: the bot only sees the message that tagged it, the one it replies to, and the archive."
  - **Write:** "May post here, including answering when tagged. Off: the bot stays silent here."
  - **Archive:** "Records new messages into a searchable copy. Turning it off stops recording; nothing is deleted. Delete archived messages on the Archive page."
  - **No access:** "Overrides everything above and hides archived copies. Moderation and automod still work."
- **"Not controlled here" card:** lists the exempt surfaces from §4 so the page is honest.
- **Archive off:** no destroy dialog any more; the toggle is a plain switch.
- **CLI parity** (`cli-parity.ts`):
  - `scope read enable-channel|enable-category|disable-channel|disable-category`;
  - `archive pause` / `archive resume`;
  - `archive delete-channel` / `archive delete-category`.
- **PRIVACY.md** is updated to cover Read, and to say that Archive off keeps history until
  it is deleted.

## 7. Out of scope

- The Archive tab UX, including where deletion moves in the dashboard.
- Moderation/automod scoping.
- Per-role or per-member read limits; the assistant's member-permission filters stay as they
  are.
- Daily batch archiving (rejected, §2).

## 8. Testing (tests first; each watched failing)

- `isInScope('read', …)`: own row, parent, category, private thread, and exclusion at each
  level.
- `ChannelAccess`: fails closed on a cache miss.
- One refusal test per row of §4's table, asserting both the denial and its record.
- Archive off: the row and messages survive; recording stops; search still returns old
  rows; No access hides them.
- Read and Write seeds: each runs once per guild, and a second boot inserts nothing.
- Guild partition: a second guild's rows never grant access.
- Gates: `npm run typecheck && npm run lint && npm run test` in the main checkout (worktree
  typecheck resolves packages to main).
