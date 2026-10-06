# ADR 0126: Channel Read, Write and Archive are independent, enforced permissions

Status: Accepted (2026-10-02). Amended (2026-10-03): Write seeds with Read;
private threads inherit Read and Write. Amended (2026-10-04): MCP v2
surfaces share the one `ChannelAccess` precedence (task 15); a guild not
yet cached is a transient retry, never a denial; MCP scheduled-send denials
stay terminal; both seeds record one system audit row (task 17).

Amends: ADR 0009 (archive off no longer destroys), ADR 0047 (adds the `read` purpose),
ADR 0089 (the channel-context window needs Read).

## Decision

- Each channel and category carries three independent switches: Read, Write and Archive.
  All three default to off. No access overrides all three.
  - **Read** gates live Discord fetches beyond the tagging message and the message it
    replies to.
  - **Archive** gates recording.
  - **Write** gates posting, including the assistant's answer.
- One guild-bound port, `ChannelAccess`, built on `isInScope`, is how surfaces
  that resolve live channels ask. Every surface uses the same
  `isInScope`/`isNoAccess` predicates. Checks run at the moment of use and
  fail closed on unknown channels. Every denial is recorded.
- Archived copies are searchable while a row exists and the channel is not No access.
- Turning Archive off pauses recording (`archive_channels.collecting = 0`) and deletes
  nothing. Deletion is a separate, explicit action.
- Read and Write are each seeded on, once, at first start, for every category
  and uncategorised channel the bot can see; new uncategorised channels start
  off, and a channel added to a seeded category follows the category.
  Because Write is the MCP send allowlist, the seed also lets the
  owner's connector post there.
- Private threads use their parent's Read and Write; they never inherit Archive.
- Operator-configured posts (log channel, escalation, panels, log forwards), moderation and
  automod are exempt, and the dashboard lists them as exempt.
- Archiving stays live. A daily batch was rejected because it costs more REST traffic, loses
  same-day deletes and leaves the archive stale.

## Consequences

- An excluded channel no longer reaches any AI provider.
- With Read off, the assistant can still answer from the archive, which may be stale.
- A Write-off channel silences the bot there. Members see no reply; the mention
  is dropped before any run, and a log line records it — there is no run, so
  no trace.
- Archive off keeps history readable until it is deleted. PRIVACY.md must say so.
- Reminders denied Write fail permanently at delivery (no set-time refusal yet).
- Task 15 brings the MCP v2 surfaces under the same precedence: send targets
  (including the forum postable gate) resolve through `check('write', …)` —
  `private-thread-not-allowed` is gone, a private thread under a Write parent
  is a valid target — and a due scheduled send re-checks Write at delivery,
  settling terminally as `write-denied` with one ids-only line; `read_thread`
  answers empty for a No-access thread on its archive path and requires Read
  on its live path; live pin/reaction metadata requires Read and answers
  `undefined` when denied; the digest and unanswered-mentions ports drop rows
  whose channel or thread is No access.
