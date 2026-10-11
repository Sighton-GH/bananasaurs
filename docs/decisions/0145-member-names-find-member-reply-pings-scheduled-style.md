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
