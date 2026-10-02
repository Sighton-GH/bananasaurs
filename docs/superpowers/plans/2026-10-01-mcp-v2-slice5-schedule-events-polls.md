# MCP connector v2 — Slice 5: schedules, events, polls, caps, policy controls — Implementation Plan

> Approved under the owner's 2026-09-29 auto-approval of all MCP v2 slices. Execute task-by-task with opencode-driven-development.

**Goal:** Let the owner do these from Claude:
- schedule fixed-text messages, one-shot or recurring;
- create, edit and cancel Discord events;
- post native polls;
- tune every MCP rate cap and switch the role policies from the dashboard or the CLI.

**Architecture:** ADR 0119.
- Scheduled sends are `assistant_reminders` rows with `origin='mcp'` (migration `0095`), delivered by the existing worker with a delivery-time re-check.
- Events and polls use the port methods from parallel task P1.
- Caps become instance settings (ADR 0080).
- Policy controls are ops commands with dashboard parity.

**Depends on:** slice 3 (pipeline, targets, pings) and slice 4 (cap groups, policy tables in use). P1 (event and poll port methods) is merged first.

## Global Constraints

- Slice 3's Global Constraints apply.
- No model call anywhere in the scheduled-send path. A test asserts the delivery adapter has no provider dependency.
- `origin='mcp'` reminders never set `everyone` or `here`.
- Dashboard: only the controls ADR 0119 §4–§5 names, on the existing AI tuning page and the existing MCP page.

## Review Focus

1. A scheduled send whose role became dangerous after scheduling → delivered without that ping (Task 2).
2. A scheduled send whose destination left send scope → failed with `target-out-of-scope`, and nothing posted (Task 2).
3. Assistant (non-MCP) reminders behave exactly as before (Task 2 regression test).
4. A cap edited in settings takes effect on the next call with no restart (Task 4).

---

### Task 1: Migration 0095 `origin` + reminder repo

- Add `origin` to `assistant_reminders` with the CHECK, default `'assistant'`.
- `insertReminder` accepts `origin`, and the list, edit and cancel functions filter by origin.
- Tests: existing rows read back as `assistant`; an MCP list never returns assistant rows; guild B is isolated.

### Task 2: Delivery-time re-check for `origin='mcp'`

- In `apps/daemon/src/assistant/reminder-delivery.ts`, for `origin='mcp'` only, re-run `resolveSendTarget(post)` and `resolvePings` before sending:
  - a target refusal → `fail(id, 'target-out-of-scope')`;
  - a refused role → dropped from `allowedMentions`, and an ids-only log line.
- Tests: Review Focus 1–3.

### Task 3: `schedule_message`, `list_scheduled`, `edit_scheduled`, `cancel_scheduled`

- Params:
  - destination (channel or thread);
  - content ≤2,000 characters;
  - `at` (ISO or epoch ms, in the future) or `recurrence` (the existing `recurrenceJson` shape — read its schema in core);
  - `pingRoles` / `pingUsers`;
  - `idempotencyKey`, `dryRun`.
- Each is an `mcp_actions` row (cap group `message` for create, `edit` for edit and cancel), with undo for cancel (restores `scheduled`) and for edit (the previous values).
- Tests:
  - schedule, then list, then edit, then cancel;
  - a past time is refused;
  - pings are checked at schedule time;
  - a two-guild gate.

### Task 4: Caps in tuning settings

- Register the five keys in the ADR 0080 instance-settings registry, with defaults and bounds.
- The actions deps factory reads the live setting per call, and `runMcpAction` takes `cap` in its deps instead of reading `MCP_ACTION_CAPS` directly.
- The dashboard AI tuning page shows them (the registry drives the page; verify that, and add help text).
- Tests: Review Focus 4; bounds are validated.

### Task 5: `create_event` / `edit_event` / `cancel_event` / `create_poll`

- Events use P1's port methods.
  - A voice or stage channel passes `resolveSendTarget`, plus the bot must have ManageEvents (the plan adds need `manage-events`).
  - External events need `endAt`.
  - Cap group `structure`; undo for cancel is not possible (Discord cannot un-cancel), and the tool says so.
- `create_poll {channel, question ≤300, answers 2–10 each ≤55, durationHours 1–168, allowMultiselect}` goes through the `message.send` path with `poll` set.
- Tests: route checks via FakeDiscord, the two-guild gate, refusals.

### Task 6: Policy controls (CLI + dashboard MCP page)

- Ops commands:
  - `mcp role-policy`;
  - `mcp allow-role`, which refuses a dangerous role live by fetching the role from the guild;
  - `mcp disallow-role`.
- Add writer functions to `mcp-role-policy.ts`.
- On the dashboard's MCP page, add the policy mode selectors and the allowlist table with add and remove controls, calling the same commands.
- Add `CLI_WEB_PARITY` entries and update `docs/webui-capability-map.md`.
- Tests: commands, the parity test, and the dashboard component test following the page's existing tests.

### Task 7: Registration, instructions, smoke docs

- The registration test's tool sets.
- An `instructions.ts` section on scheduling, events and polls.
- `docs/SMOKE_TESTS.md` live checks.

## Slice verification (controller)

`npm run typecheck`, then `npm run lint`, then `npm run test`, each run alone, each exit 0.
