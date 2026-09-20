# Threads and forums across the bot — design

**DRAFT — 2026-09-20.** Owner decisions are §2 and are settled; everything
else is open to revision. Written after the M6 live run
(`docs/reports/mcp-m6-live-run.md`) surfaced that thread conversations are
invisible to the archive and to the MCP connector.

---

## 1. The problem, stated precisely

Three separate defects, one shared cause — parentage is never consulted.

**The archive does not see threads.** `packages/core/src/archive/subscriber.ts:66-67`
matches `event.channelId` against `archive_channels` by **exact equality**. A
message posted in a thread carries the *thread's* id, not its parent's. So
enabling `#general` archives `#general` and nothing said in any of its threads.
Forum channels hold no messages at all — every forum post *is* a thread — so an
archive-enabled forum archives literally nothing. On a club server where real
discussion migrates into threads, the archive silently under-collects, and the
MCP tools built on it (`search_messages`, `read_channel_history`, `get_message`)
return confident, incomplete answers.

**Automod over-applies in threads.** The automod subscriber has no channel
filter, so it *does* evaluate thread messages — threads are already in the
observe corpus. But exemptions are keyed by channel id
(`packages/core/src/automod/subscriber.ts:119`), so a thread inside an exempt
channel is **not** exempt. Same missing-parentage bug, opposite consequence:
the archive under-collects, automod over-enforces.

**The bot cannot post to threads, and authorization is per-channel only.**
`mcp allow-channel` refuses anything that is not a text-postable channel of
that guild, so a thread or a category cannot be allowlisted, and an allowlisted
parent does not cover its threads.

A fourth, smaller gap found while scoping: **`mod_cases` and `mod_case_events`
record no channel id**, so per-channel false-positive analysis is impossible at
the Release 2 gate and "did this match come from a thread?" is unanswerable.

## 2. Owner decisions — settled 2026-09-20

1. **Scope resolution is dynamic**, evaluated at use time, not expanded into
   rows at authorize time. A channel moved into an authorized category becomes
   authorized; a thread follows its parent automatically.
2. **Private threads are never archived and never inherit send authorization.**
   A fourth veto alongside ADR 0046's three. Posting into a private thread
   requires naming that thread explicitly.
3. **Thread archiving is all-or-none per parent channel.** No per-thread
   allowlist. Rejected as YAGNI: threads are transient, so named-thread rows go
   stale on their own.
4. **Backfill walks existing threads**, both active and archived, when a
   channel or forum is first enabled.
5. **Discovery is a new `list_threads(channelId)` tool.** `list_channels` keeps
   returning the stable room list.
6. **`read_channel_history` returns a channel's own messages only.** Threads are
   read by passing the thread's id.
7. **Categories authorize both sends and archiving.** This relaxes ADR 0046's
   per-channel rule and requires an amendment — see §10.
8. **The automod changes ship in Phase 1, inside the observe window.** Justified
   in §7.

## 3. Mechanism — enrich events, resolve on demand

Two paths with genuinely different constraints, so two mechanisms.

**Events carry their own parentage.** The Discord adapter attaches
`parentChannelId` and `categoryId` to every message event. Subscribers on the
hot path — archive, automod — then answer "is this in scope?" from data already
in hand, with no lookup and no network call. This is the only change that
touches per-message code, and it must not be able to make a network request.

**A resolver serves the occasional callers.** A `channelScope` module walks
thread → parent → category, cache first with a REST fallback, for callers that
are human- or AI-initiated and infrequent: `send_message`, `list_threads`,
`mcp allow-category`, `archive enable-category`, and the CLI. REST fallback is
acceptable here precisely because these are not per-message.

The split matters because discord.js's **default sweeper evicts archived
threads from cache after four hours** (`buildSweeperSettings` overrides only
`messages` and `users`, so `Options.DefaultSweeperSettings.threads` applies).
A resolver that trusted the cache would silently fail on older threads. A hot
path that fell back to REST would put a network call inside message handling.
Neither is acceptable, and one abstraction cannot satisfy both.

