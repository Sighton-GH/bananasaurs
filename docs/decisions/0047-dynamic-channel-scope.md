# ADR 0047: Dynamic channel scope through parents and categories

Status: Accepted

## Decision

Archive and MCP send scope is resolved at use time. An exact channel row authorizes that channel. A public thread can inherit its parent, and a channel or public thread can inherit a category row. Private threads never inherit. Archive parent inheritance additionally honors `include_threads`; send inheritance does not. Exclusions on the thread, parent, or category veto archive scope.

## Trade

Anyone with Manage Channels can move a channel into an authorized category and thereby grant the bot posting rights there. This avoids stale copied allowlists when channels move.

## Mitigations

- Private threads never inherit.
- Derived sends write an audit event naming the row that granted access.
- Operator listings resolve and display current coverage rather than presenting category ids as literal channel lists.

Revisit this decision if the moderator roster grows, or if anyone with Manage Channels is no longer trusted with the bot's effective posting scope.

## Amendment 2026-09-20: derived rows satisfy the message foreign key

`archive_messages` carries a composite foreign key to
`archive_channels(guild_id, channel_id)`. Under the original decision a
channel covered only by a category row had no `archive_channels` row of its
own, so the first archived message for such a channel violated the foreign
key (`foreign_keys = ON` in production), the pipeline logged one error per
message, and the archive silently held nothing from the category.

The fix keeps scope dynamic and satisfies the foreign key:

- `scope_kind` gains `'derived'`, and `archive_channels` gains a
  `derived_from` column naming the category row the derived row came from.
- A derived row is materialised lazily, inside the same write as the first
  message upsert for that channel, and eagerly by `archive enable-category`
  for each covered channel so its backfill has a cursor row. A later
  `archive enable-channel` on the same channel upgrades the derived row into
  an explicit channel row.
- **Authorization never reads a derived row.** `isInScope` keeps deciding
  from the category row: `isChannelEnabled`, `hasCategoryRow` and
  `parentIncludesThreads` do not match derived rows, so scope stays dynamic
  and a channel moved out of the category stops being archived immediately,
  exactly as the original decision promises. The derived row exists only to
  satisfy the foreign key and to own the `ON DELETE CASCADE`.
- `archive disable-category` deletes the category row and its derived
  children, so their messages cascade the way `disable-channel`'s do.
- A derived row left behind because its channel moved out of the category
  keeps its already-archived messages. Archiving stopped the moment the
  channel moved; the history that accrued while the channel was covered is
  retained, matching what an explicit `disable-channel` would have destroyed
  only by operator choice.

The Trade and Mitigations above are unchanged: the granting row an audit
event names is still the category row, and operator listings still resolve
current coverage rather than presenting category ids as literal channel
lists. Reading a forum channel's history rolls its threads up into the
parent read (every forum message carries a thread id, so a
top-level-messages-only read of a forum is always empty); per-thread reads
are unchanged.

## Amendment 2026-09-20b: the operator's verb for a derived row

The amendment above says an orphaned derived row keeps its history, "matching
what an explicit `disable-channel` would have destroyed only by operator
choice". As first written that choice did not exist: `disable-channel` answered
a derived row with `wrong-kind` and the text "archived as a category; use
archive disable-category", and `disable-category` answered it with "archived as
a channel; use archive disable-channel". The two verbs pointed at each other and
neither statement was true.

`disableChannel` now answers `'derived'`, and the daemon — the only layer that
can see live category membership — resolves it:

- **Still covered by an enabled category:** refused, naming the category. There
  is nothing to disable, because the next message would re-materialise the row;
  the operator is pointed at `archive disable-category <categoryId>`, or at
  excluding the single channel from logging.
- **Orphaned** (the channel moved out of the category): the row and its
  messages are deleted, which is the operator choice this amendment promised.

`archive status` also marks a derived row as `derived from <categoryId>` rather
than listing it as if the operator had enabled it: a derived row materialised by
the live path carries `backfill:pending` forever, because no backfill is queued
for it, and an unmarked row invited an operator to chase a job that will never
run.
Amended by ADR 0126 (2026-10-02): scope gains a `read` purpose for live Discord fetches, resolved with the same precedence.

