# 0046 — Archive ingestion and search are pulled forward, with retention from day one and an enforced real-guild precondition

Status: accepted
Date: 2026-09-13
Precedes Slice M1 of
`docs/superpowers/plans/2026-09-12-mcp-operator-server-plan.md` (design:
`docs/superpowers/specs/2026-09-12-mcp-operator-server-design.md`, D1, §7,
§11).
Depends on ADR 0009 (archive scope is default-deny), ADR 0016 (job dedupe
keys), ADR 0018 (the REST port refuses rather than waits), ADR 0037 (the
`mod_cases` a deleted message can be pinned to).
Constrained by `CLAUDE.md` rule 2 (guild scope), rule 4 (redaction is an
allowlist), rule 5 (no provider receives content without a `trainsOnInput:
"no"` row), rule 8 (no broad guild access without an instruction — the owner's
D1 is that instruction), and `PRIVACY.md`'s promise that nothing is used to
train models.

## Context

The owner's decision D1 (2026-09-12) pulls two Release 3 items — R3-1 archive
ingestion and R3-2 FTS5 search — forward into Release 2's observe window so
the MCP operator server has something to read. The design's §7 specifies
what comes forward and §7.4 what deliberately does not: `/mydata`,
`/forgetme` and the member opt-out stay in Release 3.

§7.4 rests on D4's premise: *"the bot is in a test guild only; there are no
real members' messages in the system."* **That premise is no longer true.**
On the evening of 2026-09-12 the owner added the SFU Racerbot Club guild (210
members) to `BANANASAURS_GUILD_ALLOWLIST` and started the observe window
there (`docs/STATE.md`, "Release 2 observe window"). `STATE.md` already
records the consequence for fixtures: "`/mydata` and `/forgetme` are now
**owed**, not deferred." An archive that could be enabled on that guild by
one CLI command would make the same debt larger and harder to repay — a
fixture holds one matching message; an archive holds every message in a
channel.

So this ADR does what the design asked of it — records the pull-forward, the
attachment default, the retention tiers, and the real-guild precondition —
and, because the precondition can now be violated by a keystroke, **makes it
a check rather than a note**.

## Decision

### D1 — Archive scope is default-deny per channel, and additionally default-deny per guild

ADR 0009 stands: nothing is archived until
`bananasaurs archive enable-channel <id> --confirm` names a channel, and
`log_excluded_channels` is a second veto the subscriber honours even for an
enabled channel.

On top of that, **a guild may hold archive channels only if its id appears in
`BANANASAURS_ARCHIVE_GUILDS`**, a new environment variable parsed the way
`BANANASAURS_GUILD_ALLOWLIST` is (a comma-separated list of snowflakes,
validated by Zod at startup, **empty by default**). Both `enableChannel` and
the live subscriber check it: `enable-channel` refuses with a usage answer
(`'guild-not-archive-enabled'`) naming the variable, and the subscriber
writes no row for a guild not listed even if a row in `archive_channels`
somehow exists (a restore from an older backup, a hand edit). Two vetoes in
code, tested in both directions.

The precondition §7.4 records — that `/mydata` and `/forgetme` exist before
real members' messages enter the archive — is enforced by the operator not
adding the club guild to this list until they do. A future ADR that ships
the privacy surface removes nothing; it is the moment the operator may add
the id. `doctor` reports every guild in `BANANASAURS_ARCHIVE_GUILDS` that is
not in `BANANASAURS_GUILD_ALLOWLIST` (a typo) and every archive-enabled
channel the bot can no longer read.

Q4 of the design's §11 is answered by its default: **no channel enters
archive scope in M1.** The test guild may be added to
`BANANASAURS_ARCHIVE_GUILDS` at the owner's discretion; the club guild may
not, under this ADR, until the privacy surface ships.

### D2 — Attachments default to `none`

`archive_channels.attachment_policy` is `'none' | 'bytes'`, default `'none'`.
Under `none` an `archive_attachments` row records filename, declared content
type, size, and a SHA-256 **only if the CDN URL is still live at ingest**;
under `bytes` the file is fetched to `data/archive/<guild_id>/<sha256>`,
deduplicated by hash. `bytes` is built and tested because REVIEW §C1 says a
metadata-only archive is a dead archive and the choice is reversible only
forward — bytes never fetched cannot be fetched after the URL expires — but
nothing in Release 2 enables it, and the CLI flag that does is
`--attachments bytes` on `enable-channel`, never a default.

