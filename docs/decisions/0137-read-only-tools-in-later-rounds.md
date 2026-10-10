# 0137. Read-only tools in any round; acting tools first round only

Date: 2026-10-10

Status: accepted (owner decision D2, 2026-10-10). Amends ADR 0071 and the wording of CLAUDE.md hard rule 3.

## Context
ADR 0071 allowed only `read_chunk`, `open_resource` and `channel_history` (with a returned id) after round 1. That
blocked "search club sources, find nothing, search the web" (the TRIUMF run: second `web_search` refused, then a
timeout), `current_time → set_reminder`, and `my_reminders → cancel_reminder`.

## Decision
Each `TOOL_CATALOGUE` entry declares `rounds`:
- `all`: every read-only tool, including `web_search`. The owner accepted that a later-round web query can be shaped
  by text read earlier (exfiltration risk); queries still pass the local query scan.
- `returned-id`: `read_chunk`, `open_resource`, `channel_history`, `edit_reminder` and `cancel_reminder`. In round
  2+ they need an id argument an earlier result in the same request returned (`read_chunk`/`open_resource`/
  `channel_history` keep their round-1 freedom).
- `first`: every other acting tool (`set_reminder`, `propose_memory`, `propose_decision`).

The loop's offer (`declarationsFor`) and its enforcement read the same field.

New CLAUDE.md hard rule 3 sentence: "A turn whose only new input is retrieved text may not emit an **acting** tool
call, except one that acts on an id an earlier result in the same request returned (ADR 0071, ADR 0137)."
