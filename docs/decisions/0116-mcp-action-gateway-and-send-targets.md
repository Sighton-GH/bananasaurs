# ADR 0116: MCP action gateway, the `mcp_actions` ledger, and send targets

Status: accepted (2026-10-01)

Amends: the slice M5 message gateway (`packages/core/src/effects/message-gateway.ts`) for MCP use.
Spec: `docs/superpowers/specs/2026-09-29-mcp-connector-v2-design.md` §3.1, §3.2, §5.1, §6.2, §6.3 (owner decisions D3, D7, D9, D10, D13).

## Decision

1. **One pipeline for every MCP write.** A new core module,
   `packages/core/src/effects/mcp-action-gateway.ts`, runs each MCP write
   through one fixed order: target policy → kill switch → breaker → ledger
   read (replay, or refuse on an argument mismatch) → rate cap → ledger claim
   → dry run → the single Discord call → record and audit. This is the order
   the M5 message gateway already uses and argues for (a replay is not a new
   action, so it is read before the cap, and the claim sits just before the
   call). The gateway respects the circuit breaker but never trips it (M5-D12).
2. **`mcp_actions` is the ledger** for every MCP write, keyed
   `(guild_id, idempotency_key)` and unique. Each row holds the action `kind`,
   an `args_hash`, `status`, the resulting ids, an optional `undo_json`, the
   token id, and timestamps. `send_message` moves onto it: migration `0081`
   copies every `mcp_sends` row into `mcp_actions` (kind `message.send`,
   `args_hash` = the old `content_hash`), and `mcp_sends` becomes history that
   nothing writes. A plain-text send's `args_hash` is still
   `contentHashFor(channelId, content)`, so a retry that straddles the deploy
   replays rather than posting twice. Any other argument shape hashes a
   canonical JSON of the arguments.
3. **Send targets: send scope ∩ live bot permission (D10).** A target passes
   only when ADR 0047's `isInScope('send', …)` grants it **and** the bot's
   live permissions in that channel include what the action needs
   (`SendMessages`; `SendMessagesInThreads` in a thread; `CreatePublicThreads`
   or `CreatePrivateThreads`; `ManageMessages` to pin; `ManageThreads` to lock
   or archive a thread the bot did not create). Private threads still never
   inherit. A private thread created through the MCP gets its own
   `mcp_send_allowlist` row and a `mcp_private_threads` row, so ADR 0115's
   read rule ("created via MCP") covers it.
4. **Edit and delete (D7).** Allowed only on messages the bot authored,
   checked live. Role-panel messages (`panels.message_id`) and task anchors
   (`task_message_anchors.message_id`) are refused. The eligibility check
   lives behind a `ProtectedMessagePort` that the daemon implements, so core
   has no knowledge of either table.
5. **Undo.** Reversible actions record their inverse in `undo_json`:
   - an edit records the previous content and embeds (the bot's own text);
   - a pin records an unpin, and an unpin records a pin;
   - an added reaction records its removal;
   - a thread-member add records the removal;
   - a thread archive or lock records the previous state.

   `undo_action(actionId)` runs the inverse through the same gateway with the
   key `undo:<actionId>`, so an undo happens at most once. Posts, deletes,
   thread creation and forum posts cannot be undone, and the tool says so.
6. **Caps (D13)** are per guild per rolling hour, counted from `mcp_actions`
   by cap group:
   - messages: 300;
   - edits and deletes: 300;
   - threads: 100;
   - pins and reactions: 300.

   Slice 5 moves these numbers into tuning settings. Refusals and replays do
   not count against a cap.
7. **The identical-content window** (M5-D8 layer B, 60 seconds) still applies
   to message posts.

## Consequences

- One ledger answers "what did the MCP do": `list_jobs`-style history,
  undo, and the audit trail all key off `mcp_actions.action_id`.
- `sendMessageEffect` stays, unchanged, for any non-MCP caller. The MCP no
  longer calls it.
- Every new write tool is registered only under the `bananasaurs:send` scope.
- The task-tracking module already has its own anchor-posting path, so it
  does not need this gateway. Its write tools move from `hasSendScope` to
  `hasTasksScope` (ADR 0101's follow-up and ADR 0114's scope split).