### D3 — Three-tier retention ships in the same slice as the table

REVIEW §A1's tiers, as the design's §7.2 states them:

| `retention_class` | Content |
| --- | --- |
| `default` — deleted, no case | tombstone forever; **`content` set to NULL and `content_purged_at` stamped 30 days after `deleted_at`** |
| `case` — deleted and linked to an open `mod_cases` row | retained until the case closes, then 90 days |
| `preserve` — the owner ran `archive preserve <message_id> --confirm` | indefinite; the audit row is the record |

A daily `archive_expiry` job on the job table enforces the tiers; the edits
table (`archive_message_edits`) is purged with the message it belongs to.
Retention is not retrofitted later because retrofitting is how a shadow
archive happens: the table and the job land in one migration commit, and
`PRIVACY.md` gains its archive rows in that same commit (Slice 2 precedent).

Live, undeleted messages in an archived channel are retained indefinitely
until the owner disables the channel or purges — `docs/09` already says so
and `PRIVACY.md` will say it in the same words.

### D4 — One throttled resumable backfill worker

`archive_backfill` is one job kind with the ADR 0016 dedupe key
`(guild_id, channel_id)`. It fetches 100 messages a page through the REST
port (which refuses on rate limit rather than waiting, ADR 0018 — the job
retries on the job table's schedule), persists `cursor_message_id` after
every page, and resumes from the cursor after a restart. Never parallel
fetches (REVIEW §C10).

### D5 — Live ingestion rides the existing pipeline

`MESSAGE_CREATE`, `MESSAGE_UPDATE`, `MESSAGE_DELETE` and
`MESSAGE_DELETE_BULK` reach a new `packages/core/src/archive/subscriber.ts`
through the same event pipeline and `event_dedupe` fingerprint every
subscriber uses, so a gateway replay cannot double-insert. The archive
subscriber is **read-side only with respect to moderation**: it never calls
the effect gateway, never touches `mod_rules` or `mod_cases` writers, and
runs after the automod subscriber so a message the automod deletes is still
archived as created-then-deleted. The observe clock is unaffected because
nothing the archive does is visible to `mod_rules`.

### D6 — Search is FTS5 with permission-filtered citations, in M2

`archive_messages_fts` (FTS5, external content, `content` column only) and
`searchMessages(scope, { query, channelIds, limit })`. The citation filter
runs against the caller's effective channel visibility — for the MCP
operator, the archive-scope set — and filters the **citation list**, not the
excerpt text, so a private channel's existence cannot leak through a hit
count (§7.3). Rebuilt from `archive_messages` on demand; content purged by D3
is removed from the index in the same expiry transaction.

## Consequences

- Five new tables (`archive_channels`, `archive_messages`,
  `archive_message_edits`, `archive_attachments`, and the FTS5 virtual table
  in M2), each with `guild_id`, the snowflake CHECK and the cascade FK, and
  each covered by `schema-invariants` for the partition key. One new
  environment variable. Two new job kinds. No new dependency in M1 (FTS5 is
  compiled into `better-sqlite3`; M2 verifies with `PRAGMA compile_options`
  before relying on it).
- **The club guild's messages do not enter the archive under this ADR.**
  The owner may enable the test guild and read its archive over MCP; the
  club guild waits for the privacy surface. This is deliberately stricter
  than the fixtures corpus, which already captures matching club messages
  under the automod ADRs — a fixture is one message that tripped a rule, an
  archive is a channel.
- The design's Q2 (interleave M1/M2 with Slices 7–9?) is moot: Slices 7–9
  are done. Q1 (send cap 10/h) and Q3 (1 h access, 30 d refresh) take their
  defaults and belong to M5 and M3; Q5 (the training opt-out) blocks M4's
  first real read, not this slice — M4's ADR 0044 turns it into a control.
- `doctor` gains two checks (D1). `PRIVACY.md` gains three rows (D3).

## Rejected

- **Enforcing the privacy precondition by refusing to start when the club
  guild is allowlisted.** The bot is already on the club guild for automod;
  the archive is the surface that needs gating, not the process.
- **A per-channel `bytes` default.** REVIEW §C1's argument is real, but on a
  test guild the ingest complexity is not worth it yet and the choice is
  reversible forward. Recorded so a future switch is a decision, not a
  drift.
- **Retention as a follow-up slice.** The design already rejects it; this
  ADR repeats the rejection because it is the one most likely to be
  re-proposed under time pressure.
