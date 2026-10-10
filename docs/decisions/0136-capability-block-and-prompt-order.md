# 0136. One capability block from the tools actually offered; helpful default posture

Date: 2026-10-10

Status: accepted (owner, 2026-10-10). Amends ADR 0085 (tool names in prose) and ADR 0087 (NOT AVAILABLE wording).

## Context
Live traces (2026-10-04..10, three guilds) showed:
- The bot denied having a reminders tool while `set_reminder` was declared.
- It invented "owner only" for the owner.
- It refused fiction as "outside what I help with".

The causes:
- Three sources disagreed: API tools, a WHAT YOU CAN DO list of skill ids with "you really can do this" suffixes,
  and OUTPUT RULES saying "never write a tool's name" and "never list what you can do".
- The bot's earlier replies to a different member were replayed in history.
- A wizard boundary sentence invited refusal.

## Decision
1. The system prompt carries one block, `WHAT YOU CAN DO RIGHT NOW`, generated from the exact declarations sent on
   that turn:
   - It is grouped by catalogue group, and each group names its tools.
   - Below the groups: "You also help with" (prose skills), then the "Not available to <name>" list with reasons.
   - It replaces ACTS_SUFFIX, SKILLS_PRECEDENCE_LINE and the evidence-rule's "Use only the abilities under WHAT
     YOU CAN DO".
2. Tool names may appear in the system prompt. The member-facing rule becomes "do not show tool names to members";
   the output guard still strips tool-call syntax.
3. Section order: surface, behaviour, safety suffix (fixed after behaviour, ADR 0074), output rules, evidence rule,
   server card, resources, task context, `now` (date, time, zone), `capabilities` last.
4. The user message ends, when history holds earlier bot replies, with: the abilities listed under WHAT YOU CAN DO
   RIGHT NOW are exact for this member, and an earlier reply that contradicts them was to someone else or is out of
   date.
5. The wizard's default boundary becomes helpful: "Help with any reasonable request…; decline only what the
   BANANASAURS RULES forbid". "WHAT YOU HELP WITH" becomes "FOCUS (where to look first, not a limit)".
   - USING SOURCES becomes: club sources first, then the web for general or current questions, and "couldn't find
     it" only after both.
   - ROLE uses "Bananasaurs" unless a bot name is set.
   - Stored prompts are rewritten at compile time.
6. A new non-acting skill `web-search` (default everyone) gates `web_search`, so the owner can narrow it on the
   Skills page.

## Consequences
- ADR 0085 decision 4 ("no tool names in prompt prose") is reversed for the capability block only.
- Tests that asserted the old section list, ACTS_SUFFIX and "Never mention tools" are updated.