No new gateway intent is required: `GuildMessages` already delivers thread
messages. `ThreadMemberManager` stays capped at 0 — thread *membership* is not
needed, only parentage.

### 3.1 The resolution rule, once

A channel is **in scope** for a given purpose (archive or send) when any of:

- its own id has a row for that purpose; or
- it is a public thread whose **parent channel** is in scope; or
- its **category** is in scope for that purpose.

And never when:

- it is a private thread (`PrivateThread`), for either purpose, unless its own
  id is explicitly rowed; or
- it is in `log_excluded_channels` — the existing exclusion still wins, and
  **exclusion is checked on the thread, its parent and its category**, so
  excluding a parent excludes its threads.

Every consumer calls one predicate. The rule lives in exactly one place and is
tested there.

## 4. Data model

Minimal, because the model is dynamic — rows say what a human authorized, not
what it expands to.

```
archive_channels       -- add: scope_kind TEXT NOT NULL DEFAULT 'channel'
                       --      ('channel' | 'category')
                       -- add: include_threads INTEGER NOT NULL DEFAULT 1

mcp_send_channels      -- add: scope_kind TEXT NOT NULL DEFAULT 'channel'
                       --      ('channel' | 'category')

archive_messages       -- add: thread_id TEXT NULL
                       --      channel_id keeps meaning THE AUTHORIZED PARENT

mod_case_events        -- add: channel_id TEXT NULL   (§7)
```

`include_threads` is the all/none toggle from decision 3, defaulting to on. On
a **forum** it is always 1: a forum with threads excluded would archive
nothing, which is not a state worth being able to express, so
`archive set-threads <forum-id> none` is **refused with a message saying why**
rather than silently stored or silently ignored. The column still exists on a
forum's row, always 1, so the predicate needs no special case.

**`archive_messages.channel_id` must keep meaning the authorized parent
channel, with the thread's own id going into a new nullable `thread_id`.** This
is forced, not stylistic. That table carries a foreign key on
`(guild_id, channel_id)` → `archive_channels`, `ON DELETE CASCADE`
(`packages/storage/src/schema.ts:934-937`). A thread has no `archive_channels`
row under the dynamic model, so writing a thread's id into `channel_id` would
make **every thread insert fail the foreign key**. Keeping `channel_id` as the
parent means:

- the foreign key is untouched, and `archive disable-channel` still cascades a
  channel's thread messages away with it — which is the correct behaviour;
- existing rows stay valid unchanged, with `thread_id` NULL;
- "everything said in `#help`, threads included" is a plain
  `channel_id = '<help>'` query against the existing
  `archive_messages_channel_created` index, with no resolution walk over
  historical rows whose threads may since have been deleted;
- for a **forum**, `channel_id` is the forum and `thread_id` is the post, so a
  forum's rows hang off the forum's own authorization row.

Everything that reports a message — the MCP evidence envelope, `archive
search`, `get_message` — must surface `thread_id` when it is set, or a quote
from a thread will be cited as though it came from the parent channel.

Every new column is additive and nullable or defaulted, so the migration is
safe on the live database. **Note the drizzle-kit 0.31.10 defect recorded as
ruling M5-D7**: it emits an invalid `CREATE INDEX` when rebuilding a table that
carries a sort-ordered index. `archive_messages` carries one. The generated
migration must be inspected and corrected, and the schema-invariants proof must
assert the index survives.

## 5. Archive changes

- The subscriber's two-line veto becomes a call to the §3.1 predicate, using
  the parentage now on the event. No network call.
- Writes record `thread_id` (NULL for a message in the channel itself), with
  `channel_id` set to the authorized parent — see §4.
- Backfill gains a thread walk: for each newly enabled channel, enumerate
  **active** threads (`GET /guilds/{id}/threads/active`) and **archived** public
  threads (`GET /channels/{id}/threads/archived/public`, paginated), then
  backfill each as its own cursor. Private archived threads are not fetched at
  all. For a forum, this is the entire backfill — the forum itself holds no
  messages.
- Backfill must report progress per thread, because a forum with hundreds of
  posts is a long operation and `archive status` currently shows one cursor per
  channel. A forum's status should name how many threads are done of how many
  found.
