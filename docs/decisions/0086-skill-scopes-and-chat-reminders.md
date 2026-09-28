# 0086. Skill scopes, chat-driven skills and reminders

Date: 2026-09-27
Status: Accepted (owner decisions S1–S10 in `docs/23_ASSISTANT_MEMORY_PLAN.md` §6a, 2026-09-27). Supersedes ADR 0064.

## Context

Skills run only through twelve slash commands (`/remind`, `/remember`, …).
Members find the slash commands confusing and would rather ask the bot. The
only member gate is a behaviour's "Who can ask" (ADR 0064), so a sensitive
skill can be limited only by building a separate behaviour. Reminders are two
skills (set, deliver), post only in the channel they were asked in, never
ping anyone, and cannot repeat, be listed, edited or cancelled from chat.

## Decision

1. **One scope per skill, server-wide.** Each skill has a scope: *Everyone
   who can ask*, *Specific roles*, or *Owner only*. It is stored on the
   existing `assistant_skill_grants` row (new `mode` column; `role_ids_json`
   holds the roles). A request passes the behaviour's "Who can ask" **and**
   the skill's scope, both checked in code against the asker's live roles.
   The owner passes every gate. Skills that act (reminders, propose memory,
   record decision) default to *Owner only*; read and draft skills default
   to *Everyone who can ask*.
2. **Skills from chat, no confirmation.** Acting skills become tools the
   model may call: set, list, edit and cancel reminders; propose a memory;
   propose a decision. The model only proposes the call. Code validates the
   arguments with Zod, checks the scope, runs the action with a durable
   idempotency key (`skill:<invocationId>:<tool>:<n>`, unique), logs it in
   skill activity, and answers. A tool is declared only when the asker's
   scope allows it, and is re-checked when it runs.
3. **Injection guard (hard rule 3, ADR 0071).** Acting tools are offered in
   the first tool round only, answering the asker's own current message.
   Retrieved text, channel context and quoted messages can never trigger
   one. When the request is ambiguous (time, channel, who to ping) or a
   value fails validation, the tool returns the problem and the bot asks the
   member instead of guessing.
4. **One `reminders` skill** replaces `create-reminder` and `send-reminder`
   (a migration rewrites stored skill ids). Delivery stays automatic.
5. **Reminder shape.** A reminder has text, an optional context line (why
   it was set), a due time, a target channel, mentions (members, roles,
   `@everyone`/`@here`) and an optional repeat: daily, weekdays, weekly on
   chosen days, every N weeks, or monthly on a date, with an optional end
   date or count. After each delivery a repeating reminder moves to its next
   future occurrence; occurrences missed while the bot was down are skipped,
   with at most one late post. Delivery is at-least-once per occurrence via
   the status claim rather than a per-occurrence key: a crash between send
   and reschedule re-posts that occurrence after the stale threshold.
6. **Checks when set or edited, live from Discord.** The asker can view and
   send in the target channel, and the bot can send there. `@everyone`,
   `@here` and roles that are not mentionable need the asker to hold
   *Mention @everyone, @here and All Roles* in that channel. Delivery sends
   `allowedMentions` listing exactly the stored members and roles (and
   `everyone` only when stored), never parsed from the text.
7. **Confirmation text is written by code.** After a reminder is set or
   changed, the reply ends with a summary built from the stored row, not by
   the model: what, why, when (absolute, in the club's time zone), where and
   who it pings. Members list, edit and cancel their own reminders; the
   owner can change any.
8. **Slash commands.** Only `/mod` and its subcommands remain. The twelve
   assistant commands and `/status` are removed from registration and their
   handlers deleted; bot status stays on the dashboard and `npm run doctor`.
9. **Skills page.** Each skill shows its scope editor and its live items:
   reminders (edit, cancel), memory proposals to review, decisions, and
   recent activity.

## Consequences

Members use one surface, plain chat. A request that needs a lookup before
acting ("remind members about the next meeting") works when the details are
in the question or the pre-retrieved snippets; otherwise the bot asks for
them, because an acting call may not follow retrieved text. ADR 0064's
workaround (a separate behaviour per sensitive skill) is no longer needed.
The model never decides authorisation, and every action is logged and
idempotent.
