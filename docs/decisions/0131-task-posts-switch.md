# 0131 — Task posts are a per-server switch on the dashboard

Status: Accepted (owner, 2026-10-06)
Supersedes: ADR 0111 R9 (the `TASK_NUDGE_SEND_ENABLED` env var as the one switch). R9's other half is unchanged: posts skipped while off settle as `planned` and are never sent later.

## Context
Every Discord post for club tasks (announcements, reminders, check-ins, digests,
approval and evaluation posts) went out only when `TASK_NUDGE_SEND_ENABLED=1` in
the bot's .env file. The owner could not find that switch, because every surface
said only "when the operator turns on task posts", and changing it meant editing
a file and restarting the bot.

## Decision
1. `guilds.task_posts_enabled` (INTEGER 0/1, NOT NULL, default 0, CHECK IN (0,1);
   migrations 0102 and 0103) is the switch, one per server, modelled on
   `guilds.automod_state` (ADR 0121).
2. Posts go out only when the guild's switch is on **and** `BANANASAURS_DRY_RUN`
   is off. Dry run still wins, and every surface names it when it is the reason.
3. The daemon reads the guild row on every nudge pass, so flipping the switch
   takes effect on the next minute tick with no restart.
4. `TASK_NUDGE_SEND_ENABLED` is removed from the config schema and `.env.example`.
   An old .env line is ignored (the schema drops unknown keys) and the daemon logs
   one startup warning saying it is no longer used.
5. `PUT /api/tasks/posting {enabled}` sets it, for the owner or anyone with
   `tasks.manage` in the session guild (ADR 0130), audited as `tasks.posts.enabled`
   or `tasks.posts.disabled` (a re-send of the current value is not audited).
   `GET /api/tasks/posting` returns `{ enabled, dryRun }`. `/api/tasks` and
   `/api/tasks/setup` carry a `taskPosts` block for the pages.
6. One shared wording (`packages/core/src/task/posts.ts`) feeds the MCP task
   results ("Nothing was posted to Discord: task posts are off for this server…"
   or "Task posts are on…"), the dashboard banner and card, and the `doctor`
   finding raised when a guild has an open task and posts are off. `get_health`
   reports the switch per guild.

## Consequences
- Turning posts on is a dashboard action with a confirmation, not a file edit.
- Not built: a CLI `tasks posts` command (and its parity entry) and an MCP
  `set_task_posts` tool. The dashboard route is the single write path for now.
- Existing installs read as off after migration, as before.
- AI remains outside the enforcement path (ADR 0002): nothing here involves a model.