- Expiry and the 30-day purge are unchanged: they operate on
  `archive_messages` rows and neither knows nor cares that a row came from a
  thread.

## 6. MCP read surface

- **New tool `list_threads`** — arguments `guildId`, `channelId`, optional
  `includeArchived`. Returns public threads only, each with id, name,
  `parentId`, `archived`, `messageCount`, and whether it is archive-enabled.
  Refuses a private thread's id as an argument and never lists one.
- `list_channels` gains `isForum` and keeps excluding threads, unchanged
  otherwise.
- `search_messages` and `read_channel_history` accept a thread id wherever they
  accept a channel id, and their visibility set — built from archive-enabled
  channels, narrowable by a caller argument but never widenable — is computed
  through the §3.1 predicate so that a thread under an enabled parent is
  genuinely visible rather than incidentally reachable.
- `get_message` is unchanged; it already works by message id.
- Every result that came from a thread carries `threadId`, its parent `channelId` and a
  `threadName` in its evidence envelope, so the AI can cite *where* a quote
  came from. A quote attributed to `#help` that actually came from a thread
  inside it is a citation error, and the envelope exists to prevent exactly
  that.

## 7. Automod changes — Phase 1, inside the observe window

Two changes, both inside the frozen package, both justified as safe to land
during the window.

**Exemption inheritance.** `isExempt` consults the thread's parent and category
as well as its own id, via the §3.1 predicate.

**Why this is inert today, and therefore safe:** `mod_rule_exemptions` holds
**zero rows** on the live database, so inheritance cannot change any verdict
until the first exemption exists. Threads are *already* evaluated — the
subscriber has no channel filter — so the change neither adds nor removes
traffic from the measurement. The window's corpus is 18 matches on the club
between 2026-09-13 and 2026-09-20, all `would_delete`; none of them can be
affected by a rule that only ever widens exemption.

**Residual risk, accepted:** the evaluator binary changes mid-window. If an
exemption is created before the floor elapses (2026-09-27T02:49:57.656Z),
behaviour diverges from what the window began under. **Mitigation:** record the
evaluator-change date in `docs/reports/release2-gate-signoff.md`, and create no
exemptions until the floor passes.

**Channel recording.** `mod_case_events.channel_id` is written on every match.
Nothing reads it yet. Without it, per-channel false-positive analysis is
impossible at the gate, and the question this very design had to ask — "did any
match come from a thread?" — cannot be answered. The existing 18 rows stay
`NULL` and are documented as pre-dating the column.

## 8. Send path

- `send_message` accepts a thread id. Authorization resolves through §3.1, so
  an allowlisted parent or category covers its public threads.
- **Private threads are refused** with their own message, distinct from the
  not-allowlisted refusal, naming the private-thread rule — a caller who gets
  the generic refusal will otherwise try to allowlist the parent and be
  confused when it still fails.
- The ten-per-guild-per-hour cap is unchanged and counts thread sends the same;
  the cap is about the guild, not the room.
