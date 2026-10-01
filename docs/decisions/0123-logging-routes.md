# 0123. Logging routes: named routes, per-route exclusions, and more logged actions

Date: 2026-09-30

Status: accepted (owner decisions 2026-09-30, `docs/25_LOGGING_ROUTES_PLAN.md` D1–D5).
Amends ADR 0023.

## Context

ADR 0023 stored logging as one row per event kind, keyed `(guild_id, event_kind)`. That gives
one destination channel per action, plus a guild-wide exclusion list. The owner found the
Logging page hard to use. They asked for named routes: tick the actions you want (with
**Select all**), pick a destination, pick channels to exclude for that route only, and be able
to turn a route off or delete it. One action may appear in several routes.

The guild-wide list (`log_excluded_channels`) is not specific to logging. The Permissions page
shows it as **Excluded**, and the archive and MCP sending both obey it.

## Decision

1. **A route is a row with its own ID.** `log_routes` is dropped and recreated (it held no rows)
   with `PRIMARY KEY (guild_id, route_id)`, where `route_id` is a random UUID, as task IDs are.
   It also has `name`, `channel_id`, `include_content` (default 1), `enabled` (default 1) and
   `created_at_ms`. A UUID is never reused after a delete, so a replayed event's claim can never
   be confused with a different route's claim (rule 6). The child tables reference the parent
   through the composite key, so a child row cannot point across guilds (rule 2).
2. **Its actions and exclusions are child rows**: `log_route_events (guild_id, route_id,
   event_kind)` and `log_route_exclusions (guild_id, route_id, channel_id)`. Both have a
   composite FK with `ON DELETE CASCADE`, so deleting a route is a single statement.
   `event_kind` is validated in code against `LOG_EVENT_KINDS`, not by a SQL CHECK.
3. **The guild-wide exclusion list stays, and it still wins** (D1). If a channel or its thread
   parent is on `log_excluded_channels`, nothing is logged from it by any route. The Logging
   page no longer edits that list. It shows a count and links to Permissions.
4. **Per-route exclusions cover threads.** An event is skipped for a route when its channel, or
   its thread parent, is in that route's exclusions. Thread parents come from the cache: if the
   parent isn't cached, only the thread's own ID is checked. Categories can't be excluded.
5. **A route never logs from its own destination channel** (D4).
6. **Each route is de-duplicated separately.** The claim's namespace is
   `log:r<route_id>:<event_kind>`. If a send fails, only that route's claim is released.
7. **Deleted messages**: one delayed job per message, as before. It looks up who deleted the
   message once, then posts to every matching route, each under its own claim. The job keeps
   the message content only if at least one matching route had content on when the job was
   queued, and each route's line includes content only if that route has it on.
8. **Member last-seen record** (D5). `log_member_snapshots (guild_id, user_id, username,
   global_name, nickname, avatar_hash, guild_avatar_hash, role_ids, updated_at)` is written on
   member events and compared against to log old → new. It stores avatar hashes, never images,
   and the row is deleted once the member leaves. With no record yet, the first update
   establishes the baseline silently, because without a previous value the bot cannot tell
   whether a name or avatar changed at all (discord.js shares the user object between before
   and after). The record is only kept while some enabled route includes a member-change
   action. PRIVACY.md says this.
9. **"Member updated" is replaced** (D3) by `member_roles_changed`, `member_nickname_changed`,
   `member_username_changed` and `member_avatar_changed`.
10. **New actions** (D2): `message_bulk_delete`, `member_kick`, `member_ban`, `member_unban`,
    `member_warn`, `channel_create`, `channel_update`, `channel_delete`, `thread_create`,
    `thread_delete`, `guild_update`, `invite_create`, `invite_delete`, `emoji_create`,
    `emoji_update`, `emoji_delete`, `sticker_create`, `sticker_update`, `sticker_delete`.
    When the audit log names who did something, the line says "by @x (inferred)".
11. **Two new non-privileged intents**: `GuildInvites` and `GuildExpressions`. This is the owner's
    instruction under hard rule 8. Neither adds an outbound destination. The
    `GuildStickerManager` cache limit goes from 0 to unlimited (a guild has a few dozen stickers
    at most), so discord.js can tell a created sticker from an updated one.

## Consequences

- `log routing set` and `log routing off` are replaced by `log routing create | update | on |
  off | delete`, which take a route ID. `log routing exclude | unexclude` stay: they edit the
  guild-wide list.
- One action in two routes is posted twice, once per route. That is intended.
- Voice and scheduled-event logging are out of scope.
