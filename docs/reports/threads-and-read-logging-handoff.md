# Handoff prompts — threads/forums, and MCP read logging

Two independent pieces of work, written to be handed to a fresh implementer
with no context from the session that produced them. Do them in either order;
they touch different files and neither depends on the other.

Both were designed on 2026-09-20 after the M6 live run
(`docs/reports/mcp-m6-live-run.md`).

---

## Prompt 1 — threads and forums

Copy everything between the rules into a fresh session.

---

You are implementing thread and forum support for Bananasaurs, a self-hosted
Discord bot for one engineering club.

**Read these first, in this order:**

1. `CLAUDE.md` — the hard rules. Rules 2 (guild scope), 3 (model output is
   untrusted), 6 (idempotency) and 8 (no autonomous write actions) all bear on
   this work.
2. `docs/superpowers/specs/2026-09-20-threads-and-forums-design.md` — the
   design. Its §2 holds eight owner decisions that are **settled**; do not
   re-litigate them. Its §3.1 is the rule the whole feature implements.
3. `docs/superpowers/plans/2026-09-20-threads-and-forums-plan.md` — the
   implementation plan. Ten tasks, each ending in a green gate and a commit.
4. `docs/reports/mcp-m6-live-run.md` §7a — one small defect folded into Task 8.

**What you are fixing.** Parentage is never consulted anywhere in the tree, and
that single omission causes three defects. The archive matches channel id by
exact equality, so an archive-enabled channel archives none of its threads and
an archive-enabled **forum archives nothing at all** — every forum post is a
thread. Automod evaluates thread messages but keys exemptions by channel id, so
a thread inside an exempt channel is not exempt. And neither threads nor
categories can be authorized for sends.

**Work the plan task by task.** Each task is test-first: write the failing test,
run it and watch it fail, implement the minimum, run it and watch it pass,
commit. Do not skip watching a test fail — this project has a documented history
of guards that never could have fired.

**Constraints that will bite you if you ignore them:**

- **`npm run build` on this box is a deployment.** systemd runs this checkout's
  `dist/`. Do not build casually. Do not run `db:migrate` against the live
  database; the owner does that deliberately, stop → migrate → start.
- **Do not modify `packages/core/src/effects/gateway.ts`.** It stays
  byte-identical (ruling M5-D1).
- **Do not change `allowedMentions` handling in the send path.** It was verified
  against Discord's own message object on 2026-09-20 and must stay as it is.
- **Task 6 touches the frozen automod package.** It is safe only because
  `mod_rule_exemptions` holds zero rows — read spec §7 before starting it, and
  do not create an exemption on the live database before
  2026-09-27T02:49:57.656Z.
- **Task 3's migration must be inspected by hand.** drizzle-kit 0.31.10 emits an
  invalid `CREATE INDEX` when rebuilding a table carrying a sort-ordered index
  (ruling M5-D7), and `archive_messages` carries two. Confirm the foreign key to
  `archive_channels` survives the rebuild — the whole design depends on it.
- **Every gate must pass before you call a task done:**
  `npm run typecheck && npm run lint && npm run test`. Do not report completion
  on code you have not run.

**Two asymmetries are deliberate. Do not "fix" them.** The archive records
`channel_id` as the *authorized parent* with `thread_id` beside it, because
`archive_messages` has a foreign key to `archive_channels` and a thread has no
row there. Automod records the *thread's own id*, because a reviewer needs to
open the thread the match happened in.

**When you finish**, every item in the plan's "Finish condition" must hold, and
`docs/STATE.md` needs a short entry describing what shipped. Do not merge to
`main` — leave the branch and give the owner the merge command.

---

## Prompt 2 — MCP read logging (the middle path)

Smaller and independent. Copy everything between the rules.

---

You are adding read logging to the MCP operator connector in Bananasaurs, a
self-hosted Discord bot.

**Read first:** `CLAUDE.md` (hard rules 2 and 4 especially),
`docs/reports/mcp-m6-live-run.md` §5 — which is where this gap was found —
and `packages/http/src/oauth/bearer.ts:56-76`, which is the pattern to follow.

**The problem.** MCP read tools write no audit row and emit no log line. The
MCP modules contain no `logger.info` or `logger.warn` at all. So a connector
that can read archived member messages, moderation cases and the audit trail
leaves **no server-side trace of what was read**. During the M6 live run this
meant the operator could not verify which tools had run, only that some
authorized calls had happened.

**The decision, already made by the owner: the middle path.** Not everything is
audited, because reads are frequent — thirteen calls in one short session — and
an audit row per read buries the human-meaningful signal. Split by whether the
tool touches members' words.

**Audit these, as rows in `audit_events`,** because each returns member content
or moderation history:

- `search_messages`, `read_channel_history`, `get_message`
- `list_mod_cases`, `get_mod_case`
- `list_audit_events`

**Log these at info, no audit row,** because they return structure, not content:

- `get_health`, `list_channels`, `list_roles`, `list_members`

**What each record must carry:** the guild id (hard rule 2 — explicit, never
implied), the tool name, the OAuth token id, the account id, and the *shape* of
what was asked — a channel id, a case id, a result count. **Never the query
string, never returned content, never a message body.** A log of what someone
searched for is itself a record of member content.

**One wrinkle you must handle: auditing `list_audit_events` is self-referential.**
Reading the audit trail writes a row to the audit trail, so repeated reads grow
it without bound and each read returns rows generated by the previous read.
Decide and document one of: exclude `list_audit_events` from its own results;
or audit it but have the tool filter its own action out of what it returns.
Pick one, write the reason in the ADR, and test it — an operator watching the
trail grow because they looked at it is a real failure mode.

**Before implementing, write a short ADR** in `docs/decisions/`, numbered
sequentially, recording the middle path and why the split falls where it does.
`CLAUDE.md`'s working style requires consequential choices be recorded before
implementation, and this one is consequential: it decides what is knowable after
the fact about who read members' messages.

**Test first.** Assert that a content-bearing read writes exactly one audit row
carrying the right guild, and that a structural read writes none. Assert that no
query string and no returned content appears in either the row or the log line —
watch that test fail before you make it pass.

**Gates:** `npm run typecheck && npm run lint && npm run test` must all pass.
**Do not run `npm run build`** — on this host it is a deployment.

Leave the branch unmerged and give the owner the merge command.

---