- `allowedMentions` handling is untouched. It was verified live on 2026-09-20
  (`mention_everyone: false` from Discord's own message object) and must stay
  exactly as it is.
- **An audit event records when a send was authorized by category or by
  parentage rather than by the channel's own row.** This is the visibility
  mitigation for the trade in §11.

## 9. CLI surface

```
bananasaurs mcp allow-category <id> --guild <id> --confirm
bananasaurs mcp disallow-category <id> --guild <id> --confirm
bananasaurs archive enable-category <id> --guild <id> --confirm
bananasaurs archive disable-category <id> --guild <id> --confirm
bananasaurs archive set-threads <channel-id> all|none --guild <id> --confirm
bananasaurs archive threads <channel-id> --guild <id>      # status per thread
```

`mcp allowlist` and `archive status` must show **what a row authorizes**, not
just its id — a category row should say how many channels it currently covers,
and that count is resolved live, because under a dynamic model the number is
not a property of the row. A listing that shows only ids would make the
dynamic model unreadable to an operator.

**Also fix here** (found during the M6 live run, `docs/reports/mcp-m6-live-run.md`
§7a): `packages/mcp/src/tools/send.ts:171` suggests
`bananasaurs mcp allow-channel <id> --confirm` with no `--guild`, which fails
verbatim on a two-guild instance. One interpolation.

## 10. ADR work required

- **ADR 0046 amendment** — decision 7 relaxes "a channel must still be enabled
  one at a time" to permit category-level enabling. The amendment must state
  what replaces the friction that rule provided: the guild veto is unchanged,
  private threads are newly excluded, and `archive enable-category` reports the
  channel and message count it is about to ingest before acting.
- **A new ADR for the scope model** — the dynamic-resolution decision and the
  §11 trade, so that "why isn't the allowlist a literal list?" has an answer
  that isn't archaeology.

## 11. The accepted trade, recorded

**Under dynamic resolution, anyone with Manage Channels can move a channel into
an authorized category and thereby grant the bot the ability to post there.**
Other members hold Administrator on the club guild (`docs/STATE.md`, open
question 4), so this widens who effectively controls the send allowlist from
"the owner, by CLI" to "anyone who can rearrange channels."

The owner accepted this on 2026-09-20 in exchange for not having to re-authorize
as channels change. It is mitigated, not eliminated, by:

- the audit event in §8 naming category- or parentage-derived authorization;
- `mcp allowlist` resolving and showing live coverage (§9), so the widening is
  visible on inspection;
- private threads never inheriting (decision 2).

This trade should be revisited if the club's moderator roster grows, or if
anyone with Manage Channels is not also someone trusted with the bot.

## 12. Testing

Write the test first for everything touching scope resolution, parentage,
private-thread exclusion and guild scope — `CLAUDE.md`'s rule, and this feature
is nothing but those.

- **The §3.1 predicate is the centre of gravity.** A table-driven suite over
  every combination of: own-row / parent-row / category-row / no row ×
  public thread / private thread / text channel / forum post × excluded /
  not excluded. This is where a mistake becomes a privacy incident.
- **A private thread is never archived and never postable** even when its
  parent and category are both authorized — asserted directly, watched failing
  first.
- **Guild scope holds through parentage**: a thread whose parent is in another
  guild resolves to no scope. Fabricate the case; it cannot occur naturally,
  which is exactly why the guard needs a test.
- **Backfill over a forum** with active and archived threads, asserting
  per-thread cursors and that private archived threads are never fetched.
- **Automod exemption inheritance**, including the case that matters: a thread
  under an exempt parent is exempt, and a thread under a non-exempt parent in
  an exempt category is exempt.
- **The evidence envelope carries `threadId`** for every thread-sourced
  result, so citations cannot silently attribute a thread quote to its parent.
- **Idempotency is unchanged**: a send to a thread under the same key still
  produces exactly one message.

## 13. Sequencing

**One phase, not two.** The freeze analysis in §7 removes the reason to split
the automod work out — "Phase 1" elsewhere in this document means this single
body of work. Suggested order, each step landing green:

1. Event enrichment (`parentChannelId`, `categoryId`) + the §3.1 predicate and
   its test suite. No behaviour change yet.
2. Schema migration (§4), with the M5-D7 index defect checked by hand.
3. Archive: subscriber veto through the predicate, parentage recorded, thread
   backfill.
4. Automod: exemption inheritance + `channel_id` recording.
5. Send path: thread sends, private-thread refusal, category authorization,
   the audit event, and the §9 `--guild` fix.
6. MCP: `list_threads`, thread ids accepted, envelope parentage.
7. CLI: the category and thread commands, listings that resolve coverage.
8. ADR 0046 amendment + the new scope-model ADR.

Steps 1 and 2 are prerequisites for everything after; 3 through 7 are
independent of each other once those land.

## 14. Out of scope

- Per-thread allowlists (decision 3).
- Posting into private threads by inheritance (decision 2) — naming a private
  thread explicitly is permitted and is the escape hatch.
- Reading thread *membership* — `ThreadMemberManager` stays at 0.
- Any Release 3 AI work. This design makes threads reachable by the tool layer;
  what an AI does with them is a later decision.
- MCP read logging. Related but independent; its own brief.
