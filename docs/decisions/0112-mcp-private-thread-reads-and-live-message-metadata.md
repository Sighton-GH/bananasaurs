# ADR 0112: MCP private-thread reads, live message metadata, and migration ordering

Status: accepted (2026-09-30)

Amends: ADR 0047 ("private threads never inherit") for MCP reads only.
Spec: `docs/superpowers/specs/2026-09-29-mcp-connector-v2-design.md` §4.4, §6.4 (owner decision D6).

## Decision

1. **Private-thread reads (D6).** An MCP read tool may read a private thread
   when it was created through the MCP (slice 3 records these in
   `mcp_private_threads`), or when a live check shows that **both the bot and
   the owner's Discord account (`BANANASAURS_OWNER_USER_ID`) are members of
   the thread**. The owner requested this: "if i tag the bot in a private
   thread (add it in) it should be able to read the contents". Membership is
   checked through Discord's thread-member endpoint on every read, never
   cached. Private-thread content is fetched live over REST and **never
   written to the archive**; archive and send scope keep ADR 0047's rule that
   private threads never inherit. The ADR 0050 read record is a content read
   with `subjectType: 'private_thread'`.
2. **Live message metadata.** Reactions and pin state are read live in
   `get_message` (one REST call), not stored. Reply links
   (`reply_to_message_id`) and mentioned roles (`mentioned_role_ids`) are
   stored in the archive at ingestion, because listing and
   `list_unanswered` need them in bulk. This replaces the spec's
   `archive_reactions` table, which would have needed reaction-count
   bookkeeping that drifts on missed gateway events.
3. **Migration numbering and ordering.** This work's migrations use tags
   `0080`–`0089` (journal `idx` stays sequential). The Drizzle migrator
   applies a migration only if its journal `when` is later than the newest
   migration already applied (`drizzle-orm/sqlite-core/dialect.js`, the
   `created_at <` check). So when this branch and the task-tracking branch
   are merged in either order, **the branch merged second must re-stamp its
   journal `when` values above the other's**, or its migrations are silently
   skipped. Slice 2 adds a test asserting journal `when` values strictly
   increase in journal order, so a bad merge fails CI instead of production.

## Consequences

- A member who adds the bot to a private thread does not expose it to the
  MCP unless the owner is also in that thread.
- `get_message` on a private or deleted message still answers from the
  archive; the live metadata is omitted when the fetch fails.
- The owner, or whoever merges second, must re-stamp journal timestamps.
  The test tells them.
