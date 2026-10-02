# ADR 0119: MCP scheduled sends are fixed text; events, polls, caps and policy controls

Status: accepted (2026-10-01; owner auto-approved MCP v2 slices on 2026-09-29)

Spec: `docs/superpowers/specs/2026-09-29-mcp-connector-v2-design.md` §5.1 (events, polls), §5.3, §5.4, §6.2 (owner decisions D2, D9, D10, D13).

## Decision

1. **Scheduled sends reuse reminders and are fixed text.**
   - **Storage:** `schedule_message` stores an `assistant_reminders` row with
     `creator_id` = `BANANASAURS_OWNER_USER_ID` and a new column
     `origin TEXT NOT NULL DEFAULT 'assistant' CHECK IN ('assistant','mcp')`
     (migration `0095`).
   - **Content:** text, destination, one-shot or recurrence, and explicit
     role and user pings. `everyone` and `here` are always false for
     `origin='mcp'`.
   - **Delivery:** the existing reminder worker (`deliverDueReminders` and
     `apps/daemon/src/assistant/reminder-delivery.ts`). No model runs when a
     scheduled send fires (ADR 0044 §1–2: owner keystroke only, at
     scheduling time).
2. **Checked twice.** At scheduling, the destination passes ADR 0116 §3
   (send scope plus live `post` permission) and each ping passes ADR 0117.
   At delivery, for `origin='mcp'` rows only, the daemon's delivery adapter
   re-checks both:
   - a destination that has left send scope, or lost permission, fails the
     reminder with reason `target-out-of-scope`;
   - a role ping that no longer passes policy or the floor is dropped from
     `allowedMentions` (the text still renders), and the drop is logged with
     ids only.

   `list_scheduled`, `edit_scheduled` and `cancel_scheduled` act only on
   `origin='mcp'` rows of the guild. Each create, edit and cancel is an
   `mcp_actions` row; create is in cap group `message`.
3. **Events and polls (D9).**
   - **Events:** `create_event`, `edit_event` and `cancel_event` use Discord
     scheduled events (voice, stage or external; privacy GuildOnly) through
     the port methods built in parallel task P1, with cap group `structure`.
     A voice or stage channel must be in send scope and visible to the bot.
   - **Polls:** `create_poll` posts a message carrying a native poll through
     the `message.send` path. That gives it the same target, ping and
     idempotency rules, and the same cap group (`message`).
4. **Caps move to tuning settings (D13).** The five `MCP_ACTION_CAPS`
   numbers become instance settings in the ADR 0080 registry:
   - keys `mcp.cap.message`, `mcp.cap.edit`, `mcp.cap.member_role`,
     `mcp.cap.structure`, `mcp.cap.pin_react`;
   - defaults 300, 300, 1000, 100, 300; integer 1–10,000;
   - editable on the dashboard's AI tuning page.

   `runMcpAction` takes the cap as a deps value rather than reading a
   constant. The constants remain only as the registry defaults.
5. **Policy controls (D1/D2 switching).**
   - **CLI:** `bananasaurs mcp role-policy` (show, or set
     `--grant below-bot|allowlist` and `--ping below-bot|allowlist`), plus
     `mcp allow-role <role> --purpose grant|ping` and `mcp disallow-role`.
     Allowing a role refuses a dangerous one (ADR 0117 §3).
   - **Dashboard:** matching controls on the existing MCP page, using the
     same ops commands, recorded in the CLI-parity map.
   - No other dashboard surface is added (current-release rule).

## Consequences

- A scheduled send can never ping a role that has since become dangerous,
  and can never post into a channel the owner has since removed from send
  scope.
- The reminder worker gains one branch for `origin='mcp'`. Assistant
  reminders behave exactly as before.
- The owner can raise or lower every MCP rate cap without a deploy.
