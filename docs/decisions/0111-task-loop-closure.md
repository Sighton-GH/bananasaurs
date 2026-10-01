# ADR 0111: closing the task loop

Status: accepted for the task-tracking branch (owners, 2026-09-29).

**O1.** The owner may approve task completions over MCP and in the dashboard.

**O2.** The assistant replies only when tagged or when a member uses Discord's reply feature on a bot message. The untagged task-clarification trigger is removed. Task posts carry a notice telling members to reply directly to log progress.

**O3.** A reply to a task post that contains a progress update is recorded as a report; a bare acknowledgement is not.

**O4.** Reminders ping assignees; whole-team tasks ping the team's role. One weekly check-in per channel or thread. Exec teams get the weekly digest too.

**O5.** A lead may approve their own completion. The president may approve subteam tasks.

**O7.** Leads and the president approve in Discord via a "ready for review" post with Approve / Send back buttons.

**O8.** Creating a task posts an announcement in its channel or thread, pinging assignees; replies to it record progress.

**O9.** MCP has full ability over the task system (owner-only).

**R1.** "Team role" is a new optional `member_role_id` per team. Holding it (live) counts as team membership in addition to stored memberships. Unset means team tasks post without a role ping.

**R2.** Progress versus acknowledgement is decided by a deterministic classifier, not the AI.

**R3.** Recorded progress is acknowledged with a ✅ reaction, not a "thanks" message.

**R4.** The first recorded report moves `not_started` to `in_progress`. "Send back" moves `awaiting_approval` to `in_progress`.

**R5.** Weekly check-ins and digests are scheduled only on Pacific Mondays after quiet hours end. Pre-due and custom reminders keep their exact times.

**R6.** Quiet hours delay only scheduled posts (pre-due, custom, check-in, digest). Event posts (announcement, review request, clarification, ✅) go out immediately.

**R7.** A reply to a check-in listing several tasks is recorded when exactly one listed task belongs to the replier; with several, the bot replies with one button per candidate (max 5) and records on press; with none, nothing happens. Pending choices are pruned after 7 days.

**R8.** `/task complete` takes no typed ID; it shows the member a select menu of up to 25 tasks they can complete.

**R9.** `TASK_NUDGE_SEND_ENABLED` (default `0`) is the one switch for all task posts. With it off, posts settle as `planned` and are not retried later.

**R10.** The dormant dashboard-account binding table, repository and routes are dropped.

**R11.** `/task list` shows open tasks only, soonest due first, 15 rows, readable status labels.

**R12.** A deleted lead role disables lead powers only; members keep access.

**R13.** Owner edits of dated steps, status and archive are compare-and-swap on the task version with an audit row naming the real actor.

## Supersedes

ADR 0101 (task MCP tools were read-only), ADR 0103 (the president could not approve subteam tasks unless also lead), ADR 0109 (no MCP approval tool), ADR 0110 (untagged clarification path, clarification invocation, destination fallback), ADR 0105 and 0106 (task anchors were never posted).
