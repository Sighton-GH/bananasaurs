> **STATUS: FINAL** — owner decisions D1–D5 recorded 2026-09-30.

# Logging routes: plan

**Status:** FINAL
**Date:** 2026-09-30
**ADR:** 0121 (to be written before implementation) · **Migration:** 0091
(0080–0089 are reserved for MCP connector v2 and 0090 is Tavily's.)

## Contents

1. Decisions I need from you
2. What you asked for, and what you've already decided
3. What changes, and why it's more than a UI change
4. Data model
5. How an event reaches a route
6. The page
7. API, CLI, MCP
8. Actions we will log
9. Slices and tests
10. Out of scope

---

## 1. Decisions I need from you

| # | Question | Answer |
|---|---|---|
| D1 | Should a channel excluded server-wide on Permissions still be kept out of every log route? | **Yes** (owner, 2026-09-30). It stays the privacy override and isn't shown on the Logging page, apart from a read-only link. |
| D2 | Which new actions ship with this work? | **All of Tier A, plus invites, emoji/sticker changes, and avatar/username changes** (owner, 2026-09-30). Voice and scheduled events don't ship. See §8. |
| D3 | Replace the single vague "Member updated" action with specific ones? | **Yes** (owner, 2026-09-30). See §8.1. |
| D4 | Should a route skip events in its own destination channel? | **Yes** (owner, 2026-09-30). |
| D5 | Logging "old → new" for names, avatars, nicknames and roles means keeping a last-seen record per member: username, display name, nickname, avatar ID, role IDs. Is that OK, with the record deleted when the member leaves? | **Yes** (owner, 2026-09-30). PRIVACY.md gets a line. |

## 2. What you asked for, and what you've already decided

- A **route** = the actions you tick (with **Select all**) + one destination channel + optional
  channels excluded **for that route only**.
- Routes can be created, edited, turned **on/off**, and **deleted**.
- **No overall exclusion on the Logging page.** (D1 covers the Permissions-page list.)
- **One action can be in more than one route.** Each route posts its own copy.
- **Message content**: a per-route toggle, **on by default**.
- **Select all** ticks the actions available *now*. It doesn't automatically add actions created later.
- **Excluding a channel also excludes its threads.** You can't exclude a whole category.
- Nothing is configured today, so the new tables start empty and nothing needs carrying over.

## 3. What changes, and why it's more than a UI change

Today `log_routes` has the key `(guild_id, event_kind)`, which allows **one channel per action**. The
page shows a table of action → channel rows plus one global exclusion list. What you're describing
can't be stored in that shape. A route needs its own ID, a list of actions, and a list of
exclusions. Routes can also overlap, so posts must be de-duplicated per route, not per action.

## 4. Data model

The current `log_routes` is dropped and recreated (it has no rows). `log_excluded_channels` stays
exactly as it is: it holds the server-wide Excluded list used by Permissions, Archive and MCP (D1).

```
log_routes            (guild_id, route_id)  PK
  name                text, defaults to "→ #<channel name>" at creation, editable
  channel_id          destination
  include_content     0/1, default 1
  enabled             0/1, default 1
  created_at

log_route_events      (guild_id, route_id, event_kind)  PK
  FK (guild_id, route_id) → log_routes ON DELETE CASCADE

log_route_exclusions  (guild_id, route_id, channel_id)  PK
  FK (guild_id, route_id) → log_routes ON DELETE CASCADE
```

- `route_id` comes from a guild-scoped counter that never reuses a number. If a deleted route's ID
  came back on a new route, a replayed gateway event could be wrongly treated as already posted, or
  posted twice (rule 6).
- Every repository function takes a `GuildScope` (rule 2). Deleting a route is one statement, and
  the cascades remove its actions and exclusions with it.
- `event_kind` is validated against `LOG_EVENT_KINDS` with Zod at the API and CLI boundary. It is
  not a SQL CHECK, because a CHECK would need a migration every time an action is added.

**Member last-seen record** (if D5 = yes):

```
log_member_snapshots  (guild_id, user_id)  PK
  username, global_name, nickname, avatar_hash, guild_avatar_hash, role_ids (JSON), updated_at
```

It's written on every member event, compared against to produce "old → new", and deleted after
the leave line is posted. Avatar *hashes* only: the log line links Discord's CDN URL, and no image
is downloaded or stored. It's filled in gradually, as members trigger events. The first change seen
for a member with no record yet logs "changed their avatar", with no before. That's honest, and it
avoids fetching the whole member list at startup.

## 5. How an event reaches a route

For each incoming event, the subscriber:

1. Stops if the source channel, or the parent of its thread, is on the server-wide Excluded list (D1).
2. Loads the **enabled** routes that include this action.
3. For each route, skips it when the source channel or its thread parent is in the route's
   exclusions, or is the route's own destination channel (D4). `MessageEvent.parentChannelId`
   already exists. It only comes from the cache, so a thread whose parent isn't cached is checked
   against its own ID only. The ADR records this, and a test pins it.
4. Claims a de-duplication key **per route**: `(route_id, event_kind, fingerprint)`. On a failed
   send it releases that route's claim only, so the other routes aren't affected.
5. Formats the line. Message content is included only if that route has `include_content` on.

**Deleted messages** go through a delayed job, so the deleter can be looked up in the audit log.
That lookup stays **once per message**, and the job then posts to every matching route, each with
its own key. The content captured when the job is queued is kept only if at least one matching
route wants content. Each route then strips it or keeps it.

Some actions have no source channel: joins, leaves, role changes, server and AutoMod events.
Exclusions don't apply to them, and the form says so next to the exclusion picker.

The "logging was offline" gap marker still goes once to each distinct destination channel of the
enabled routes.

## 6. The page

**Route list**: one card per route:

```
┌ → #mod-log ─────────────────────────── [On ●] [Edit] [Delete] ┐
│ Messages: deleted, edited · Members: joined, left              │
│ Excludes: #staff-chat, #bot-spam (and their threads)           │
│ Message content: shown                                         │
└────────────────────────────────────────────────────────────────┘
[ + New route ]
3 channels are excluded server-wide on Permissions →
```

**Create/edit form** (one form for both):

- **Actions**: checkboxes with readable names, grouped as Messages / Members / Roles / Channels /
  Server / Moderation. There's a **Select all** at the top and a select-all for each group.
- **Post to**: a picker that lists only text channels the bot can post in.
- **Don't log from**: a multi-select of channels (no categories), with the note "threads in these
  channels are excluded too".
- **Include message content**: a checkbox, ticked by default.
- **Name**: optional, prefilled with "→ #channel".
- Validation: at least one action, and a destination is required. A destination that also appears
  in the exclusions is rejected with a clear message.

**Delete** asks for confirmation with the existing `ConfirmDialog`.

## 7. API, CLI, MCP

- `GET /api/log-routes` returns routes with their actions and exclusions, plus the number of
  server-wide exclusions.
- `POST /api/log-routes` creates a route. `PUT /api/log-routes/:id` replaces its actions,
  exclusions, channel, name and content flag in one transaction. `PATCH /api/log-routes/:id`
  changes `{enabled}`. `DELETE /api/log-routes/:id` deletes it.
- Every body goes through Zod and uses the same authorisation as today's write routes. The
  `/api/log-exclusions` endpoints stay, because Permissions uses them.
- CLI parity (`cli-parity.ts`, `ops/commands`): `log routing list | create | update | on | off |
  delete`, replacing today's `set`.
- MCP isn't touched. Nothing in `packages/mcp` reads routes.

## 8. Actions we will log

I compared our 12 actions with what the bot receives and with Carl-bot's logging categories
([Carl-bot docs](https://github.com/CarlGroth/carlbot-docs/blob/master/logging/logging.md)).
The owner picked the set below on 2026-09-30.

### 8.1 D3, explained

Today there is one checkbox, **"Member updated"**. It fires whenever _anything_ about a member
changes, and the log line is only `Member updated: @alex`. It doesn't say whether that was a new
role, a nickname, a timeout or an avatar.

The proposal is to **remove that checkbox** and replace it with the specific ones below, so you
tick only the changes you care about and each line says what happened:

```
Roles changed: @alex  +@Mentor  −@Newcomer
Nickname changed: @alex  "Alex" → "Alex (CAD lead)"
Timed out: @alex until 14:30 by @mod (inferred)
Username changed: @alex  alex_old → alex_new
Avatar changed: @alex  (new avatar link)
```

### 8.2 The action list, as the form will group it

| Group      | Action                                        | Source                                                      | New?     |
| ---------- | --------------------------------------------- | ----------------------------------------------------------- | -------- |
| Messages   | Message created / edited / deleted            | already logged                                              |          |
| Messages   | **Messages bulk-deleted (purge)**             | `messageDeleteBulk`, already received and currently dropped | new      |
| Members    | Member joined / left                          | already logged                                              |          |
| Members    | **Kicked**                                    | audit log (GuildModeration, held)                           | new      |
| Members    | **Banned / unbanned**                         | `GuildBanAdd/Remove` (GuildModeration, held)                | new      |
| Members    | **Timed out / timeout removed**               | `memberUpdate` + audit log for "by @mod"                    | new (D3) |
| Members    | **Roles changed**                             | `memberUpdate` + last-seen record (D5)                      | new (D3) |
| Members    | **Nickname changed**                          | `memberUpdate` + last-seen record                           | new (D3) |
| Members    | **Username / display name changed**           | `memberUpdate` + last-seen record                           | new (D3) |
| Members    | **Avatar changed** (account or server avatar) | `memberUpdate` + last-seen record                           | new (D3) |
| Members    | **Warning issued** (`/mod warn`)              | our own mod module                                          | new      |
| Roles      | Role created / updated / deleted              | already logged                                              |          |
| Channels   | **Channel created / updated / deleted**       | Guilds intent (held)                                        | new      |
| Channels   | **Thread created / deleted**                  | Guilds intent (held)                                        | new      |
| Server     | **Server settings changed**                   | `guildUpdate` (Guilds, held)                                | new      |
| Server     | **Invite created / deleted**                  | **GuildInvites intent (new)**                               | new      |
| Server     | **Emoji created / updated / deleted**         | **GuildExpressions intent (new)**                           | new      |
| Server     | **Sticker created / updated / deleted**       | GuildExpressions; sticker cache raised from 0               | new      |
| Server     | Server available / unavailable                | already logged                                              |          |
| Moderation | AutoMod action                                | already logged                                              |          |

Where the audit log names who did it (kick, ban, timeout, channel/emoji/invite changes), the line
says "by @mod (inferred)", the same wording the deletion log uses.

**Intents and cache.** Two new non-privileged intents: GuildInvites and GuildExpressions. They
let Discord send the bot invite events and emoji/sticker events. Neither adds an outbound network
destination. `GuildStickerManager` goes from 0 to unlimited, which is a few dozen objects at most;
otherwise discord.js can't tell a created sticker from an updated one. `npm run doctor` will list
both intents, and the cache-limit assertion test will be updated to match.

**Not doing:** voice join/leave/move (owner skipped it) and scheduled events. Invite links posted
in chat belong to automod, not logging.

## 9. Slices and tests

Tests come first wherever permissions, idempotency or guild scope are involved.

1. **ADR 0121 + migration 0091 + repos.** Tests: a scope partition test (a guild B route is never
   read by guild A), cascade on delete, `route_id` never reused after a delete.
2. **Subscriber fan-out.** Tests: overlapping routes post once each; a route's exclusion covers a
   thread whose parent is cached; the destination channel is skipped; the server-wide exclusion
   overrides everything; a disabled route is silent; a failed send on route 1 doesn't block route 2;
   replaying an event posts nothing new.
3. **Message-delete job fan-out.** Tests: one attribution lookup per message, N posts, content only
   for routes with content on.
4. **API + CLI.** Zod rejection cases, authorisation, CLI parity table.
5. **Page.** A component test for Select all and select-all per group, delete confirmation, and the
   destination-in-exclusions error.
6. **Member changes** (D3 + D5): the last-seen table, then roles / nickname / username / avatar /
   timeout lines. Tests: no record yet → "changed" without a before; the record is deleted on
   leave; a replayed update posts nothing.
7. **Moderation and structure**: purge, kick, ban/unban, warn, channel, thread and server lines.
   Each line has a formatter test, and the audit-log actions have an attribution test.
8. **Invites and expressions**: the two intents, the sticker cache change, doctor output, and
   invite/emoji/sticker lines.

Gates: `npm run typecheck && npm run lint && npm run test` in the main checkout (worktree typecheck
resolves packages to main).

## 10. Out of scope

Voice and scheduled-event logging, category exclusions, embeds instead of plain text, and changes
to the Permissions page beyond the read-only link.
